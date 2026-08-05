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
 *
 * REVISION 0 IS BYTE-IDENTICAL TO THE PRE-FR-18 KEY, and that is load-bearing
 * rather than tidy: every job row, `gate_audit` row and R2 prefix already
 * written is addressed by `sha256(contractId):stage`, and a scheme that changed
 * that string would orphan all of it — including the audit trail
 * `assembleDisputeEvidence` reads. So the revision is folded into the HASHED
 * INPUT and only for revisions above zero, which is also the construction
 * `freeGigs.test.ts`'s FR-18 suite has characterised since Task 23.
 *
 * A revision key must never collide with a plain contract id. `#` cannot appear
 * in a platform contract id, so `${contractId}#revision-1` is unreachable as a
 * contract id in its own right and the two namespaces cannot meet.
 */
export async function buildJobKey(
  contractId: string,
  stage: JobStage,
  revision = 0,
): Promise<string> {
  const subject = revision === 0 ? contractId : `${contractId}#revision-${revision}`;
  return `${await sha256Hex(subject)}:${stage}`;
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
  /**
   * Which FR-18 round this job belongs to — 0 for the original delivery, 1 for
   * the one warranty revision. Read off the ROW rather than carried on the
   * queue message, so there is one source of truth: `job_key` is a hash and
   * nothing can recover a revision number from it, and a `JobMessage` field
   * could disagree with the row a redelivery re-reads.
   */
  revision: number;
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
  revision: number;
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
  revision: raw.revision,
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
 * FR-5 `MAX_SPEND_USD` cap and double-calling deliverMilestone. Genuinely lost sends stay
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
  /**
   * Claim a job for an FR-18 revision round, capped at `maxRevisions` DISTINCT
   * revisions per contract. Returns whether this contract holds the revision
   * afterwards — whether this call took it or an earlier one already had.
   *
   * SEPARATE FROM `claim` BECAUSE THE CAP IS THE POINT. `claim` is an
   * unconditional INSERT whose only gate is the primary key; this one has to
   * refuse a SECOND revision, and a count-then-insert is not a cap. The window
   * between the two reads is the entire latency of everything in between, and
   * every concurrent request that enters inside it passes the check — measured
   * on this codebase's own free-gig quota at 12 concurrent attempts defeating a
   * cap of 3, i.e. an overrun equal to the attacker's concurrency rather than
   * one. This is `CONSUME_ALLOWANCE_SQL`'s idiom, for that reason.
   *
   * `RETURNING job_key` + `first()` rather than a rows-changed count: real D1
   * answers `{ meta: { changes } }` and `createMemoryD1` (node:sqlite) answers
   * `{ changes }`, and `D1Like.run()` is typed `Promise<unknown>` precisely so
   * nothing depends on either.
   */
  claimRevision(input: {
    jobKey: string;
    contractId: string;
    stage: JobStage;
    revision: number;
    maxRevisions: number;
  }): Promise<{ granted: boolean; reason: 'fresh-claim' | 'already-held' | 'cap-reached' }>;
  get(jobKey: string): Promise<JobRow | null>;
  getByToken(token: string): Promise<JobRow | null>;
  /**
   * Every job row for a contract, oldest first.
   *
   * Exists because `assembleDisputeEvidence` used to COMPUTE its three stage
   * keys from the contract id, which silently omitted any job whose key it
   * could not derive — and a revision's key is derived from a different string.
   * The omission would not have read as wrong data in the evidence document; it
   * would have read as no data, which is worse. Listing what the table HOLDS
   * cannot drift from what was written.
   */
  listByContract(contractId: string): Promise<JobRow[]>;
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

/**
 * The FR-18 revision cap as ONE statement — see `JobStore.claimRevision`.
 *
 * `COUNT(DISTINCT revision)`, NOT `COUNT(*)`. The cap is on REVISION ROUNDS,
 * not on job rows: today a revision claims exactly one row (`vector`), but a
 * revision that ever claimed two stages would otherwise count as two rounds and
 * the buyer would silently lose the entitlement the terms promise them.
 * `revision > 0` excludes the original delivery, which is not a revision.
 *
 * SQLite (and therefore D1) evaluates a statement under a single write lock, so
 * the subquery and the INSERT it gates cannot interleave with another writer.
 * The cap holds at any concurrency.
 */
const CLAIM_REVISION_SQL = `INSERT INTO jobs
     (job_key, contract_id, stage, revision, deliverable_token, status, created_at, updated_at)
   SELECT ?, ?, ?, ?, ?, 'claimed', ?, ?
   WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE job_key = ?)
     AND (SELECT COUNT(DISTINCT revision) FROM jobs WHERE contract_id = ? AND revision > 0) < ?
   RETURNING job_key`;

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
            'INSERT INTO jobs (job_key, contract_id, stage, revision, deliverable_token, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          // `revision` is bound explicitly rather than left to the column
          // DEFAULT: this is the ORIGINAL-round claim, and a schema edit that
          // dropped the default would otherwise make it silently insert NULL.
          .bind(jobKey, contractId, stage, 0, randomDeliverableToken(), 'claimed', ts, ts)
          .run();
        return { action: 'enqueue', reason: 'fresh-claim' };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const row = await get(jobKey);
        if (!row) throw err;
        return decideOnConflict(row);
      }
    },

    async claimRevision({ jobKey, contractId, stage, revision, maxRevisions }) {
      const ts = touch();
      const inserted = await db
        .prepare(CLAIM_REVISION_SQL)
        .bind(
          jobKey,
          contractId,
          stage,
          revision,
          randomDeliverableToken(),
          ts,
          ts,
          jobKey,
          contractId,
          maxRevisions,
        )
        .first<{ job_key: string }>();
      if (inserted !== null) return { granted: true, reason: 'fresh-claim' };
      // Nothing went in. Two stable, opposite reasons — this exact job was
      // already claimed (a queue retry or a webhook redelivery, which must be
      // granted so the work can resume), or the contract is at its revision cap
      // (refuse). Both are settled by the time we ask, so this read cannot race
      // the way a pre-insert check would.
      const existing = await get(jobKey);
      return existing === null
        ? { granted: false, reason: 'cap-reached' }
        : { granted: true, reason: 'already-held' };
    },

    async listByContract(contractId) {
      const { results } = await db
        .prepare('SELECT * FROM jobs WHERE contract_id = ? ORDER BY created_at ASC, job_key ASC')
        .bind(contractId)
        .all<RawJobRow>();
      return results.map(toJobRow);
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
  /** 0 for the original delivery, 1 for the one FR-18 warranty revision. */
  revision: number;
  state: 'concepts_delivered' | 'winner_selected' | 'pack_delivered';
  winnerSlot: number | null;
  source: SelectionSource | null;
  m1DeliveredAt: string;
  /**
   * When the pack for THIS round was delivered, or null while it has not been.
   * Written at exactly one site (`markPackDelivered`) and never touched again.
   *
   * Its own column rather than a read of `updated_at`, because `select()`
   * touches `updated_at` too — so on any row that was selected and then
   * delivered, `updated_at` measures the last write of any kind rather than the
   * delivery. That is the identical mistake migration 0002 records being made
   * with `parked_since`; the revision trigger slices the contract thread on
   * this instant, so an approximate answer would let a message posted BEFORE
   * the pack existed be read as a reply to it.
   */
  packDeliveredAt: string | null;
}

