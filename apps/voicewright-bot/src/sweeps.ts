// Cron sweeps (§7): the 15-minute sweep replaces every timer the Node bots
// run (gig poller, negotiation poller, reputation monitor) and adds the
// parked-job re-enqueue + FR-1 brief-correction polling; the daily sweep runs
// the FR-10 refresh-due check and the §8 stuck-claim recovery.

import type { Logger } from 'pino';
import type { AgentClient, CostEstimator, Gig, Proposer } from '@botguild/agent-core';
import { scoreRelevance, shouldPropose } from '@botguild/agent-core';
import {
  refreshReputationOnce,
  runGigPollSweep,
  runNegotiationSweep,
  type D1Like,
  type D1NegotiationStore,
  type SeenStore,
} from '@botguild/agent-core-workers';
import type { ReputationSource } from '@botguild/agent-core';
import { STUCK_CLAIM_MINUTES, pricingCalc, scorerConfig } from './config.js';
import { extractBriefId, parseAdBrief, parseReadabilityBrief } from './brief.js';
import type { BriefStore } from './briefStore.js';
import type { JobStore } from './jobs.js';
import { saveReputationSnapshot } from './jobs.js';
import { findLatestCorrection, type ThreadReader } from './threads.js';
import type { JobMessage } from './types.js';

export interface QueueLike {
  // Return type is unknown so the real Queue binding (whose send resolves a
  // QueueSendResponse) satisfies this structurally.
  send(message: JobMessage): Promise<unknown>;
}

export interface SweepServices {
  db: D1Like;
  client: AgentClient;
  jobs: JobStore;
  briefs: BriefStore;
  seen: SeenStore;
  negotiationStore: D1NegotiationStore;
  reputationSource: ReputationSource;
  /** Estimator-backed proposer for paid gigs. */
  proposer: Proposer;
  /** Anchor-priced proposer (no estimator) for the FREE readability gig. */
  freeProposer: Proposer;
  costEstimator: CostEstimator;
  threadReader: ThreadReader;
  queue: QueueLike;
  botId: string;
  logger: Logger;
  now?: () => Date;
}

/**
 * Score-and-propose callback with the brief-aware wrapper around the shared
 * scorer (FR-1): incomplete briefs are skipped at proposal time so the bot
 * never wins un-intakeable work.
 */
export async function maybePropose(s: SweepServices, gig: Gig): Promise<void> {
  const description = gig.description ?? '';
  const logger = s.logger.child({ gigId: gig.id });

  const briefId = extractBriefId(description);
  if (briefId) {
    const stored = await s.briefs.get(briefId);
    if (!stored) {
      logger.info({ briefId }, 'refresh gig references unknown briefId, skipping');
      return;
    }
    const proposal = await s.proposer.generateProposal(gig);
    const { proposalId } = await s.client.submitProposal(gig.id, proposal);
    logger.info({ proposalId, briefId, cycle: stored.cycle }, 'refresh proposal submitted');
    return;
  }

  if (parseReadabilityBrief(description).ok) {
    // FREE funnel gig (Story B): priced at the $0 anchor via pricingCalc; the
    // relevance check keeps us off random paragraph-bearing gigs.
    if (scoreRelevance(gig, scorerConfig) === 0) return;
    const proposal = await s.freeProposer.generateProposal(gig);
    const { proposalId } = await s.client.submitProposal(gig.id, proposal);
    logger.info({ proposalId }, 'free readability proposal submitted');
    return;
  }

  const parsed = parseAdBrief(description);
  if (!parsed.ok) {
    logger.info({ errors: parsed.errors.length }, 'gig brief missing/incomplete, skipped at proposal time');
    return;
  }
  if (!shouldPropose(gig, scorerConfig)) return;
  const proposal = await s.proposer.generateProposal(gig);
  const { proposalId } = await s.client.submitProposal(gig.id, proposal);
  logger.info({ proposalId }, 'proposal submitted');
}

