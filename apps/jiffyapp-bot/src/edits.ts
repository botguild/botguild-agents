// Thread-driven bounded edits (Task 22 / FR-14): the 15-minute sweep polls every OPEN hosting
// cycle's contract thread for buyer-posted `edit:` requests, claims each new one exactly once
// (per-thread-message idempotency), and reserves it against the cycle's included-edit quota. A
// reserved request is enqueued as an `edit` job (the pipeline's `processEditJob` does the
// re-gated re-run); an over-quota request is HELD (not silently served) with a single prompt to
// top up or wait for the next cycle. The quota counter is keyed to the funded cycle's contractId,
// NEVER a calendar month — a 30-day window straddling a month boundary must not grant a second
// batch of edits.

import { EDITS_PER_CYCLE } from './config.js';
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
        const hash = await sha256Hex(cycle.contractId);
        const jobKey = jobKeyFor(hash, `edit:${message.id}`);
        const decision = await s.jobs.claim({
          jobKey,
          contractId: cycle.contractId,
          kind: 'edit',
          toolId: cycle.toolId,
        });
        if (decision.action === 'enqueue') {
          await s.queue.send({
            kind: 'edit',
            contractId: cycle.contractId,
            jobKey,
            toolId: cycle.toolId,
            requestId: message.id,
          });
          logger.info({ requestId: message.id, jobKey }, 'edit request claimed and enqueued');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'edit-request poll failed for cycle; retrying next sweep');
    }
  }
}