export interface SelectionStore {
  open(contractId: string): Promise<void>;
  /** The row for one round. Defaults to revision 0 — the original delivery. */
  get(contractId: string, revision?: number): Promise<SelectionRow | null>;
  /** Every round for a contract, oldest first. Evidence reads this; nothing else should. */
  listRevisions(contractId: string): Promise<SelectionRow[]>;
  select(
    contractId: string,
    slot: number,
    source: SelectionSource,
    revision?: number,
  ): Promise<void>;
  markPackDelivered(contractId: string, revision?: number): Promise<void>;
  /**
   * Open an FR-18 revision round with its winner ALREADY DECIDED.
   *
   * A revision round does not re-run selection: the buyer named the concept in
   * the message that triggered it, and there is nothing further to wait for. So
   * the row is inserted straight at `winner_selected` rather than passing
   * through `concepts_delivered` — which also keeps it out of
   * `listAwaitingSelection`, so the FR-9 72-hour default rule can never fire on
   * a revision and auto-pick a re-pack the buyer never asked for.
   */
  openRevision(input: {
    contractId: string;
    revision: number;
    slot: number;
    source: SelectionSource;
    m1DeliveredAt: string;
  }): Promise<void>;
  /** Contracts still at `concepts_delivered` whose M1 is older than the cutoff. */
  listAwaitingSelection(olderThan: Date): Promise<SelectionRow[]>;
  /**
   * Delivered packs that could still attract an FR-18 revision request: the
   * LATEST round is `pack_delivered`, it was delivered since `deliveredAfter`,
   * and the contract has not already used a revision.
   *
   * SCOPED IN SQL RATHER THAN FILTERED IN THE CALLER, because the caller is a
   * cron sweep and each candidate costs a `getContract` plus a thread read. An
   * unscoped "every contract that ever delivered" list would grow without
   * bound and be re-read every pass forever.
   */
  listAwaitingRevision(deliveredAfter: Date): Promise<SelectionRow[]>;
}

