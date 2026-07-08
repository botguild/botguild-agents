// Thread-driven bounded edits (Task 22 / FR-14): the 15-minute sweep polls every OPEN hosting
// cycle's contract thread for buyer-posted `edit:` requests, claims each new one exactly once
// (per-thread-message idempotency), and reserves it against the cycle's included-edit quota. A
// reserved request is enqueued as an `edit` job (the pipeline's `processEditJob` does the
// re-gated re-run); an over-quota request is HELD (not silently served) with a single prompt to
// top up or wait for the next cycle. The quota counter is keyed to the funded cycle's contractId,
// NEVER a calendar month — a 30-day window straddling a month boundary must not grant a second
// batch of edits.

import { EDITS_PER_CYCLE, ORPHAN_EDIT_CLAIM_MINUTES } from './config.js';
import { jobKeyFor, sha256Hex } from './jobs.js';
import type { SweepServices } from './sweeps.js';

const EDIT_HELD_MESSAGE =
  `This cycle's ${EDITS_PER_CYCLE} included edits are already used, so this request is HELD — ` +
  'not silently served. Post a top-up hosting gig to fund another batch, or it queues for your ' +
  'next cycle.';

/**
 * Parse a thread message as an edit request: a leading `edit:` (case-insensitive, optional
 * whitespace around the colon) followed by a non-empty instruction. Returns the trimmed
 * instruction, or `null` when the message is not an edit request (or has an empty remainder).
 */
export function parseEditInstruction(content: string): string | null {
  const match = /^\s*edit\s*:/i.exec(content);
  if (!match) return null;
  const remainder = content.slice(match[0].length).trim();
  return remainder.length > 0 ? remainder : null;
}

/**
 * Poll every open hosting cycle's thread for new `edit:` requests (per-cycle try/catch so one
 * bad thread never stops the rest). For each new non-bot request, oldest→newest:
 *  - `edits.claim` (false ⇒ already seen, skip);
 *  - reserve against `usage` scope `edit:<toolId>`, period = the cycle's contractId;
 *  - reserved ⇒ record the quota ref on the request row, claim + enqueue an `edit` job;
 *  - not reserved ⇒ mark the request `held` and post ONE hold-and-prompt reply.
 */
export async function pollEditRequests(s: SweepServices): Promise<void> {
  const now = s.now ?? ((): Date => new Date());
  const openCycles = await s.cycles.listOpen(now());

  for (const cycle of openCycles) {
    const logger = s.logger.child({ contractId: cycle.contractId, toolId: cycle.toolId });
    try {
      const messages = await s.threadReader.fetchContractMessages(cycle.contractId);
      for (const message of messages) {
        // VoiceWright rule: never mistake this bot's own posts (the cycle confirmation itself
        // names "edit:") for a buyer request.
        if (message.botId === s.botId) continue;
        const instruction = parseEditInstruction(message.content ?? '');
        if (instruction === null) continue;

        const claimed = await s.edits.claim({
          requestId: message.id,
          toolId: cycle.toolId,
          contractId: cycle.contractId,
          instruction,
        });
        if (!claimed) continue; // already claimed on a prior sweep — no duplicate.

        // Quota period is the funded cycle's contractId, NEVER a calendar month.
        const scope = `edit:${cycle.toolId}`;
        const period = cycle.contractId;
        const reservation = await s.usage.reserve(scope, period, EDITS_PER_CYCLE);
        if (!reservation.reserved) {
          await s.edits.setStatus(message.id, 'held');
          await s.client.sendMessage(cycle.contractId, EDIT_HELD_MESSAGE);
          logger.info({ requestId: message.id }, 'edit request held — cycle quota exhausted');
          continue;
        }

        // Persist the reserved (scope, period) on the request row so a failed edit releases the
        // exact row it reserved, even across cycle/month boundaries.
        await s.edits.setQuotaRef(message.id, scope, period);
        await claimAndEnqueueEdit(s, {
          contractId: cycle.contractId,
          toolId: cycle.toolId,
          requestId: message.id,
          logger,
        });
      }

      // Backstop: re-drive any of this tool's edit requests stuck in 'claimed' with no job row
      // (a crash between claim/reserve and queue.send). Without this a buyer's edit stalls
      // forever and — if it had already reserved — its quota slot leaks for the whole cycle.
      await reconcileOrphanedClaims(s, cycle, now());
    } catch (err) {
      logger.warn({ err }, 'edit-request poll failed for cycle; retrying next sweep');
    }
  }
}

