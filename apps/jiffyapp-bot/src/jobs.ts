// D1 store layer (Task 11): every persistent-state accessor the JiffyApp
// pipeline/sweeps/relay need. One factory per table (plus a few free
// functions for single-row/append-only tables), all pure `D1Like` consumers
// with no Workers globals so node tests run against
// @botguild/agent-core-workers/testing's in-memory SQLite. Schema is FIXED —
// see migrations/0001_init.sql; every SQL statement below matches its columns
// exactly. JSON columns are parsed/serialized at the store boundary; every
// timestamp column is an ISO-8601 string produced by the injected `now()`.

import type { D1Like } from '@botguild/agent-core-workers';
import type {
  GoldenSet,
  JiffyBrief,
  JobKind,
  SlotValues,
  TemplateId,
  ToolStatus,
} from './types.js';

// --- Shared helpers ----------------------------------------------------------

/** Web Crypto SHA-256 hex — the recomputable half of a job key: sha256(contractId). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A high-entropy 64-hex capability token (deliverable URLs, relay tokens, verify tokens). */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** job_key = sha256(contractId) + ':' + stage (FR-15: stage ∈ 'build' | 'cycle' | 'edit:<requestId>'). */
export function jobKeyFor(contractHash: string, stage: string): string {
  return `${contractHash}:${stage}`;
}

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// =============================================================================
// JobStore — the `jobs` table: idempotency claims, checkpoints, parking.
// =============================================================================

export interface BuildCheckpoint {
  slotValues: SlotValues | null;
  round: number;
  spendUsd: number;
  /** Accumulated ACTIVE consumer time (ms) — the FR-6 25-min cap basis; parked waits are free. */
  activeMs: number;
  staged: boolean;
  lastFailures: string[];
  /** The round whose codegen slots + spend are already banked (persisted BEFORE render/deploy),
   *  so a queue retry after a transient stage/deploy throw re-uses them instead of re-generating
   *  (no double spend). `null` once assertions have run for that round (a failed round regenerates
   *  on repair). Older checkpoints predate the field — read `undefined` as `null`. */
  bankedRound: number | null;
  /** Edit-path only (F2 restore-last-good): the tool's prior-good live slots, captured BEFORE the
   *  first edit `promote` overwrites them. A live-gate FAILURE on an edit restores the tool to this
   *  version. Captured once (guarded by `??`) because on a promote retry `tool.slots` is already the
   *  NEW slots — so the persisted value is the only reliable source of the last-good render. */
  priorSlots?: SlotValues | null;
}