interface RawSelectionRow {
  contract_id: string;
  revision: number;
  state: SelectionRow['state'];
  winner_slot: number | null;
  source: SelectionSource | null;
  m1_delivered_at: string;
  pack_delivered_at: string | null;
}

const toSelectionRow = (raw: RawSelectionRow): SelectionRow => ({
  contractId: raw.contract_id,
  revision: raw.revision,
  state: raw.state,
  winnerSlot: raw.winner_slot,
  source: raw.source,
  m1DeliveredAt: raw.m1_delivered_at,
  packDeliveredAt: raw.pack_delivered_at,
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
          `INSERT INTO selection (contract_id, revision, state, m1_delivered_at, updated_at)
           VALUES (?, 0, 'concepts_delivered', ?, ?)
           ON CONFLICT(contract_id, revision) DO NOTHING`,
        )
        .bind(contractId, ts, ts)
        .run();
    },

    async get(contractId, revision = 0) {
      const raw = await db
        .prepare('SELECT * FROM selection WHERE contract_id = ? AND revision = ?')
        .bind(contractId, revision)
        .first<RawSelectionRow>();
      return raw ? toSelectionRow(raw) : null;
    },

    async listRevisions(contractId) {
      const { results } = await db
        .prepare('SELECT * FROM selection WHERE contract_id = ? ORDER BY revision ASC')
        .bind(contractId)
        .all<RawSelectionRow>();
      return results.map(toSelectionRow);
    },

    async openRevision({ contractId, revision, slot, source, m1DeliveredAt }) {
      const ts = touch();
      await db
        .prepare(
          `INSERT INTO selection
             (contract_id, revision, state, winner_slot, source, m1_delivered_at, selected_at,
              updated_at)
           VALUES (?, ?, 'winner_selected', ?, ?, ?, ?, ?)
           ON CONFLICT(contract_id, revision) DO NOTHING`,
        )
        .bind(contractId, revision, slot, source, m1DeliveredAt, ts, ts)
        .run();
    },

    async select(contractId, slot, source, revision = 0) {
      // Conditional on the current state: the first selection wins, so a buyer
      // reply arriving after the default rule already fired cannot silently
      // re-point M2 at a different concept.
      await db
        .prepare(
          `UPDATE selection SET state = 'winner_selected', winner_slot = ?, source = ?,
             selected_at = ?, updated_at = ?
           WHERE contract_id = ? AND revision = ? AND state = 'concepts_delivered'`,
        )
        .bind(slot, source, touch(), touch(), contractId, revision)
        .run();
    },

    async markPackDelivered(contractId, revision = 0) {
      // `pack_delivered_at` is written HERE and nowhere else — that single
      // write site is what lets the FR-18 trigger slice the thread on it (see
      // `SelectionRow.packDeliveredAt`).
      const ts = touch();
      await db
        .prepare(
          `UPDATE selection SET state = 'pack_delivered', pack_delivered_at = ?, updated_at = ?
           WHERE contract_id = ? AND revision = ? AND state = 'winner_selected'`,
        )
        .bind(ts, ts, contractId, revision)
        .run();
    },

    async listAwaitingSelection(olderThan) {
      // `revision = 0` is not a filter that could be dropped: only the original
      // round is ever opened at `concepts_delivered`, so a revision row can
      // never appear here — but stating it means the FR-9 default rule can
      // never reach a revision even if `openRevision` were later changed.
      const { results } = await db
        .prepare(
          `SELECT * FROM selection
           WHERE revision = 0 AND state = 'concepts_delivered' AND m1_delivered_at < ?`,
        )
        .bind(olderThan.toISOString())
        .all<RawSelectionRow>();
      return results.map(toSelectionRow);
    },

    async listAwaitingRevision(deliveredAfter) {
      // Three conditions, and the third is the one that matters: a contract
      // that has ALREADY used its revision leaves the poll entirely rather than
      // being re-read every pass for the rest of the warranty window. The
      // authority on the cap is still `claimRevision`'s single statement — this
      // is an index-friendly pre-filter, not a check.
      const { results } = await db
        .prepare(
          `SELECT s.* FROM selection s
           WHERE s.state = 'pack_delivered'
             AND s.pack_delivered_at IS NOT NULL
             AND s.pack_delivered_at >= ?
             AND NOT EXISTS (
               SELECT 1 FROM selection r WHERE r.contract_id = s.contract_id AND r.revision > 0
             )
           ORDER BY s.pack_delivered_at ASC`,
        )
        .bind(deliveredAfter.toISOString())
        .all<RawSelectionRow>();
      return results.map(toSelectionRow);
    },
  };
}

