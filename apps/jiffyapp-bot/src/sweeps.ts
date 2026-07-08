// Cron sweeps (Tasks 20/21/22): Workers have no timers, so each Cron Trigger drives one
// sweep per invocation. The 15-minute sweep replaces every timer the Node bots would run
// (gig poller, negotiation poller, reputation monitor) and adds the parked-job re-enqueue +
// FR-1-style brief-correction polling this bot needs on top; the daily sweep (Task 21) will
// add the hosting-cycle refresh/report checks + §8 stuck-claim recovery, and edit-request
// polling (Task 22) replaces the `pollEditRequests` stub. Every step here is awaited, and
// each of the seven 15-minute steps is wrapped in its own try/catch — one step's failure
// (a transient API outage, a bad row) must never stop the rest of the sweep from running.

import type { Logger } from 'pino';
import type { AgentClient, CostEstimator, Gig, ReputationSource } from '@botguild/agent-core';
import { shouldPropose } from '@botguild/agent-core';
import {
  refreshReputationOnce,
  runGigPollSweep,
  runNegotiationSweep,
  type D1Like,
  type D1NegotiationStore,
  type SeenStore,
} from '@botguild/agent-core-workers';
import {
  BUILD_LOG_RETENTION_DAYS,
  RELAY_METADATA_RETENTION_DAYS,
  STUCK_CLAIM_MINUTES,
  scorerConfig,
} from './config.js';
import { parseJiffyBrief } from './brief.js';
import { pollEditRequests } from './edits.js';
import { classifyGig, createJiffyProposer, pricingCalcWithClassifier } from './proposer.js';
import { findLatestCorrection, type ThreadReader } from './threads.js';
import { saveReputationSnapshot } from './jobs.js';
import { deliverCycleReports, sweepHostingExpiry } from './hosting.js';
import type {
  AuditStore,
  BuildLogStore,
  CycleStore,
  EditRequestStore,
  JobStore,
  RelayStore,
  ToolStore,
  UsageStore,
} from './jobs.js';
import type { GigStore } from './gigStore.js';
import type { QueueLike } from './pipeline.js';
import type { EmailRoutingClient } from './relay.js';
import type { JobMessage } from './types.js';

export interface SweepServices {
  db: D1Like;
  client: AgentClient;
  jobs: JobStore;
  tools: ToolStore;
  cycles: CycleStore;
  gigs: GigStore;
  edits: EditRequestStore;
  usage: UsageStore;
  relay: RelayStore;
  buildLog: BuildLogStore;
  audit: AuditStore;
  seen: SeenStore;
  negotiationStore: D1NegotiationStore;
  reputationSource: ReputationSource;
  proposer: ReturnType<typeof createJiffyProposer>;
  costEstimator: CostEstimator;
  threadReader: ThreadReader;
  queue: QueueLike;
  emailRouting: EmailRoutingClient;
  /** ALL ad-hoc HTTP (cycle-report reachability spot-checks, Task 21) — never global fetch. */
  fetchImpl: typeof fetch;
  botId: string;
  publicBaseUrl: string;
  toolHostSuffix: string;
  logger: Logger;
  now?: () => Date;
}

/** Rebuild the queue message a parked job's row would have carried at claim time. For an edit
 *  job the requestId is recovered from the job key itself (`<hash>:edit:<requestId>`), since the
 *  jobs table doesn't store it separately but `processEditJob` needs it to load the request row. */
function toJobMessage(job: {
  kind: JobMessage['kind'];
  contractId: string;
  jobKey: string;
  toolId: string | null;
}): JobMessage {
  const base: JobMessage = {
    kind: job.kind,
    contractId: job.contractId,
    jobKey: job.jobKey,
    toolId: job.toolId ?? undefined,
  };
  if (job.kind === 'edit') {
    const marker = ':edit:';
    const at = job.jobKey.indexOf(marker);
    if (at >= 0) base.requestId = job.jobKey.slice(at + marker.length);
  }
  return base;
}

/**
 * Score-and-propose callback for a freshly-discovered gig (§15 KPI): classify it, then
 * dispatch to the cycle/build path, or — for a gig that scored well enough that the bot
 * WOULD have bid (`shouldPropose`) but got skipped anyway — record the off-catalog-skip
 * audit row so the operator can see every near-miss, segmented by skip reason. The KPI
 * wants EVERY scored skip on a gig the scorer would have bid on: off-catalog (a fenced
 * brief that named no matching template), no-brief (a prose gig with no fenced JSON at
 * all that still didn't keyword-match any template), and incomplete-brief* (matched a
 * template but failed its required-field check) all count. `invalid-template` is the one
 * exception — an explicitly-wrong `brief.template` value is buyer error noise, not catalog
 * demand, so it's never audited. A gig that scores too low to ever bid on returns silently
 * regardless of reason.
 */
