// D1 job store: idempotency claims, per-variant checkpoints, parking, and the
// gate audit log. Pure D1Like consumers — no Workers globals — so node tests
// run against @botguild/agent-core-workers/testing's in-memory SQLite.

import type { D1Like } from '@botguild/agent-core-workers';
import type { JobCheckpoint, JobKind, JobOutcome, JobStatus } from './types.js';

/** Web Crypto SHA-256 hex — the FR-13 idempotency key: hash(contractId). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A high-entropy 64-hex capability token for the deliverable URL/R2 prefix (§12).
 * NOT derived from the contract id — job_key = sha256(contractId) is a public,
 * recomputable hash, so it must not double as the secret that guards the paid
 * CSV/report. This token is stored on the job row and is unguessable.
 */
export function randomDeliverableToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface JobRow {
  jobKey: string;
  contractId: string;
  /** Unguessable capability token for the deliverable URL/R2 prefix (§12). */
  deliverableToken: string | null;
  status: JobStatus;
  outcome: JobOutcome | null;
  kind: JobKind | null;
  gigId: string | null;
  briefJson: string | null;
  parkReason: string | null;
  moderationAttempts: number;
  checkpoint: JobCheckpoint | null;
  spentUsd: number;
  batchRounds: number;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

interface RawJobRow {
  job_key: string;
  contract_id: string;
  deliverable_token: string | null;
  status: JobStatus;
  outcome: JobOutcome | null;
  kind: JobKind | null;
  gig_id: string | null;
  brief_json: string | null;
  park_reason: string | null;
  moderation_attempts: number;
  checkpoint_json: string | null;
  spent_usd: number;
  batch_rounds: number;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

function toJobRow(raw: RawJobRow): JobRow {
  return {
    jobKey: raw.job_key,
    contractId: raw.contract_id,
    deliverableToken: raw.deliverable_token,
    status: raw.status,
    outcome: raw.outcome,
    kind: raw.kind,
    gigId: raw.gig_id,
    briefJson: raw.brief_json,
    parkReason: raw.park_reason,
    moderationAttempts: raw.moderation_attempts,
    checkpoint: raw.checkpoint_json ? (JSON.parse(raw.checkpoint_json) as JobCheckpoint) : null,
    spentUsd: raw.spent_usd,
    batchRounds: raw.batch_rounds,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    deliveredAt: raw.delivered_at,
  };
}

export type ClaimDecision =
  | { action: 'enqueue'; reason: 'fresh-claim' | 'claimed-not-checkpointed' }
  | { action: 'skip'; reason: 'delivered' | 'in-progress' | 'parked' };

/**
 * Pure conflict policy (§6 step 2 / §8): claim and Queue send are not atomic,
 * so a unique-constraint conflict must not blindly 200 — re-enqueue only a job
 * that is still merely `claimed` (the claim won but the Queue send may have been
 * lost). A job at `in_progress` already reached the consumer, which means a queue
 * message is/was in flight; re-enqueuing on webhook redelivery would let a second
 * consumer invocation run the pipeline concurrently — double-spending the FR-5
 * $1.50 cap and double-calling deliverMilestone. So `in_progress` SKIPS
 * (whether or not a checkpoint exists yet — readability jobs never checkpoint,
 * and the ad-copy pre-first-batch window has none); genuinely lost sends stay
 * `claimed` and are recovered by the daily stuck-claim sweep, and a consumer that
 * dies mid-run is recovered by the queue's own message retry. Parked jobs are the
 * cron's responsibility (moderation outages must not be hammered by redeliveries).
 */
export function decideOnConflict(row: Pick<JobRow, 'status' | 'checkpoint'>): ClaimDecision {
  if (row.status === 'delivered') return { action: 'skip', reason: 'delivered' };
  if (row.status === 'parked') return { action: 'skip', reason: 'parked' };
  if (row.status === 'in_progress') return { action: 'skip', reason: 'in-progress' };
  if (row.checkpoint !== null) return { action: 'skip', reason: 'in-progress' };
  return { action: 'enqueue', reason: 'claimed-not-checkpointed' };
}

export interface JobStore {
  /** D1 INSERT claim; on unique-constraint conflict applies decideOnConflict. */
  claim(jobKey: string, contractId: string): Promise<ClaimDecision>;
  get(jobKey: string): Promise<JobRow | null>;
  setInProgress(
    jobKey: string,
    fields: { kind: JobKind; gigId: string; briefJson: string },
  ): Promise<void>;
  saveCheckpoint(jobKey: string, checkpoint: JobCheckpoint): Promise<void>;
  updateBrief(jobKey: string, briefJson: string): Promise<void>;
  park(jobKey: string, reason: string): Promise<void>;
  /** parked → claimed, clearing park_reason, ahead of a cron re-enqueue. */
  unpark(jobKey: string): Promise<void>;
  incrementModerationAttempts(jobKey: string): Promise<number>;
  markDelivered(jobKey: string, outcome: JobOutcome): Promise<void>;
  listParked(reason?: string): Promise<JobRow[]>;
  /** `claimed` jobs older than the cutoff with no checkpoint (§8 daily sweep). */
  listStuckClaims(olderThan: Date): Promise<JobRow[]>;
  recordGateAudit(entry: {
    jobKey: string;
    variantId?: string;
    gate: string;
    result: string;
    detail?: unknown;
  }): Promise<void>;
}

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

export function createJobStore(db: D1Like, now: () => Date = () => new Date()): JobStore {
  const touch = (): string => now().toISOString();

  async function get(jobKey: string): Promise<JobRow | null> {
    const raw = await db
      .prepare('SELECT * FROM jobs WHERE job_key = ?')
      .bind(jobKey)
      .first<RawJobRow>();
    return raw ? toJobRow(raw) : null;
  }

  return {
    get,

    async claim(jobKey: string, contractId: string): Promise<ClaimDecision> {
      const ts = touch();
      try {
        await db
          .prepare(
            'INSERT INTO jobs (job_key, contract_id, deliverable_token, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .bind(jobKey, contractId, randomDeliverableToken(), 'claimed', ts, ts)
          .run();
        return { action: 'enqueue', reason: 'fresh-claim' };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const row = await get(jobKey);
        if (!row) throw err; // claim raced a delete that cannot happen — surface it
        return decideOnConflict(row);
      }
    },

    async setInProgress(jobKey, fields): Promise<void> {
      await db
        .prepare(
          'UPDATE jobs SET status = ?, kind = ?, gig_id = ?, brief_json = ?, park_reason = NULL, updated_at = ? WHERE job_key = ?',
        )
        .bind('in_progress', fields.kind, fields.gigId, fields.briefJson, touch(), jobKey)
        .run();
    },

    async saveCheckpoint(jobKey, checkpoint): Promise<void> {
      await db
        .prepare(
          'UPDATE jobs SET checkpoint_json = ?, spent_usd = ?, batch_rounds = ?, updated_at = ? WHERE job_key = ?',
        )
        .bind(
          JSON.stringify(checkpoint),
          checkpoint.spendUsd,
          checkpoint.batchRounds,
          touch(),
          jobKey,
        )
        .run();
    },

    async updateBrief(jobKey, briefJson): Promise<void> {
      await db
        .prepare('UPDATE jobs SET brief_json = ?, updated_at = ? WHERE job_key = ?')
        .bind(briefJson, touch(), jobKey)
        .run();
    },

    async park(jobKey, reason): Promise<void> {
      await db
        .prepare('UPDATE jobs SET status = ?, park_reason = ?, updated_at = ? WHERE job_key = ?')
        .bind('parked', reason, touch(), jobKey)
        .run();
    },

    async unpark(jobKey): Promise<void> {
      await db
        .prepare(
          "UPDATE jobs SET status = 'claimed', park_reason = NULL, updated_at = ? WHERE job_key = ? AND status = 'parked'",
        )
        .bind(touch(), jobKey)
        .run();
    },

    async incrementModerationAttempts(jobKey): Promise<number> {
      await db
        .prepare(
          'UPDATE jobs SET moderation_attempts = moderation_attempts + 1, updated_at = ? WHERE job_key = ?',
        )
        .bind(touch(), jobKey)
        .run();
      const row = await get(jobKey);
      return row?.moderationAttempts ?? 0;
    },

    async markDelivered(jobKey, outcome): Promise<void> {
      const ts = touch();
      await db
        .prepare(
          'UPDATE jobs SET status = ?, outcome = ?, delivered_at = ?, updated_at = ? WHERE job_key = ?',
        )
        .bind('delivered', outcome, ts, ts, jobKey)
        .run();
    },

    async listParked(reason?: string): Promise<JobRow[]> {
      const query = reason
        ? db
            .prepare('SELECT * FROM jobs WHERE status = ? AND park_reason = ?')
            .bind('parked', reason)
        : db.prepare('SELECT * FROM jobs WHERE status = ?').bind('parked');
      const { results } = await query.all<RawJobRow>();
      return results.map(toJobRow);
    },

    async listStuckClaims(olderThan: Date): Promise<JobRow[]> {
      const { results } = await db
        .prepare(
          'SELECT * FROM jobs WHERE status = ? AND checkpoint_json IS NULL AND created_at < ?',
        )
        .bind('claimed', olderThan.toISOString())
        .all<RawJobRow>();
      return results.map(toJobRow);
    },

    async recordGateAudit(entry): Promise<void> {
      await db
        .prepare(
          'INSERT INTO gate_audit (job_key, variant_id, gate, result, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          entry.jobKey,
          entry.variantId ?? null,
          entry.gate,
          entry.result,
          entry.detail === undefined ? null : JSON.stringify(entry.detail),
          touch(),
        )
        .run();
    },
  };
}

// --- Reputation snapshot cache (read by /health, written by the cron) --------

export async function saveReputationSnapshot(
  db: D1Like,
  snapshot: unknown,
  now = new Date(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reputation_snapshot (id, snapshot_json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(snapshot), now.toISOString())
    .run();
}

export async function loadReputationSnapshot(db: D1Like): Promise<unknown | null> {
  const row = await db
    .prepare('SELECT snapshot_json FROM reputation_snapshot WHERE id = 1')
    .first<{ snapshot_json: string }>();
  return row ? (JSON.parse(row.snapshot_json) as unknown) : null;
}
