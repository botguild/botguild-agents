// ---------------------------------------------------------------------------
// Cron sweeps (§7/§10) — Workers have no timers, so each Cron Trigger drives one
// sweep per invocation:
//   */10  poll + negotiation + reputation refresh (shim sweeps).
//   0 4   daily usage rollover reconciliation + stuck-claim recovery (§8).
//   0 3 1 monthly recurring-gig re-post: usage report + re-fund prompt (§10.7).
// Every step is awaited — nothing here is fire-and-forget safe inside a cron.
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import type { AgentClient, CostEstimator, Gig, Proposer, ReputationSource } from '@botguild/agent-core';
import { shouldPropose } from '@botguild/agent-core';
import {
  refreshReputationOnce,
  runGigPollSweep,
  runNegotiationSweep,
  type D1Like,
  type D1NegotiationStore,
  type SeenStore,
} from '@botguild/agent-core-workers';
import { AUDIT_RETENTION_DAYS, STUCK_CLAIM_MINUTES, pricingCalc, scorerConfig } from './config.js';
import { usagePeriod } from './usage.js';
import {
  saveReputationSnapshot,
  type AuditStore,
  type IdempotencyStore,
  type OfferStore,
  type RenderJobStore,
  type UsageStore,
} from './jobs.js';
import type { RenderMessage, RenderQueueLike } from './pipeline.js';

export interface SweepServices {
  db: D1Like;
  client: AgentClient;
  renderJobs: RenderJobStore;
  offers: OfferStore;
  usage: UsageStore;
  idempotency: IdempotencyStore;
  audit: AuditStore;
  seen: SeenStore;
  negotiationStore: D1NegotiationStore;
  reputationSource: ReputationSource;
  proposer: Proposer;
  costEstimator: CostEstimator;
  queue: RenderQueueLike;
  logger: Logger;
  now?: () => Date;
}

/** Score a discovered gig and submit a Claude-written proposal when it clears the bar. */
export async function maybePropose(s: SweepServices, gig: Gig): Promise<void> {
  const logger = s.logger.child({ gigId: gig.id });
  if (!shouldPropose(gig, scorerConfig)) return;
  const proposal = await s.proposer.generateProposal(gig);
  const { proposalId } = await s.client.submitProposal(gig.id, proposal);
  logger.info({ proposalId }, 'proposal submitted');
}

/** The ten-minute poll sweep: gig poll + proposals, negotiation, reputation refresh. */
export async function runPollSweep(s: SweepServices): Promise<void> {
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

  const snapshot = await refreshReputationOnce({ source: s.reputationSource, logger: s.logger });
  if (snapshot) {
    await saveReputationSnapshot(s.db, snapshot, s.now?.() ?? new Date());
  }
}

/** The daily sweep: usage-rollover reconciliation + §8 stuck-claim recovery. */
export async function runDailySweep(s: SweepServices): Promise<void> {
  const now = s.now?.() ?? new Date();

  // Stuck render jobs: claimed with no plan (the claim won but the fan-out was
  // lost) — re-enqueue the plan message so a paid job never stalls silently.
  const cutoff = new Date(now.getTime() - STUCK_CLAIM_MINUTES * 60 * 1000);
  for (const job of await s.renderJobs.listStuckClaims(cutoff)) {
    const message: RenderMessage = { kind: 'plan', contractId: job.contractId, jobKey: job.jobKey };
    await s.queue.send(message);
    s.logger.warn({ jobKey: job.jobKey, contractId: job.contractId }, 'stuck render claim re-enqueued');
  }

  // Usage rollover is implicit (the period key is YYYY-MM); prune stale pending
  // idempotency claims from failed first attempts so the table stays clean.
  const pruned = await s.idempotency.sweepStalePending(cutoff);

  // Bounded retention for the gate audit log — the fastest-growing table (a row
  // per gate per graphic/publish). Keep a rolling window; nothing else prunes it.
  const auditCutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const prunedAudit = await s.audit.pruneOlderThan(auditCutoff);
  s.logger.info(
    { period: usagePeriod(now), prunedStalePending: pruned, prunedAudit },
    'daily rollover + reconciliation complete',
  );
}

/** The monthly sweep: prompt each armed OG offer to re-fund the next cycle (§10.7). */
export async function runMonthlySweep(s: SweepServices): Promise<void> {
  const now = s.now?.() ?? new Date();
  for (const offer of await s.offers.list()) {
    const logger = s.logger.child({ offerId: offer.offerId, contractId: offer.contractId });
    try {
      const used = await s.usage.getUsed(offer.offerId, usagePeriod(now));
      await s.client.sendMessage(
        offer.contractId,
        `Monthly usage report for your OG automation offer: ${used} image(s) rendered this cycle (cap ${offer.cap}). ` +
          'The platform has no subscription primitive, so to continue next month post a new fixed-price monthly ThumbForge ' +
          'OG repeat gig and fund it — your signed webhook route stays armed and one image is rendered per published page version.',
      );
      logger.info({ used, cap: offer.cap }, 'monthly recurring re-post prompt sent');
    } catch (err) {
      logger.warn({ err }, 'monthly re-post prompt failed; retrying next month');
    }
  }
}