export async function maybePropose(s: SweepServices, gig: Gig): Promise<void> {
  const logger = s.logger.child({ gigId: gig.id });
  const c = classifyGig(gig);

  if (c.kind === 'skip') {
    const isScoredSkipReason =
      c.reason === 'off-catalog' ||
      c.reason === 'no-brief' ||
      c.reason.startsWith('incomplete-brief');
    if (isScoredSkipReason && shouldPropose(gig, scorerConfig)) {
      await s.audit.record({ scope: `gig:${gig.id}`, gate: 'off-catalog-skip', result: c.reason });
      logger.info(
        { reason: c.reason },
        'gig scored well but was skipped as off-catalog/no-brief/incomplete',
      );
    }
    return;
  }

  if (c.kind === 'cycle') {
    const tool = await s.tools.get(c.toolId);
    if (!tool) {
      await s.audit.record({ scope: `gig:${gig.id}`, gate: 'unknown-toolId', result: c.toolId });
      logger.info({ toolId: c.toolId }, 'cycle gig references an unknown toolId; skipping');
      return;
    }
    const draft = await s.proposer.proposeCycle(gig, c);
    const { proposalId } = await s.client.submitProposal(gig.id, draft);
    logger.info({ proposalId, toolId: c.toolId }, 'cycle proposal submitted');
    return;
  }

  // c.kind === 'build'
  if (!shouldPropose(gig, scorerConfig)) return;
  const draft = await s.proposer.proposeBuild(gig, c);
  if (!draft) return; // golden compiler couldn't produce a valid set; already logged inside
  const { proposalId } = await s.client.submitProposal(gig.id, draft);
  logger.info({ proposalId, templateId: c.templateId }, 'build proposal submitted');
}

/** Re-enqueue jobs parked by a moderation-vendor or PSI outage: both are transient
 *  fail-closed parks with nothing left to check but "has the sweep come back around". */
async function reenqueueParked(s: SweepServices): Promise<void> {
  for (const reason of ['moderation_outage', 'psi_outage'] as const) {
    const parked = await s.jobs.listParked(reason);
    for (const job of parked) {
      await s.jobs.unpark(job.jobKey);
      await s.queue.send(toJobMessage(job));
      s.logger.info(
        { jobKey: job.jobKey, contractId: job.contractId, reason },
        'parked job re-enqueued',
      );
    }
  }
}

/** Re-enqueue relay-family build jobs parked awaiting the double opt-in (FR-8/Task 17 stage 4):
 *  only once BOTH sides have confirmed — our own token flip (`relay.verified`) AND Cloudflare
 *  Email Routing's independent destination-address verification. Either alone leaves it parked. */
async function reenqueueVerified(s: SweepServices): Promise<void> {
  const parked = await s.jobs.listParked('awaiting_verification');
  for (const job of parked) {
    const logger = s.logger.child({ jobKey: job.jobKey, contractId: job.contractId });
    try {
      const tool = await s.tools.getByBuildContract(job.contractId);
      if (!tool) {
        logger.warn('awaiting_verification job has no tools row; leaving parked');
        continue;
      }
      const relay = await s.relay.get(tool.toolId);
      if (!relay) continue;
      const bothVerified =
        relay.verified && (await s.emailRouting.isDestinationVerified(relay.recipient));
      if (!bothVerified) continue;
      await s.jobs.unpark(job.jobKey);
      await s.queue.send(toJobMessage(job));
      logger.info(
        { toolId: tool.toolId },
        'relay destination verified on both sides; job re-enqueued',
      );
    } catch (err) {
      logger.warn({ err }, 'relay-verification poll failed for job; retrying next sweep');
    }
  }
}

/** Poll parked-with-invalid-brief jobs' contract threads for a corrected brief (VoiceWright
 *  FR-1 pattern): a buyer reply that parses cleanly replaces the stored brief and resumes
 *  the build. Messages from this bot itself are never mistaken for a correction. */