/** Poll parked-with-invalid-brief jobs' threads for a corrected brief (FR-1). */
async function pollBriefCorrections(s: SweepServices): Promise<void> {
  const parked = await s.jobs.listParked('brief_invalid');
  for (const job of parked) {
    const logger = s.logger.child({ contractId: job.contractId, jobKey: job.jobKey });
    try {
      const messages = await s.threadReader.fetchContractMessages(job.contractId);
      const corrected = findLatestCorrection(messages, s.botId, (content) => parseAdBrief(content));
      if (!corrected) continue;
      await s.jobs.updateBrief(job.jobKey, JSON.stringify(corrected));
      await s.jobs.unpark(job.jobKey);
      await s.queue.send({ contractId: job.contractId, jobKey: job.jobKey });
      logger.info('corrected brief found in thread, job re-enqueued');
    } catch (err) {
      logger.warn({ err }, 'brief-correction poll failed for job; retrying next sweep');
    }
  }
}

/** Re-enqueue jobs parked by a moderation outage (FR-2). */
async function reenqueueParked(s: SweepServices): Promise<void> {
  const parked = await s.jobs.listParked('moderation_outage');
  for (const job of parked) {
    await s.jobs.unpark(job.jobKey);
    await s.queue.send({ contractId: job.contractId, jobKey: job.jobKey });
    s.logger.info({ jobKey: job.jobKey, contractId: job.contractId }, 'parked job re-enqueued');
  }
}

/** The 15-minute cron sweep. Every step is awaited — nothing here is fire-and-forget safe. */
export async function runFifteenMinuteSweep(s: SweepServices): Promise<void> {
  await runGigPollSweep({
    client: s.client,
    seen: s.seen,
    onGig: (gig) => maybePropose(s, gig),
    logger: s.logger,
  });

  await runNegotiationSweep({
    client: s.client,
    pricingCalc,
    costEstimator: s.costEstimator,
    store: s.negotiationStore,
    logger: s.logger,
  });

  await reenqueueParked(s);
  await pollBriefCorrections(s);

  const snapshot = await refreshReputationOnce({ source: s.reputationSource, logger: s.logger });
  if (snapshot) {
    await saveReputationSnapshot(s.db, snapshot, s.now?.() ?? new Date());
  }
}

/** The daily (06:00 UTC) sweep: FR-10 refresh-due check + §8 stuck-claim recovery. */
export async function runDailySweep(s: SweepServices): Promise<void> {
  const now = s.now?.() ?? new Date();

  // Claimed >30 min with no checkpoint: the claim won but the Queue send was
  // lost — re-enqueue so a paid job can never stall silently (§12).
  const cutoff = new Date(now.getTime() - STUCK_CLAIM_MINUTES * 60 * 1000);
  for (const job of await s.jobs.listStuckClaims(cutoff)) {
    await s.queue.send({ contractId: job.contractId, jobKey: job.jobKey });
    s.logger.warn({ jobKey: job.jobKey, contractId: job.contractId }, 'stuck claim re-enqueued');
  }

  // Refresh-due nudges: the platform has no subscriptions, so each cycle is a
  // re-funded gig — the nudge makes re-funding one click (FR-10). Work starts
  // only when that cycle's gig reaches milestone.funded.
  for (const stored of await s.briefs.listDue(now)) {
    const logger = s.logger.child({ contractId: stored.originContractId });
    try {
      await s.client.sendMessage(
        stored.originContractId,
        `Your monthly creative refresh (cycle ${stored.cycle}) is due. Post a new $50 refresh gig whose description ` +
          `includes \`briefId: ${stored.briefId}\`, fund it, and I will generate a fresh batch from your stored brief — ` +
          `deterministically verified to differ from last cycle's variants.`,
      );
      await s.briefs.markNudged(stored.briefId, stored.cycle);
      logger.info({ briefId: stored.briefId, cycle: stored.cycle }, 'refresh-due nudge sent');
    } catch (err) {
      logger.warn({ err, briefId: stored.briefId }, 'refresh nudge failed; retrying next daily sweep');
    }
  }
}