// --- Free-gig quota (FR-14) ----------------------------------------------------

export interface QuotaStore {
  /**
   * How many free gigs this payer has used inside the window. ADVISORY ONLY —
   * it is a read, so anything decided from it is stale the instant it returns.
   * Use it to refuse an over-cap payer before doing work, and to word the
   * refusal; never as the authority. `consume` is the authority.
   */
  countRecent(payerId: string, windowDays: number): Promise<number>;
  /** Does this contract already hold an allowance? Answered from the usage row
   *  itself, so it cannot disagree with what was actually consumed. */
  holdsAllowance(contractId: string): Promise<boolean>;
  /**
   * Atomically claim one allowance for this contract. Returns true when the
   * contract holds an allowance afterwards — whether this call took it or an
   * earlier one already had.
   */
  consume(
    payerId: string,
    kind: 'favicon' | 'taster',
    contractId: string,
    limits: { windowDays: number; maxPerPayer: number },
  ): Promise<boolean>;
  /**
   * Give the allowance back, because the job it was taken for ended in OUR
   * failure and delivered nothing.
   *
   * "A free allowance must never be spent on our failure" is the rule the whole
   * consume-late design exists to serve, and it holds right up to the last
   * branch: a taster whose readback gate was down for its entire regeneration
   * budget consumed an allowance, delivered nothing, and kept it forever.
   *
   * ONLY EVER CALLED ON A TERMINAL, EMPTY-HANDED OUTCOME. Releasing a job that
   * is merely parked would let a retry re-consume against a cap that has since
   * filled, and `holdsAllowance` is what protects an in-flight job from
   * destroying itself (see `runSingleStage`). Deleting rather than flagging
   * keeps `countRecent` and the `NOT EXISTS` clause in `consume` honest with
   * one statement instead of three.
   */
  release(contractId: string): Promise<void>;
}