/** Claim the edit job (idempotent) and enqueue it exactly once. Shared by the main message loop
 *  and the orphan backstop, so both agree on the jobKey scheme and the enqueue-once guard. */
async function claimAndEnqueueEdit(
  s: SweepServices,
  args: { contractId: string; toolId: string; requestId: string; logger: SweepServices['logger'] },
): Promise<void> {
  const hash = await sha256Hex(args.contractId);
  const jobKey = jobKeyFor(hash, `edit:${args.requestId}`);
  const decision = await s.jobs.claim({
    jobKey,
    contractId: args.contractId,
    kind: 'edit',
    toolId: args.toolId,
  });
  if (decision.action === 'enqueue') {
    await s.queue.send({
      kind: 'edit',
      contractId: args.contractId,
      jobKey,
      toolId: args.toolId,
      requestId: args.requestId,
    });
    args.logger.info({ requestId: args.requestId, jobKey }, 'edit request claimed and enqueued');
  }
}

/**
 * Reconcile edit requests still 'claimed' for this cycle's tool past ORPHAN_EDIT_CLAIM_MINUTES
 * that have NO corresponding job row. For each: if the reservation never landed (quotaRef null),
 * reserve it now (idempotent — only when null) and record the ref; then claim + enqueue the edit
 * job (idempotent via the job claim). A request whose contract still can't reserve is held.
 */
async function reconcileOrphanedClaims(
  s: SweepServices,
  cycle: { contractId: string; toolId: string },
  now: Date,
): Promise<void> {
  const logger = s.logger.child({ contractId: cycle.contractId, toolId: cycle.toolId });
  const cutoff = new Date(now.getTime() - ORPHAN_EDIT_CLAIM_MINUTES * 60_000).toISOString();
  const orphans = await s.edits.listClaimedOlderThan(cycle.toolId, cutoff);

  for (const orphan of orphans) {
    const hash = await sha256Hex(orphan.contractId);
    const jobKey = jobKeyFor(hash, `edit:${orphan.requestId}`);
    // A job row already exists ⇒ not orphaned (it's queued/in-flight); leave it alone.
    if ((await s.jobs.get(jobKey)) !== null) continue;

    // Reserve only when the request never recorded a quota ref (idempotent guard) — a request
    // that already reserved keeps its slot and is simply re-enqueued below.
    if (orphan.quotaScope === null || orphan.quotaPeriod === null) {
      const scope = `edit:${cycle.toolId}`;
      const period = orphan.contractId;
      const reservation = await s.usage.reserve(scope, period, EDITS_PER_CYCLE);
      if (!reservation.reserved) {
        await s.edits.setStatus(orphan.requestId, 'held');
        await s.client.sendMessage(orphan.contractId, EDIT_HELD_MESSAGE);
        logger.info({ requestId: orphan.requestId }, 'orphaned edit held — cycle quota exhausted');
        continue;
      }
      await s.edits.setQuotaRef(orphan.requestId, scope, period);
    }

    await claimAndEnqueueEdit(s, {
      contractId: orphan.contractId,
      toolId: cycle.toolId,
      requestId: orphan.requestId,
      logger,
    });
    logger.info({ requestId: orphan.requestId }, 'orphaned edit claim re-driven');
  }
}