export interface JobRow {
  jobKey: string;
  contractId: string;
  kind: JobKind;
  toolId: string | null;
  gigId: string | null;
  status: 'claimed' | 'parked' | 'in_progress' | 'delivered';
  outcome: 'delivered' | 'aborted' | 'rejected' | null;
  brief: JiffyBrief | null;
  goldens: GoldenSet | null;
  parkReason: string | null;
  moderationAttempts: number;
  checkpoint: BuildCheckpoint | null;
  spentUsd: number;
  repairRounds: number;
  deliverableToken: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

interface RawJobRow {
  job_key: string;
  contract_id: string;
  kind: JobKind;
  tool_id: string | null;
  gig_id: string | null;
  status: JobRow['status'];
  outcome: JobRow['outcome'];
  brief_json: string | null;
  goldens_json: string | null;
  park_reason: string | null;
  moderation_attempts: number;
  checkpoint_json: string | null;
  spent_usd: number;
  repair_rounds: number;
  deliverable_token: string;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

function toJobRow(raw: RawJobRow): JobRow {
  return {
    jobKey: raw.job_key,
    contractId: raw.contract_id,
    kind: raw.kind,
    toolId: raw.tool_id,
    gigId: raw.gig_id,
    status: raw.status,
    outcome: raw.outcome,
    brief: raw.brief_json ? (JSON.parse(raw.brief_json) as JiffyBrief) : null,
    goldens: raw.goldens_json ? (JSON.parse(raw.goldens_json) as GoldenSet) : null,
    parkReason: raw.park_reason,
    moderationAttempts: raw.moderation_attempts,
    checkpoint: raw.checkpoint_json ? (JSON.parse(raw.checkpoint_json) as BuildCheckpoint) : null,
    spentUsd: raw.spent_usd,
    repairRounds: raw.repair_rounds,
    deliverableToken: raw.deliverable_token,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    deliveredAt: raw.delivered_at,
  };
}

export type ClaimDecision =
  | { action: 'enqueue'; reason: 'fresh-claim' | 'claimed-not-checkpointed' }
  | { action: 'skip'; reason: 'delivered' | 'in-progress' | 'parked' };

/**
 * Pure conflict policy (VoiceWright policy verbatim): claim and enqueue are
 * not atomic, so a unique-constraint conflict must not blindly 200. A job
 * still merely `claimed` with no checkpoint is re-enqueued (the claim won but
 * the send may have been lost); `in_progress` and checkpointed claims already
 * reached a consumer, so a redelivery SKIPs to avoid a second concurrent
 * pipeline invocation double-spending the FR-6 cap or double-delivering.
 * Parked jobs are the cron's responsibility.
 */
export function decideOnConflict(row: Pick<JobRow, 'status' | 'checkpoint'>): ClaimDecision {
  if (row.status === 'delivered') return { action: 'skip', reason: 'delivered' };
  if (row.status === 'parked') return { action: 'skip', reason: 'parked' };
  if (row.status === 'in_progress') return { action: 'skip', reason: 'in-progress' };
  if (row.checkpoint !== null) return { action: 'skip', reason: 'in-progress' };
  return { action: 'enqueue', reason: 'claimed-not-checkpointed' };
}

export interface JobStore {
  /** D1 INSERT claim with a fresh deliverable_token; on conflict applies decideOnConflict. */
  claim(args: {
    jobKey: string;
    contractId: string;
    kind: JobKind;
    toolId?: string;
    gigId?: string;
  }): Promise<ClaimDecision>;
  get(jobKey: string): Promise<JobRow | null>;
  setInProgress(
    jobKey: string,
    fields: { gigId?: string; briefJson?: string; goldensJson?: string; toolId?: string },
  ): Promise<void>;
  /** Denormalizes spent_usd + repair_rounds from the checkpoint alongside the JSON blob. */
  saveCheckpoint(jobKey: string, cp: BuildCheckpoint): Promise<void>;
  /** Overwrites brief_json in place without touching status/park_reason (unlike setInProgress,
   *  which forces status to 'in_progress' — wrong for a still-parked row). Used by the 15-min
   *  sweep's brief-correction poll to apply a corrected brief BEFORE unparking the job. */
  updateBrief(jobKey: string, briefJson: string): Promise<void>;
  park(jobKey: string, reason: string): Promise<void>;
  /** parked → claimed, clearing park_reason, ahead of a cron re-enqueue. */
  unpark(jobKey: string): Promise<void>;
  incrementModerationAttempts(jobKey: string): Promise<number>;
  markDelivered(jobKey: string, outcome: 'delivered' | 'aborted' | 'rejected'): Promise<void>;
  listParked(reason?: string): Promise<JobRow[]>;
  /** `claimed` jobs older than the cutoff with no checkpoint (daily stuck-claim sweep). */
  listStuckClaims(olderThan: Date): Promise<JobRow[]>;
}

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

    async claim(args): Promise<ClaimDecision> {
      const ts = touch();
      try {
        await db
          .prepare(
            `INSERT INTO jobs (job_key, contract_id, kind, tool_id, gig_id, status, deliverable_token, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?)`,
          )
          .bind(
            args.jobKey,
            args.contractId,
            args.kind,
            args.toolId ?? null,
            args.gigId ?? null,
            randomToken(),
            ts,
            ts,
          )
          .run();
        return { action: 'enqueue', reason: 'fresh-claim' };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const row = await get(args.jobKey);
        if (!row) throw err; // claim raced a delete that cannot happen — surface it
        return decideOnConflict(row);
      }
    },

    async setInProgress(jobKey, fields): Promise<void> {
      await db
        .prepare(
          `UPDATE jobs SET status = 'in_progress',
             gig_id = COALESCE(?, gig_id),
             brief_json = COALESCE(?, brief_json),
             goldens_json = COALESCE(?, goldens_json),
             tool_id = COALESCE(?, tool_id),
             park_reason = NULL,
             updated_at = ?
           WHERE job_key = ?`,
        )
        .bind(
          fields.gigId ?? null,
          fields.briefJson ?? null,
          fields.goldensJson ?? null,
          fields.toolId ?? null,
          touch(),
          jobKey,
        )
        .run();
    },

