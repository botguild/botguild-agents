// D1 stores: per-stage idempotency claims, resumable checkpoints, the concept
// table, the selection state machine, and the free-gig quota. Pure D1Like
// consumers — no Workers globals beyond WebCrypto — so node tests run against
// @botguild/agent-core-workers/testing's in-memory SQLite.

import type { D1Like } from '@botguild/agent-core-workers';
import type {
  JobCheckpoint,
  JobKind,
  JobOutcome,
  JobStage,
  JobStatus,
  SelectionSource,
} from './types.js';

/** Web Crypto SHA-256 hex. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The FR-15 claim key. Stage-suffixed because one contract runs two stages and
 * the `milestone.funded` payload carries no milestone id: stage 1 is triggered
 * by funding, stage 2 by selection/acceptance, and they must claim separately.
 */
export async function buildJobKey(contractId: string, stage: JobStage): Promise<string> {
  return `${await sha256Hex(contractId)}:${stage}`;
}

/**
 * A high-entropy 64-hex capability token for deliverable URLs and the progress
 * page (§12). NOT derived from the contract id — the job key is a public,
 * recomputable hash and must never double as the secret guarding paid artifacts.
 */
export function randomDeliverableToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface JobRow {
  jobKey: string;
  contractId: string;
  stage: JobStage;
  deliverableToken: string | null;
  status: JobStatus;
  outcome: JobOutcome | null;
  kind: JobKind | null;
  gigId: string | null;
  payerId: string | null;
  briefJson: string | null;
  parkReason: string | null;
  /**
   * When this job FIRST parked and has not reached a terminal state since — the
   * only clock that measures "how long has this been failing". Set by `park()`
   * when still null, cleared by `markDelivered()`. Meaningful only while
   * `status === 'parked'`; see migrations/0002_parked_since.sql.
   */
  parkedSince: string | null;
  moderationAttempts: number;
  checkpoint: JobCheckpoint | null;
  spentUsd: number;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

interface RawJobRow {
  job_key: string;
  contract_id: string;
  stage: JobStage;
  deliverable_token: string | null;
  status: JobStatus;
  outcome: JobOutcome | null;
  kind: JobKind | null;
  gig_id: string | null;
  payer_id: string | null;
  brief_json: string | null;
  park_reason: string | null;
  parked_since: string | null;
  moderation_attempts: number;
  checkpoint_json: string | null;
  spent_usd: number;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

const toJobRow = (raw: RawJobRow): JobRow => ({
  jobKey: raw.job_key,
  contractId: raw.contract_id,
  stage: raw.stage,
  deliverableToken: raw.deliverable_token,
  status: raw.status,
  outcome: raw.outcome,
  kind: raw.kind,
  gigId: raw.gig_id,
  payerId: raw.payer_id,
  briefJson: raw.brief_json,
  parkReason: raw.park_reason,
  parkedSince: raw.parked_since,
  moderationAttempts: raw.moderation_attempts,
  checkpoint: raw.checkpoint_json ? (JSON.parse(raw.checkpoint_json) as JobCheckpoint) : null,
  spentUsd: raw.spent_usd,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
  deliveredAt: raw.delivered_at,
});

export type ClaimDecision =
  | { action: 'enqueue'; reason: 'fresh-claim' | 'claimed-not-checkpointed' }
  | { action: 'skip'; reason: 'delivered' | 'in-progress' | 'parked' };

/**
 * Pure conflict policy (FR-15). Claim and Queue send are not atomic, so a
 * unique-constraint conflict must not blindly 200: re-enqueue only a job still
 * merely `claimed` (the claim won but the send may have been lost). A job at
 * `in_progress` already reached the consumer, so re-enqueueing on a webhook
 * redelivery would run a second pipeline concurrently — double-spending the
 * FR-5 $2.50 cap and double-calling deliverMilestone. Genuinely lost sends stay
 * `claimed` and are recovered by the daily stuck-claim sweep; a consumer that
 * dies mid-run is recovered by the queue's own retry. Parked jobs belong to the
 * cron (vendor outages must not be hammered by redeliveries).
 */
export function decideOnConflict(row: Pick<JobRow, 'status' | 'checkpoint'>): ClaimDecision {
  if (row.status === 'delivered') return { action: 'skip', reason: 'delivered' };
  if (row.status === 'parked') return { action: 'skip', reason: 'parked' };
  if (row.status === 'in_progress') return { action: 'skip', reason: 'in-progress' };
  if (row.checkpoint !== null) return { action: 'skip', reason: 'in-progress' };
  return { action: 'enqueue', reason: 'claimed-not-checkpointed' };
}

/**
 * One row of the FR-17 audit trail, read back. `detail` is the parsed
 * `detail_json` a `recordGateAudit` call wrote — an OCR verdict, a moderation
 * verdict, a pack gate report — so the store hands back the object that was
 * stored rather than a string every caller has to re-parse.
 */
export interface GateAuditRow {
  id: number;
  jobKey: string;
  contractId: string | null;
  slot: number | null;
  gate: string;
  result: string;
  detail: unknown;
  createdAt: string;
}

export interface JobStore {
  claim(jobKey: string, contractId: string, stage: JobStage): Promise<ClaimDecision>;
  get(jobKey: string): Promise<JobRow | null>;
  getByToken(token: string): Promise<JobRow | null>;
  setInProgress(
    jobKey: string,
    fields: { kind: JobKind; gigId: string; payerId: string; briefJson: string },
  ): Promise<void>;
  saveCheckpoint(jobKey: string, checkpoint: JobCheckpoint): Promise<void>;
  park(jobKey: string, reason: string): Promise<void>;
  unpark(jobKey: string): Promise<void>;
  incrementModerationAttempts(jobKey: string): Promise<number>;
  markDelivered(jobKey: string, outcome: JobOutcome): Promise<void>;
  listParked(reason?: string): Promise<JobRow[]>;
  listStuckClaims(olderThan: Date): Promise<JobRow[]>;
  recordGateAudit(entry: {
    jobKey: string;
    contractId?: string;
    slot?: number;
    gate: string;
    result: string;
    detail?: unknown;
  }): Promise<void>;
  /**
   * The audit trail for one job, oldest first, optionally narrowed to a single
   * gate (FR-17). Read-only: the delivered validation report and license
   * manifest are "generated from these records", so the records have to be
   * readable by the code that generates them — a verdict the customer holding
   * the report cannot see is not evidence to them.
   */
  listGateAudit(jobKey: string, gate?: string): Promise<GateAuditRow[]>;
}

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

interface RawGateAuditRow {
  id: number;
  job_key: string;
  contract_id: string | null;
  slot: number | null;
  gate: string;
  result: string;
  detail_json: string | null;
  created_at: string;
}

/**
 * `detail_json` is written by `recordGateAudit`'s own `JSON.stringify`, so a
 * parse failure means the row was corrupted after the fact. Degrade to null
 * rather than throw: one damaged audit row must not take down the report build
 * that the rest of the trail is still perfectly good evidence for.
 */
function parseAuditDetail(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

const toGateAuditRow = (raw: RawGateAuditRow): GateAuditRow => ({
  id: raw.id,
  jobKey: raw.job_key,
  contractId: raw.contract_id,
  slot: raw.slot,
  gate: raw.gate,
  result: raw.result,
  detail: parseAuditDetail(raw.detail_json),
  createdAt: raw.created_at,
});

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

    async getByToken(token) {
      if (!/^[0-9a-f]{64}$/.test(token)) return null;
      const raw = await db
        .prepare('SELECT * FROM jobs WHERE deliverable_token = ?')
        .bind(token)
        .first<RawJobRow>();
      return raw ? toJobRow(raw) : null;
    },

    async claim(jobKey, contractId, stage) {
      const ts = touch();
      try {
        await db
          .prepare(
            'INSERT INTO jobs (job_key, contract_id, stage, deliverable_token, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(jobKey, contractId, stage, randomDeliverableToken(), 'claimed', ts, ts)
          .run();
        return { action: 'enqueue', reason: 'fresh-claim' };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const row = await get(jobKey);
        if (!row) throw err;
        return decideOnConflict(row);
      }
    },

    async setInProgress(jobKey, fields) {
      await db
        .prepare(
          'UPDATE jobs SET status = ?, kind = ?, gig_id = ?, payer_id = ?, brief_json = ?, park_reason = NULL, updated_at = ? WHERE job_key = ?',
        )
        .bind(
          'in_progress',
          fields.kind,
          fields.gigId,
          fields.payerId,
          fields.briefJson,
          touch(),
          jobKey,
        )
        .run();
    },

    async saveCheckpoint(jobKey, checkpoint) {
      await db
        .prepare(
          'UPDATE jobs SET checkpoint_json = ?, spent_usd = ?, updated_at = ? WHERE job_key = ?',
        )
        .bind(JSON.stringify(checkpoint), checkpoint.spendUsd, touch(), jobKey)
        .run();
    },

    async park(jobKey, reason) {
      // COALESCE, not a read-then-write: `parked_since` marks the START of the
      // current failing spell, so a re-park (the cron unparks, the consumer
      // fails again, we land back here) must NOT restart the clock. Doing it in
      // one statement also means two concurrent parks cannot race the check.
      const ts = touch();
      await db
        .prepare(
          'UPDATE jobs SET status = ?, park_reason = ?, parked_since = COALESCE(parked_since, ?), updated_at = ? WHERE job_key = ?',
        )
        .bind('parked', reason, ts, ts, jobKey)
        .run();
    },

    async unpark(jobKey) {
      await db
        .prepare(
          "UPDATE jobs SET status = 'claimed', park_reason = NULL, updated_at = ? WHERE job_key = ? AND status = 'parked'",
        )
        .bind(touch(), jobKey)
        .run();
    },

    async incrementModerationAttempts(jobKey) {
      await db
        .prepare(
          'UPDATE jobs SET moderation_attempts = moderation_attempts + 1, updated_at = ? WHERE job_key = ?',
        )
        .bind(touch(), jobKey)
        .run();
      return (await get(jobKey))?.moderationAttempts ?? 0;
    },

    async markDelivered(jobKey, outcome) {
      // Clearing `parked_since` here — and ONLY here — is what makes it mean
      // "still failing". `unpark()` deliberately leaves it alone, because the
      // failing spell is not over merely because the cron re-enqueued the job;
      // reaching a terminal state is the only thing that ends it.
      const ts = touch();
      await db
        .prepare(
          'UPDATE jobs SET status = ?, outcome = ?, delivered_at = ?, parked_since = NULL, updated_at = ? WHERE job_key = ?',
        )
        .bind('delivered', outcome, ts, ts, jobKey)
        .run();
    },

    async listParked(reason) {
      const query = reason
        ? db
            .prepare('SELECT * FROM jobs WHERE status = ? AND park_reason = ?')
            .bind('parked', reason)
        : db.prepare('SELECT * FROM jobs WHERE status = ?').bind('parked');
      const { results } = await query.all<RawJobRow>();
      return results.map(toJobRow);
    },

    async listStuckClaims(olderThan) {
      const { results } = await db
        .prepare(
          'SELECT * FROM jobs WHERE status = ? AND checkpoint_json IS NULL AND created_at < ?',
        )
        .bind('claimed', olderThan.toISOString())
        .all<RawJobRow>();
      return results.map(toJobRow);
    },

    async recordGateAudit(entry) {
      await db
        .prepare(
          'INSERT INTO gate_audit (job_key, contract_id, slot, gate, result, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          entry.jobKey,
          entry.contractId ?? null,
          entry.slot ?? null,
          entry.gate,
          entry.result,
          entry.detail === undefined ? null : JSON.stringify(entry.detail),
          touch(),
        )
        .run();
    },

    async listGateAudit(jobKey, gate) {
      // Ordered by the autoincrement id, not created_at: `touch()` has
      // one-second resolution at best and several gate rows are written inside
      // the same tick, so "which screening was last" has to come from insert
      // order rather than from a timestamp that ties.
      const query =
        gate === undefined
          ? db.prepare('SELECT * FROM gate_audit WHERE job_key = ? ORDER BY id ASC').bind(jobKey)
          : db
              .prepare('SELECT * FROM gate_audit WHERE job_key = ? AND gate = ? ORDER BY id ASC')
              .bind(jobKey, gate);
      const { results } = await query.all<RawGateAuditRow>();
      return results.map(toGateAuditRow);
    },
  };
}

// --- Concepts ----------------------------------------------------------------

export interface ConceptRow {
  contractId: string;
  slot: number;
  axisId: string;
  vendor: string;
  vendorRequestId: string | null;
  r2Key: string | null;
  nativeSvgKey: string | null;
  phash: string | null;
  ocrTranscription: string | null;
  ocrScore: number | null;
  ocrModel: string | null;
  ocrPass: boolean;
  attemptsUsed: number;
}

export interface ConceptUpsert {
  contractId: string;
  slot: number;
  axisId: string;
  vendor: string;
  vendorRequestId?: string;
  r2Key?: string;
  nativeSvgKey?: string;
  phash?: string;
  ocrTranscription?: string;
  ocrScore?: number;
  ocrModel?: string;
  ocrPass?: boolean;
  attemptsUsed?: number;
}

export interface ConceptStore {
  upsert(concept: ConceptUpsert): Promise<void>;
  list(contractId: string): Promise<ConceptRow[]>;
  listPassing(contractId: string): Promise<ConceptRow[]>;
}

interface RawConceptRow {
  contract_id: string;
  slot: number;
  axis_id: string;
  vendor: string;
  vendor_request_id: string | null;
  r2_key: string | null;
  native_svg_key: string | null;
  phash: string | null;
  ocr_transcription: string | null;
  ocr_score: number | null;
  ocr_model: string | null;
  ocr_pass: number;
  attempts_used: number;
}

const toConceptRow = (raw: RawConceptRow): ConceptRow => ({
  contractId: raw.contract_id,
  slot: raw.slot,
  axisId: raw.axis_id,
  vendor: raw.vendor,
  vendorRequestId: raw.vendor_request_id,
  r2Key: raw.r2_key,
  nativeSvgKey: raw.native_svg_key,
  phash: raw.phash,
  ocrTranscription: raw.ocr_transcription,
  ocrScore: raw.ocr_score,
  ocrModel: raw.ocr_model,
  ocrPass: raw.ocr_pass === 1,
  attemptsUsed: raw.attempts_used,
});

export function createConceptStore(db: D1Like, now: () => Date = () => new Date()): ConceptStore {
  return {
    async upsert(concept) {
      // A regenerated slot overwrites its row — three slots, always three rows.
      await db
        .prepare(
          `INSERT INTO concepts (contract_id, slot, axis_id, vendor, vendor_request_id, r2_key,
             native_svg_key, phash, ocr_transcription, ocr_score, ocr_model, ocr_pass,
             attempts_used, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(contract_id, slot) DO UPDATE SET
             axis_id = excluded.axis_id, vendor = excluded.vendor,
             vendor_request_id = excluded.vendor_request_id, r2_key = excluded.r2_key,
             native_svg_key = excluded.native_svg_key,
             phash = excluded.phash, ocr_transcription = excluded.ocr_transcription,
             ocr_score = excluded.ocr_score, ocr_model = excluded.ocr_model,
             ocr_pass = excluded.ocr_pass, attempts_used = excluded.attempts_used`,
        )
        .bind(
          concept.contractId,
          concept.slot,
          concept.axisId,
          concept.vendor,
          concept.vendorRequestId ?? null,
          concept.r2Key ?? null,
          concept.nativeSvgKey ?? null,
          concept.phash ?? null,
          concept.ocrTranscription ?? null,
          concept.ocrScore ?? null,
          concept.ocrModel ?? null,
          concept.ocrPass ? 1 : 0,
          concept.attemptsUsed ?? 0,
          now().toISOString(),
        )
        .run();
    },

    async list(contractId) {
      const { results } = await db
        .prepare('SELECT * FROM concepts WHERE contract_id = ? ORDER BY slot ASC')
        .bind(contractId)
        .all<RawConceptRow>();
      return results.map(toConceptRow);
    },

    async listPassing(contractId) {
      const { results } = await db
        .prepare(
          'SELECT * FROM concepts WHERE contract_id = ? AND ocr_pass = 1 ORDER BY ocr_score DESC, slot ASC',
        )
        .bind(contractId)
        .all<RawConceptRow>();
      return results.map(toConceptRow);
    },
  };
}

// --- Selection ----------------------------------------------------------------

export interface SelectionRow {
  contractId: string;
  state: 'concepts_delivered' | 'winner_selected' | 'pack_delivered';
  winnerSlot: number | null;
  source: SelectionSource | null;
  m1DeliveredAt: string;
}

export interface SelectionStore {
  open(contractId: string): Promise<void>;
  get(contractId: string): Promise<SelectionRow | null>;
  select(contractId: string, slot: number, source: SelectionSource): Promise<void>;
  markPackDelivered(contractId: string): Promise<void>;
  /** Contracts still at `concepts_delivered` whose M1 is older than the cutoff. */
  listAwaitingSelection(olderThan: Date): Promise<SelectionRow[]>;
}

interface RawSelectionRow {
  contract_id: string;
  state: SelectionRow['state'];
  winner_slot: number | null;
  source: SelectionSource | null;
  m1_delivered_at: string;
}

const toSelectionRow = (raw: RawSelectionRow): SelectionRow => ({
  contractId: raw.contract_id,
  state: raw.state,
  winnerSlot: raw.winner_slot,
  source: raw.source,
  m1DeliveredAt: raw.m1_delivered_at,
});

export function createSelectionStore(
  db: D1Like,
  now: () => Date = () => new Date(),
): SelectionStore {
  const touch = (): string => now().toISOString();
  return {
    async open(contractId) {
      const ts = touch();
      await db
        .prepare(
          `INSERT INTO selection (contract_id, state, m1_delivered_at, updated_at)
           VALUES (?, 'concepts_delivered', ?, ?)
           ON CONFLICT(contract_id) DO NOTHING`,
        )
        .bind(contractId, ts, ts)
        .run();
    },

    async get(contractId) {
      const raw = await db
        .prepare('SELECT * FROM selection WHERE contract_id = ?')
        .bind(contractId)
        .first<RawSelectionRow>();
      return raw ? toSelectionRow(raw) : null;
    },

    async select(contractId, slot, source) {
      // Conditional on the current state: the first selection wins, so a buyer
      // reply arriving after the default rule already fired cannot silently
      // re-point M2 at a different concept.
      await db
        .prepare(
          `UPDATE selection SET state = 'winner_selected', winner_slot = ?, source = ?,
             selected_at = ?, updated_at = ?
           WHERE contract_id = ? AND state = 'concepts_delivered'`,
        )
        .bind(slot, source, touch(), touch(), contractId)
        .run();
    },

    async markPackDelivered(contractId) {
      await db
        .prepare(
          `UPDATE selection SET state = 'pack_delivered', updated_at = ?
           WHERE contract_id = ? AND state = 'winner_selected'`,
        )
        .bind(touch(), contractId)
        .run();
    },

    async listAwaitingSelection(olderThan) {
      const { results } = await db
        .prepare(
          "SELECT * FROM selection WHERE state = 'concepts_delivered' AND m1_delivered_at < ?",
        )
        .bind(olderThan.toISOString())
        .all<RawSelectionRow>();
      return results.map(toSelectionRow);
    },
  };
}

// --- Free-gig quota (FR-14) ----------------------------------------------------

export interface QuotaStore {
  countRecent(payerId: string, windowDays: number): Promise<number>;
  record(payerId: string, kind: 'favicon' | 'taster', contractId: string): Promise<void>;
}

export function createQuotaStore(db: D1Like, now: () => Date = () => new Date()): QuotaStore {
  return {
    async countRecent(payerId, windowDays) {
      const cutoff = new Date(now().getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
      const row = await db
        .prepare('SELECT COUNT(*) AS n FROM free_gig_usage WHERE payer_id = ? AND created_at >= ?')
        .bind(payerId, cutoff)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    async record(payerId, kind, contractId) {
      await db
        .prepare(
          'INSERT INTO free_gig_usage (payer_id, kind, contract_id, created_at) VALUES (?, ?, ?, ?)',
        )
        .bind(payerId, kind, contractId, now().toISOString())
        .run();
    },
  };
}

// --- Reputation snapshot cache -------------------------------------------------

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