/**
 * The whole cap decision as ONE statement.
 *
 * A read-then-write (`countRecent`, then insert if under the cap) is not a cap.
 * The window between the two is the entire latency of whatever runs in between
 * — a 15 s source fetch, or a moderation screen plus an image generation — and
 * EVERY concurrent job that enters inside that window passes the check. Queue
 * consumers scale to concurrent invocations and one funded free gig is one
 * message, so the overrun equals the attacker's concurrency, not one. Measured:
 * 12 concurrent attempts against a cap of 3 delivered 12.
 *
 * SQLite (and therefore D1) evaluates a statement under a single write lock, so
 * the `COUNT(*)` subquery and the `INSERT` it gates cannot interleave with
 * another writer. The cap holds at any concurrency.
 *
 * `NOT EXISTS (... WHERE contract_id = ?)` makes it idempotent per contract: a
 * queue retry, a cron unpark, or a DLQ replay of the same job re-runs this and
 * takes nothing extra. That is also why `holdsAllowance` reads the SAME row
 * rather than a separate marker — two writes would leave a window where a crash
 * between them makes a job that already paid look like a job that never ran.
 *
 * `RETURNING id` + `first()` rather than a rows-changed count, because the two
 * runtimes disagree on the shape: real D1 answers `{ meta: { changes } }` and
 * `createMemoryD1` (node:sqlite) answers `{ changes }`, and `D1Like.run()` is
 * typed `Promise<unknown>` precisely so nothing depends on either. `first()` is
 * already on the interface and means the same thing everywhere.
 */
const CONSUME_ALLOWANCE_SQL = `INSERT INTO free_gig_usage (payer_id, kind, contract_id, created_at)
   SELECT ?, ?, ?, ?
   WHERE NOT EXISTS (SELECT 1 FROM free_gig_usage WHERE contract_id = ?)
     AND (SELECT COUNT(*) FROM free_gig_usage WHERE payer_id = ? AND created_at >= ?) < ?
   RETURNING id`;

export function createQuotaStore(db: D1Like, now: () => Date = () => new Date()): QuotaStore {
  const cutoffFor = (windowDays: number): string =>
    new Date(now().getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  async function holdsAllowance(contractId: string): Promise<boolean> {
    const row = await db
      .prepare('SELECT 1 AS held FROM free_gig_usage WHERE contract_id = ? LIMIT 1')
      .bind(contractId)
      .first<{ held: number }>();
    return row !== null;
  }

  return {
    holdsAllowance,

    async countRecent(payerId, windowDays) {
      const row = await db
        .prepare('SELECT COUNT(*) AS n FROM free_gig_usage WHERE payer_id = ? AND created_at >= ?')
        .bind(payerId, cutoffFor(windowDays))
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    async consume(payerId, kind, contractId, limits) {
      const inserted = await db
        .prepare(CONSUME_ALLOWANCE_SQL)
        .bind(
          payerId,
          kind,
          contractId,
          now().toISOString(),
          contractId,
          payerId,
          cutoffFor(limits.windowDays),
          limits.maxPerPayer,
        )
        .first<{ id: number }>();
      if (inserted !== null) return true;
      // No row went in. Two stable reasons, and they are opposites: this
      // contract already held its allowance (grant), or the payer is at the cap
      // (refuse). Both are settled states by the time we ask, so this read
      // cannot race the way the pre-insert check did.
      return holdsAllowance(contractId);
    },

    async release(contractId) {
      await db.prepare('DELETE FROM free_gig_usage WHERE contract_id = ?').bind(contractId).run();
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