    async saveCheckpoint(jobKey, cp): Promise<void> {
      await db
        .prepare(
          'UPDATE jobs SET checkpoint_json = ?, spent_usd = ?, repair_rounds = ?, updated_at = ? WHERE job_key = ?',
        )
        .bind(JSON.stringify(cp), cp.spendUsd, cp.round, touch(), jobKey)
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

    async listStuckClaims(olderThan): Promise<JobRow[]> {
      const { results } = await db
        .prepare(
          'SELECT * FROM jobs WHERE status = ? AND checkpoint_json IS NULL AND created_at < ?',
        )
        .bind('claimed', olderThan.toISOString())
        .all<RawJobRow>();
      return results.map(toJobRow);
    },
  };
}

// =============================================================================
// ToolStore — the `tools` table: slug reservation, lifecycle, hosting state.
// =============================================================================

export interface ToolRow {
  toolId: string;
  slug: string;
  templateId: TemplateId;
  templateVersion: string;
  buildContractId: string;
  buildGigId: string | null;
  name: string;
  status: ToolStatus;
  hostedUntil: string | null;
  graceStartedAt: string | null;
  latestHostingContractId: string | null;
  brief: JiffyBrief;
  goldens: GoldenSet;
  slots: SlotValues | null;
  notifyEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawToolRow {
  tool_id: string;
  slug: string;
  template_id: TemplateId;
  template_version: string;
  build_contract_id: string;
  build_gig_id: string | null;
  name: string;
  status: ToolStatus;
  hosted_until: string | null;
  grace_started_at: string | null;
  latest_hosting_contract_id: string | null;
  brief_json: string;
  goldens_json: string;
  slots_json: string | null;
  notify_email: string | null;
  created_at: string;
  updated_at: string;
}

function toToolRow(raw: RawToolRow): ToolRow {
  return {
    toolId: raw.tool_id,
    slug: raw.slug,
    templateId: raw.template_id,
    templateVersion: raw.template_version,
    buildContractId: raw.build_contract_id,
    buildGigId: raw.build_gig_id,
    name: raw.name,
    status: raw.status,
    hostedUntil: raw.hosted_until,
    graceStartedAt: raw.grace_started_at,
    latestHostingContractId: raw.latest_hosting_contract_id,
    brief: JSON.parse(raw.brief_json) as JiffyBrief,
    goldens: JSON.parse(raw.goldens_json) as GoldenSet,
    slots: raw.slots_json ? (JSON.parse(raw.slots_json) as SlotValues) : null,
    notifyEmail: raw.notify_email,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export interface ToolStore {
  /**
   * Reserves the first free slug from slugCandidates (INSERT wins, or
   * UNIQUE-conflicts and tries the next); inserts the row with status
   * 'building'; returns the reserved slug. SQLite's constraint-name text in
   * the error is NOT trustworthy for telling a slug collision apart from a
   * redelivered claim retrying the same tool_id: an exact-duplicate row
   * (same tool_id AND slug, e.g. a resumed job replaying its own prior
   * attempt) can still be reported as a `slug` conflict. So on ANY
   * UNIQUE-constraint violation inside the loop, first check whether a
   * tools row for this tool_id already exists — if so, this is a resume,
   * and the existing row's slug is returned immediately instead of trying
   * more candidates. Only when no such row exists is the conflict treated
   * as a genuine slug collision, and the next candidate is tried. Throws if
   * every candidate is genuinely taken by a different tool.
   */
  create(row: {
    toolId: string;
    slugCandidates: string[];
    templateId: TemplateId;
    templateVersion: string;
    buildContractId: string;
    buildGigId?: string;
    name: string;
    brief: JiffyBrief;
    goldens: GoldenSet;
    notifyEmail?: string;
  }): Promise<string>;
  getByBuildContract(contractId: string): Promise<ToolRow | null>;
  get(toolId: string): Promise<ToolRow | null>;
  getBySlug(slug: string): Promise<ToolRow | null>;
  promote(toolId: string, args: { slots: SlotValues; hostedUntil: string }): Promise<void>;
  setStatus(toolId: string, status: ToolStatus): Promise<void>;
  setGoldens(toolId: string, goldens: GoldenSet): Promise<void>;
  extendHosting(
    toolId: string,
    args: { hostedUntil: string; hostingContractId: string },
  ): Promise<void>;
  listExpired(asOf: Date): Promise<ToolRow[]>;
  listGraceElapsed(asOf: Date, graceDays: number): Promise<ToolRow[]>;
  markGrace(toolId: string, at: Date): Promise<void>;
  countByStatus(): Promise<Record<string, number>>;
}

export function createToolStore(db: D1Like, now: () => Date = () => new Date()): ToolStore {
  const touch = (): string => now().toISOString();

  async function get(toolId: string): Promise<ToolRow | null> {
    const raw = await db
      .prepare('SELECT * FROM tools WHERE tool_id = ?')
      .bind(toolId)
      .first<RawToolRow>();
    return raw ? toToolRow(raw) : null;
  }

  return {
    get,

    async create(row): Promise<string> {
      const ts = touch();
      for (const slug of row.slugCandidates) {
        try {
          await db
            .prepare(
              `INSERT INTO tools
                 (tool_id, slug, template_id, template_version, build_contract_id, build_gig_id, name,
                  status, brief_json, goldens_json, notify_email, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'building', ?, ?, ?, ?, ?)`,
            )
            .bind(
              row.toolId,
              slug,
              row.templateId,
              row.templateVersion,
              row.buildContractId,
              row.buildGigId ?? null,
              row.name,
              JSON.stringify(row.brief),
              JSON.stringify(row.goldens),
              row.notifyEmail ?? null,
              ts,
              ts,
            )
            .run();
          return slug;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          // Don't trust which index SQLite named in the message: a resumed
          // redelivery of the same tool_id can report a `slug` conflict even
          // though the row is an exact duplicate of one this tool_id already
          // owns. Always check for that resume case first.
          const existing = await get(row.toolId);
          if (existing) return existing.slug;
          // No existing row for this tool_id — a different tool genuinely
          // holds this slug. Try the next candidate.
        }
      }
      throw new Error(
        `ToolStore.create: all slug candidates are taken (${row.slugCandidates.join(', ')})`,
      );
    },

    async getByBuildContract(contractId): Promise<ToolRow | null> {
      const raw = await db
        .prepare('SELECT * FROM tools WHERE build_contract_id = ?')
        .bind(contractId)
        .first<RawToolRow>();
      return raw ? toToolRow(raw) : null;
    },

    async getBySlug(slug): Promise<ToolRow | null> {
      const raw = await db
        .prepare('SELECT * FROM tools WHERE slug = ?')
        .bind(slug)
        .first<RawToolRow>();
      return raw ? toToolRow(raw) : null;
    },

    async promote(toolId, args): Promise<void> {
      await db
        .prepare(
          `UPDATE tools SET status = 'live', slots_json = ?, hosted_until = ?, grace_started_at = NULL, updated_at = ?
           WHERE tool_id = ?`,
        )
        .bind(JSON.stringify(args.slots), args.hostedUntil, touch(), toolId)
        .run();
    },

    async setStatus(toolId, status): Promise<void> {
      await db
        .prepare('UPDATE tools SET status = ?, updated_at = ? WHERE tool_id = ?')
        .bind(status, touch(), toolId)
        .run();
    },

    async setGoldens(toolId, goldens): Promise<void> {
      await db
        .prepare('UPDATE tools SET goldens_json = ?, updated_at = ? WHERE tool_id = ?')
        .bind(JSON.stringify(goldens), touch(), toolId)
        .run();
    },

    async extendHosting(toolId, args): Promise<void> {
      await db
        .prepare(
          `UPDATE tools SET hosted_until = ?, latest_hosting_contract_id = ?, status = 'live', grace_started_at = NULL, updated_at = ?
           WHERE tool_id = ?`,
        )
        .bind(args.hostedUntil, args.hostingContractId, touch(), toolId)
        .run();
    },

    async listExpired(asOf): Promise<ToolRow[]> {
      const { results } = await db
        .prepare("SELECT * FROM tools WHERE status = 'live' AND hosted_until < ?")
        .bind(asOf.toISOString())
        .all<RawToolRow>();
      return results.map(toToolRow);
    },

    async listGraceElapsed(asOf, graceDays): Promise<ToolRow[]> {
      const cutoff = new Date(asOf.getTime() - graceDays * 24 * 60 * 60 * 1000).toISOString();
      const { results } = await db
        .prepare("SELECT * FROM tools WHERE status = 'grace' AND grace_started_at <= ?")
        .bind(cutoff)
        .all<RawToolRow>();
      return results.map(toToolRow);
    },

    async markGrace(toolId, at): Promise<void> {
      await db
        .prepare(
          "UPDATE tools SET status = 'grace', grace_started_at = ?, updated_at = ? WHERE tool_id = ?",
        )
        .bind(at.toISOString(), touch(), toolId)
        .run();
    },

    async countByStatus(): Promise<Record<string, number>> {
      const { results } = await db
        .prepare('SELECT status, COUNT(*) AS n FROM tools GROUP BY status')
        .all<{ status: string; n: number }>();
      const out: Record<string, number> = {};
      for (const row of results) out[row.status] = row.n;
      return out;
    },
  };
}

// =============================================================================
// CycleStore — the `hosting_cycles` table: one row per funded hosting month.
// =============================================================================

export interface CycleRow {
  contractId: string;
  toolId: string;
  windowStart: string;
  windowEnd: string;
  reportDeliveredAt: string | null;
}

interface RawCycleRow {
  contract_id: string;
  tool_id: string;
  window_start: string;
  window_end: string;
  report_delivered_at: string | null;
  created_at: string;
}

function toCycleRow(raw: RawCycleRow): CycleRow {
  return {
    contractId: raw.contract_id,
    toolId: raw.tool_id,
    windowStart: raw.window_start,
    windowEnd: raw.window_end,
    reportDeliveredAt: raw.report_delivered_at,
  };
}

export interface CycleStore {
  create(row: {
    contractId: string;
    toolId: string;
    windowStart: string;
    windowEnd: string;
  }): Promise<void>;
  get(contractId: string): Promise<CycleRow | null>;
  /** window_end <= asOf AND report_delivered_at IS NULL (month-end service report sweep). */
  listReportDue(
    asOf: Date,
  ): Promise<Array<{ contractId: string; toolId: string; windowStart: string; windowEnd: string }>>;
  markReported(contractId: string): Promise<void>;
  latestForTool(toolId: string): Promise<{ contractId: string; windowEnd: string } | null>;
  /** Funded windows containing asOf whose report hasn't gone out yet (edit polling). */
  listOpen(asOf: Date): Promise<Array<{ contractId: string; toolId: string }>>;
}

export function createCycleStore(db: D1Like, now: () => Date = () => new Date()): CycleStore {
  const touch = (): string => now().toISOString();

  return {
    async create(row): Promise<void> {
      await db
        .prepare(
          'INSERT OR IGNORE INTO hosting_cycles (contract_id, tool_id, window_start, window_end, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(row.contractId, row.toolId, row.windowStart, row.windowEnd, touch())
        .run();
    },

    async get(contractId): Promise<CycleRow | null> {
      const raw = await db
        .prepare('SELECT * FROM hosting_cycles WHERE contract_id = ?')
        .bind(contractId)
        .first<RawCycleRow>();
      return raw ? toCycleRow(raw) : null;
    },

    async listReportDue(asOf) {
      const { results } = await db
        .prepare(
          'SELECT * FROM hosting_cycles WHERE window_end <= ? AND report_delivered_at IS NULL',
        )
        .bind(asOf.toISOString())
        .all<RawCycleRow>();
      return results.map((raw) => ({
        contractId: raw.contract_id,
        toolId: raw.tool_id,
        windowStart: raw.window_start,
        windowEnd: raw.window_end,
      }));
    },

    async markReported(contractId): Promise<void> {
      await db
        .prepare('UPDATE hosting_cycles SET report_delivered_at = ? WHERE contract_id = ?')
        .bind(touch(), contractId)
        .run();
    },

    async latestForTool(toolId): Promise<{ contractId: string; windowEnd: string } | null> {
      const raw = await db
        .prepare(
          'SELECT contract_id, window_end FROM hosting_cycles WHERE tool_id = ? ORDER BY window_end DESC LIMIT 1',
        )
        .bind(toolId)
        .first<{ contract_id: string; window_end: string }>();
      return raw ? { contractId: raw.contract_id, windowEnd: raw.window_end } : null;
    },

    async listOpen(asOf) {
      const iso = asOf.toISOString();
      const { results } = await db
        .prepare(
          'SELECT contract_id, tool_id FROM hosting_cycles WHERE report_delivered_at IS NULL AND window_start <= ? AND window_end >= ?',
        )
        .bind(iso, iso)
        .all<{ contract_id: string; tool_id: string }>();
      return results.map((r) => ({ contractId: r.contract_id, toolId: r.tool_id }));
    },
  };
}

// =============================================================================
// UsageStore — the `usage_counters` table: atomic (scope, period) reservations.
// =============================================================================

export interface UsageStore {
  /**
   * Atomic reservation (ThumbForge pattern): `INSERT … ON CONFLICT DO UPDATE
   * SET used = used + 1 … WHERE used < cap RETURNING used` claims the slot
   * before the caller acts, so concurrent callers can never both read
   * `used < cap` and both proceed past the cap.
   */
  reserve(scope: string, period: string, cap: number): Promise<{ reserved: boolean; used: number }>;
  /** Give a reserved slot back (the reserved action then failed) — never below 0. */
  release(scope: string, period: string): Promise<void>;
  getUsed(scope: string, period: string): Promise<number>;
}

export function createUsageStore(db: D1Like, now: () => Date = () => new Date()): UsageStore {
  async function getUsed(scope: string, period: string): Promise<number> {
    const row = await db
      .prepare('SELECT used FROM usage_counters WHERE scope = ? AND period = ?')
      .bind(scope, period)
      .first<{ used: number }>();
    return row?.used ?? 0;
  }

  return {
    getUsed,

    async reserve(scope, period, cap): Promise<{ reserved: boolean; used: number }> {
      if (cap <= 0) return { reserved: false, used: await getUsed(scope, period) };
      const ts = now().toISOString();
      const row = await db
        .prepare(
          `INSERT INTO usage_counters (scope, period, used, updated_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(scope, period) DO UPDATE SET used = used + 1, updated_at = excluded.updated_at
             WHERE usage_counters.used < ?
           RETURNING used`,
        )
        .bind(scope, period, ts, cap)
        .first<{ used: number }>();
      if (row) return { reserved: true, used: row.used };
      return { reserved: false, used: await getUsed(scope, period) };
    },

    async release(scope, period): Promise<void> {
      await db
        .prepare(
          'UPDATE usage_counters SET used = used - 1, updated_at = ? WHERE scope = ? AND period = ? AND used > 0',
        )
        .bind(now().toISOString(), scope, period)
        .run();
    },
  };
}

/** Calendar-month period key: 'YYYY-MM' (UTC). */
export function monthPeriod(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** Calendar-day period key: 'YYYYMMDD' (UTC). */
export function dayPeriod(d: Date): string {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/** Calendar-minute period key: 'YYYYMMDDHHMM' (UTC). */
export function minutePeriod(d: Date): string {
  return `${dayPeriod(d)}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
}

// =============================================================================
// EditRequestStore — the `edit_requests` table: per-thread-message idempotency.
// =============================================================================

export interface EditRequestRow {
  toolId: string;
  contractId: string;
  instruction: string;
  status: string;
  quotaScope: string | null;
  quotaPeriod: string | null;
}

interface RawEditRequestRow {
  request_id: string;
  tool_id: string;
  contract_id: string;
  instruction: string;
  status: string;
  quota_scope: string | null;
  quota_period: string | null;
  created_at: string;
  updated_at: string;
}

export interface EditRequestStore {
  /** Atomic INSERT claim; false on a UNIQUE conflict (the thread message was already claimed). */
  claim(row: {
    requestId: string;
    toolId: string;
    contractId: string;
    instruction: string;
  }): Promise<boolean>;
  /** Records the (scope, period) of the usage_counters reservation this request consumed. */
  setQuotaRef(requestId: string, quotaScope: string, quotaPeriod: string): Promise<void>;
  get(requestId: string): Promise<EditRequestRow | null>;
  setStatus(requestId: string, status: 'held' | 'done' | 'failed'): Promise<void>;
  countDone(toolId: string, sinceIso: string): Promise<number>;
  listByTool(
    toolId: string,
    sinceIso: string,
  ): Promise<Array<{ requestId: string; instruction: string; status: string }>>;
  /**
   * Reconciliation backstop: 'claimed' edit requests for a tool whose claim predates `cutoffIso`
   * (created_at < cutoffIso). The orphaned-edit sweep uses this to re-drive a request that was
   * claimed but never enqueued (a crash between `claim` and `queue.send`, or a reservation that
   * never produced a job) — closing the buyer's silently-stalled edit and the leaked quota slot.
   */
  listClaimedOlderThan(
    toolId: string,
    cutoffIso: string,
  ): Promise<
    Array<{
      requestId: string;
      contractId: string;
      instruction: string;
      quotaScope: string | null;
      quotaPeriod: string | null;
    }>
  >;
}

export function createEditRequestStore(
  db: D1Like,
  now: () => Date = () => new Date(),
): EditRequestStore {
  const touch = (): string => now().toISOString();

  return {
    async claim(row): Promise<boolean> {
      const ts = touch();
      try {
        await db
          .prepare(
            'INSERT INTO edit_requests (request_id, tool_id, contract_id, instruction, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .bind(row.requestId, row.toolId, row.contractId, row.instruction, ts, ts)
          .run();
        return true;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        return false;
      }
    },

    async setQuotaRef(requestId, quotaScope, quotaPeriod): Promise<void> {
      await db
        .prepare(
          'UPDATE edit_requests SET quota_scope = ?, quota_period = ?, updated_at = ? WHERE request_id = ?',
        )
        .bind(quotaScope, quotaPeriod, touch(), requestId)
        .run();
    },

    async get(requestId): Promise<EditRequestRow | null> {
      const raw = await db
        .prepare('SELECT * FROM edit_requests WHERE request_id = ?')
        .bind(requestId)
        .first<RawEditRequestRow>();
      return raw
        ? {
            toolId: raw.tool_id,
            contractId: raw.contract_id,
            instruction: raw.instruction,
            status: raw.status,
            quotaScope: raw.quota_scope,
            quotaPeriod: raw.quota_period,
          }
        : null;
    },

    async setStatus(requestId, status): Promise<void> {
      await db
        .prepare('UPDATE edit_requests SET status = ?, updated_at = ? WHERE request_id = ?')
        .bind(status, touch(), requestId)
        .run();
    },

    async countDone(toolId, sinceIso): Promise<number> {
      const row = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM edit_requests WHERE tool_id = ? AND status = 'done' AND created_at >= ?",
        )
        .bind(toolId, sinceIso)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    async listByTool(toolId, sinceIso) {
      const { results } = await db
        .prepare(
          'SELECT request_id, instruction, status FROM edit_requests WHERE tool_id = ? AND created_at >= ? ORDER BY created_at ASC',
        )
        .bind(toolId, sinceIso)
        .all<{ request_id: string; instruction: string; status: string }>();
      return results.map((r) => ({
        requestId: r.request_id,
        instruction: r.instruction,
        status: r.status,
      }));
    },

    async listClaimedOlderThan(toolId, cutoffIso) {
      const { results } = await db
        .prepare(
          "SELECT request_id, contract_id, instruction, quota_scope, quota_period FROM edit_requests WHERE tool_id = ? AND status = 'claimed' AND created_at < ? ORDER BY created_at ASC",
        )
        .bind(toolId, cutoffIso)
        .all<{
          request_id: string;
          contract_id: string;
          instruction: string;
          quota_scope: string | null;
          quota_period: string | null;
        }>();
      return results.map((r) => ({
        requestId: r.request_id,
        contractId: r.contract_id,
        instruction: r.instruction,
        quotaScope: r.quota_scope,
        quotaPeriod: r.quota_period,
      }));
    },
  };
}

// =============================================================================
// RelayStore — the `relay` + `relay_events` tables: form-relay double opt-in.
// =============================================================================

export interface RelayRecord {
  token: string;
  recipient: string;
  verified: boolean;
  verifyToken: string;
}

interface RawRelayRow {
  tool_id: string;
  token: string;
  recipient: string;
  verified: number;
  verify_token: string;
  verified_at: string | null;
  created_at: string;
}

export interface RelayStore {
  /**
   * INSERTs a fresh {token, verifyToken} pair if absent. A recipient CHANGE
   * on an existing row resets verified to false and rotates verify_token
   * (the relay `token` itself stays stable — it's embedded in the deployed
   * form's action URL).
   */
  ensure(
    toolId: string,
    recipient: string,
  ): Promise<{ token: string; verifyToken: string; verified: boolean; created: boolean }>;
  get(toolId: string): Promise<RelayRecord | null>;
  /** Single-use: sets verified=1 + verified_at AND rotates verify_token so the old link dies. */
  verifyByToken(verifyToken: string): Promise<{ toolId: string } | null>;
  recordEvent(row: {
    toolId: string;
    messageId?: string;
    kind: 'verification' | 'submission' | 'test';
    status: string;
  }): Promise<void>;
  latestEvent(
    toolId: string,
    kind: string,
  ): Promise<{ messageId: string | null; status: string; createdAt: string } | null>;
  pruneEvents(olderThan: Date): Promise<void>;
}

export function createRelayStore(db: D1Like, now: () => Date = () => new Date()): RelayStore {
  const touch = (): string => now().toISOString();

  async function get(toolId: string): Promise<RelayRecord | null> {
    const raw = await db
      .prepare('SELECT * FROM relay WHERE tool_id = ?')
      .bind(toolId)
      .first<RawRelayRow>();
    return raw
      ? {
          token: raw.token,
          recipient: raw.recipient,
          verified: raw.verified === 1,
          verifyToken: raw.verify_token,
        }
      : null;
  }

  return {
    get,

    async ensure(toolId, recipient) {
      const existing = await get(toolId);
      if (!existing) {
        const token = randomToken();
        const verifyToken = randomToken();
        await db
          .prepare(
            'INSERT INTO relay (tool_id, token, recipient, verified, verify_token, created_at) VALUES (?, ?, ?, 0, ?, ?)',
          )
          .bind(toolId, token, recipient, verifyToken, touch())
          .run();
        return { token, verifyToken, verified: false, created: true };
      }
      if (existing.recipient !== recipient) {
        const verifyToken = randomToken();
        await db
          .prepare(
            'UPDATE relay SET recipient = ?, verified = 0, verify_token = ?, verified_at = NULL WHERE tool_id = ?',
          )
          .bind(recipient, verifyToken, toolId)
          .run();
        return { token: existing.token, verifyToken, verified: false, created: false };
      }
      return {
        token: existing.token,
        verifyToken: existing.verifyToken,
        verified: existing.verified,
        created: false,
      };
    },

    async verifyByToken(verifyToken): Promise<{ toolId: string } | null> {
      const row = await db
        .prepare('SELECT tool_id FROM relay WHERE verify_token = ?')
        .bind(verifyToken)
        .first<{ tool_id: string }>();
      if (!row) return null;
      await db
        .prepare(
          'UPDATE relay SET verified = 1, verified_at = ?, verify_token = ? WHERE tool_id = ?',
        )
        .bind(touch(), randomToken(), row.tool_id)
        .run();
      return { toolId: row.tool_id };
    },

    async recordEvent(row): Promise<void> {
      await db
        .prepare(
          'INSERT INTO relay_events (tool_id, message_id, kind, status, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(row.toolId, row.messageId ?? null, row.kind, row.status, touch())
        .run();
    },

    async latestEvent(toolId, kind) {
      const raw = await db
        .prepare(
          'SELECT message_id, status, created_at FROM relay_events WHERE tool_id = ? AND kind = ? ORDER BY id DESC LIMIT 1',
        )
        .bind(toolId, kind)
        .first<{ message_id: string | null; status: string; created_at: string }>();
      return raw
        ? { messageId: raw.message_id, status: raw.status, createdAt: raw.created_at }
        : null;
    },

    async pruneEvents(olderThan): Promise<void> {
      await db
        .prepare('DELETE FROM relay_events WHERE created_at < ?')
        .bind(olderThan.toISOString())
        .run();
    },
  };
}

// =============================================================================
// BuildLogStore — the `build_log` table: public per-token progress feed.
// =============================================================================

export interface BuildLogEntry {
  seq: number;
  stage: string;
  message: string;
  detail: unknown;
  createdAt: string;
}

export interface BuildLogStore {
  /** SELECT COALESCE(MAX(seq),0)+1 scoped to token (single-consumer, no race per max_concurrency 1). */
  append(token: string, stage: string, message: string, detail?: unknown): Promise<number>;
  since(token: string, afterSeq: number): Promise<BuildLogEntry[]>;
  prune(olderThan: Date): Promise<void>;
}

export function createBuildLogStore(db: D1Like, now: () => Date = () => new Date()): BuildLogStore {
  return {
    async append(token, stage, message, detail): Promise<number> {
      const seqRow = await db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM build_log WHERE token = ?')
        .bind(token)
        .first<{ next_seq: number }>();
      const seq = seqRow?.next_seq ?? 1;
      await db
        .prepare(
          'INSERT INTO build_log (token, seq, stage, message, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          token,
          seq,
          stage,
          message,
          detail === undefined ? null : JSON.stringify(detail),
          now().toISOString(),
        )
        .run();
      return seq;
    },

    async since(token, afterSeq): Promise<BuildLogEntry[]> {
      const { results } = await db
        .prepare(
          'SELECT seq, stage, message, detail_json, created_at FROM build_log WHERE token = ? AND seq > ? ORDER BY seq ASC',
        )
        .bind(token, afterSeq)
        .all<{
          seq: number;
          stage: string;
          message: string;
          detail_json: string | null;
          created_at: string;
        }>();
      return results.map((r) => ({
        seq: r.seq,
        stage: r.stage,
        message: r.message,
        detail: r.detail_json ? (JSON.parse(r.detail_json) as unknown) : null,
        createdAt: r.created_at,
      }));
    },

    async prune(olderThan): Promise<void> {
      await db
        .prepare('DELETE FROM build_log WHERE created_at < ?')
        .bind(olderThan.toISOString())
        .run();
    },
  };
}

// =============================================================================
// AuditStore — the `gate_audit` table: every gate decision / deploy / promotion.
// =============================================================================

export interface AuditEntry {
  gate: string;
  result: string;
  detail: unknown;
  createdAt: string;
}

export interface AuditStore {
  record(e: { scope: string; gate: string; result: string; detail?: unknown }): Promise<void>;
  listByScope(scope: string): Promise<AuditEntry[]>;
  prune(olderThan: Date): Promise<void>;
}

export function createAuditStore(db: D1Like, now: () => Date = () => new Date()): AuditStore {
  return {
    async record(e): Promise<void> {
      await db
        .prepare(
          'INSERT INTO gate_audit (scope, gate, result, detail_json, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(
          e.scope,
          e.gate,
          e.result,
          e.detail === undefined ? null : JSON.stringify(e.detail),
          now().toISOString(),
        )
        .run();
    },

    async listByScope(scope): Promise<AuditEntry[]> {
      const { results } = await db
        .prepare(
          'SELECT gate, result, detail_json, created_at FROM gate_audit WHERE scope = ? ORDER BY id ASC',
        )
        .bind(scope)
        .all<{ gate: string; result: string; detail_json: string | null; created_at: string }>();
      return results.map((r) => ({
        gate: r.gate,
        result: r.result,
        detail: r.detail_json ? (JSON.parse(r.detail_json) as unknown) : null,
        createdAt: r.created_at,
      }));
    },

    async prune(olderThan): Promise<void> {
      await db
        .prepare('DELETE FROM gate_audit WHERE created_at < ?')
        .bind(olderThan.toISOString())
        .run();
    },
  };
}

// =============================================================================
// Free functions — DLQ depth, abuse reports, reputation snapshot cache.
// =============================================================================

export async function recordDlqEvent(
  db: D1Like,
  queue: string,
  body: unknown,
  now: () => Date = () => new Date(),
): Promise<void> {
  await db
    .prepare('INSERT INTO dlq_events (queue, body_json, created_at) VALUES (?, ?, ?)')
    .bind(queue, JSON.stringify(body), now().toISOString())
    .run();
}

export async function dlqDepth(db: D1Like): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM dlq_events').first<{ n: number }>();
  return row?.n ?? 0;
}

export async function recordAbuse(
  db: D1Like,
  slug: string,
  detail: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  await db
    .prepare('INSERT INTO abuse_reports (slug, detail, created_at) VALUES (?, ?, ?)')
    .bind(slug, detail, now().toISOString())
    .run();
}

// --- Reputation snapshot cache (read by /health, written by the cron) -------

export async function saveReputationSnapshot(
  db: D1Like,
  snapshot: unknown,
  now: () => Date = () => new Date(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reputation_snapshot (id, snapshot_json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(snapshot), now().toISOString())
    .run();
}

export async function loadReputationSnapshot(db: D1Like): Promise<unknown | null> {
  const row = await db
    .prepare('SELECT snapshot_json FROM reputation_snapshot WHERE id = 1')
    .first<{ snapshot_json: string }>();
  return row ? (JSON.parse(row.snapshot_json) as unknown) : null;
}