async function pollBriefCorrections(s: SweepServices): Promise<void> {
  const parked = await s.jobs.listParked('brief_invalid');
  for (const job of parked) {
    const logger = s.logger.child({ jobKey: job.jobKey, contractId: job.contractId });
    try {
      const messages = await s.threadReader.fetchContractMessages(job.contractId);
      const corrected = findLatestCorrection(messages, s.botId, (content) =>
        parseJiffyBrief(content),
      );
      if (!corrected) continue;
      await s.jobs.updateBrief(job.jobKey, JSON.stringify(corrected));
      await s.jobs.unpark(job.jobKey);
      await s.queue.send(toJobMessage(job));
      logger.info('corrected brief found in thread, job re-enqueued');
    } catch (err) {
      logger.warn({ err }, 'brief-correction poll failed for job; retrying next sweep');
    }
  }
}

/** The 15-minute cron sweep. Every step is awaited and isolated in its own try/catch: a
 *  failure in one (a transient platform outage, a bad row) is logged and the rest still run —
 *  in particular the reputation refresh (step 7) must land even if gig discovery (step 1)
 *  blew up. */
export async function runFifteenMinuteSweep(s: SweepServices): Promise<void> {
  try {
    await runGigPollSweep({
      client: s.client,
      seen: s.seen,
      onGig: (gig) => maybePropose(s, gig),
      logger: s.logger,
    });
  } catch (err) {
    s.logger.error({ err }, 'sweep: gig poll/propose step failed; continuing');
  }

  try {
    await runNegotiationSweep({
      client: s.client,
      pricingCalc: pricingCalcWithClassifier,
      costEstimator: s.costEstimator,
      store: s.negotiationStore,
      logger: s.logger,
    });
  } catch (err) {
    s.logger.error({ err }, 'sweep: negotiation step failed; continuing');
  }

  try {
    await reenqueueParked(s);
  } catch (err) {
    s.logger.error({ err }, 'sweep: reenqueue-parked step failed; continuing');
  }

  try {
    await reenqueueVerified(s);
  } catch (err) {
    s.logger.error({ err }, 'sweep: reenqueue-verified step failed; continuing');
  }

  try {
    await pollBriefCorrections(s);
  } catch (err) {
    s.logger.error({ err }, 'sweep: brief-correction step failed; continuing');
  }

  try {
    await pollEditRequests(s);
  } catch (err) {
    s.logger.error({ err }, 'sweep: edit-request step failed; continuing');
  }

  try {
    const snapshot = await refreshReputationOnce({ source: s.reputationSource, logger: s.logger });
    if (snapshot) {
      await saveReputationSnapshot(s.db, snapshot, s.now ?? ((): Date => new Date()));
    }
  } catch (err) {
    s.logger.error({ err }, 'sweep: reputation-refresh step failed; continuing');
  }
}

/** The daily (06:00 UTC) sweep (Task 21): hosting expiry/grace/suspend, month-end service
 *  reports, §8 stuck-claim recovery, and the 30/90-day retention prunes. Every step is
 *  isolated in its own try/catch — one step's failure must never stop the rest from running. */
export async function runDailySweep(s: SweepServices): Promise<void> {
  const now = s.now ?? ((): Date => new Date());

  try {
    await sweepHostingExpiry(s);
  } catch (err) {
    s.logger.error({ err }, 'daily sweep: hosting-expiry step failed; continuing');
  }

  try {
    await deliverCycleReports(s);
  } catch (err) {
    s.logger.error({ err }, 'daily sweep: cycle-report step failed; continuing');
  }

  try {
    const cutoff = new Date(now().getTime() - STUCK_CLAIM_MINUTES * 60_000);
    const stuck = await s.jobs.listStuckClaims(cutoff);
    for (const job of stuck) {
      await s.queue.send(toJobMessage(job));
      s.logger.info(
        { jobKey: job.jobKey, contractId: job.contractId },
        'daily sweep: stuck claim re-enqueued',
      );
    }
  } catch (err) {
    s.logger.error({ err }, 'daily sweep: stuck-claim recovery step failed; continuing');
  }

  try {
    await s.relay.pruneEvents(
      new Date(now().getTime() - RELAY_METADATA_RETENTION_DAYS * 86_400_000),
    );
  } catch (err) {
    s.logger.error({ err }, 'daily sweep: relay-events prune step failed; continuing');
  }

  try {
    await s.buildLog.prune(new Date(now().getTime() - BUILD_LOG_RETENTION_DAYS * 86_400_000));
  } catch (err) {
    s.logger.error({ err }, 'daily sweep: build-log prune step failed; continuing');
  }

  try {
    await s.audit.prune(new Date(now().getTime() - BUILD_LOG_RETENTION_DAYS * 86_400_000));
  } catch (err) {
    s.logger.error({ err }, 'daily sweep: gate-audit prune step failed; continuing');
  }
}
