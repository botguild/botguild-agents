// ---------------------------------------------------------------------------
// D1 stores (PRD §7/§8) — the ONLY cap/count-relevant state lives here (never
// KV, §12). Every store is a pure `D1Like` consumer with no Workers globals, so
// node tests run them against @botguild/agent-core-workers/testing's in-memory
// SQLite. Four concerns:
//   - idempotency_claims  — the FR-3 atomic usage-count guard (OG sync path)
//   - usage_counters      — per-offer monthly render counts (FR-15)
//   - cms_secrets         — per-offer HMAC secret + contract + cap (FR-2)
//   - render_jobs/outputs — async gig state (social packs, A/B thumbnails)
// plus the gate audit log and the reputation snapshot cache (voicewright-style).
// ---------------------------------------------------------------------------

import type { D1Like } from '@botguild/agent-core-workers';
import type { BrandKit, JobInputs } from './types.js';
import type { ClaimRow } from './idempotency.js';

/** Web Crypto SHA-256 hex — the async-gig job key: hash(contractId). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

/**
 * Rows affected by a write. Cloudflare D1 returns `{ meta: { changes } }`; the
 * node:sqlite test double returns `{ changes }` — accept both so the conditional
 * `UPDATE … WHERE …` claims below can tell the winner from the losers.
 */
function rowsChanged(result: unknown): number {
  const r = result as { meta?: { changes?: number }; changes?: number } | null;
  return r?.meta?.changes ?? r?.changes ?? 0;
}

// --- Idempotency claims (OG sync path, FR-3) --------------------------------

export interface FullClaimRow extends ClaimRow {
  key: string;
  offerId: string;
  pageUrl: string;
  billedAt: string | null;
}

interface RawClaimRow {
  key: string;
  status: 'pending' | 'delivered';
  offer_id: string;
  page_url: string;
  url: string | null;
  billed_at: string | null;
  claimed_at: string;
}

export interface IdempotencyStore {
  /** Atomic `INSERT … status='pending'`; false on a UNIQUE conflict (FR-3). */
  insertPending(key: string, offerId: string, pageUrl: string): Promise<boolean>;
  get(key: string): Promise<FullClaimRow | null>;
  /** Write url + billed_at and flip to delivered (the only place url is set). */
  markDelivered(key: string, url: string): Promise<void>;
  /** True when the same page_url was delivered under a DIFFERENT key (§8 label). */
  priorVersionDelivered(pageUrl: string, exceptKey: string): Promise<boolean>;
  /** Drop a still-`pending` claim (e.g. flagged/rejected) so it never wedges a re-fire. */
  removePending(key: string): Promise<void>;
  /** Delete `pending` claims older than the cutoff (daily reconciliation sweep). */
  sweepStalePending(olderThan: Date): Promise<number>;
}

export function createIdempotencyStore(db: D1Like, now: () => Date = () => new Date()): IdempotencyStore {
  const toRow = (raw: RawClaimRow): FullClaimRow => ({
    key: raw.key,
    status: raw.status,
    offerId: raw.offer_id,
    pageUrl: raw.page_url,
    url: raw.url,
    billedAt: raw.billed_at,
    claimedAt: raw.claimed_at,
  });

  return {
    async insertPending(key, offerId, pageUrl): Promise<boolean> {
      try {
        await db
          .prepare(
            'INSERT INTO idempotency_claims (key, status, offer_id, page_url, claimed_at) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(key, 'pending', offerId, pageUrl, now().toISOString())
          .run();
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },

    async get(key): Promise<FullClaimRow | null> {
      const raw = await db
        .prepare('SELECT * FROM idempotency_claims WHERE key = ?')
        .bind(key)
        .first<RawClaimRow>();
      return raw ? toRow(raw) : null;
    },

    async markDelivered(key, url): Promise<void> {
      const ts = now().toISOString();
      await db
        .prepare("UPDATE idempotency_claims SET status = 'delivered', url = ?, billed_at = ? WHERE key = ?")
        .bind(url, ts, key)
        .run();
    },

    async priorVersionDelivered(pageUrl, exceptKey): Promise<boolean> {
      const row = await db
        .prepare(
          "SELECT 1 AS hit FROM idempotency_claims WHERE page_url = ? AND key != ? AND status = 'delivered' LIMIT 1",
        )
        .bind(pageUrl, exceptKey)
        .first<{ hit: number }>();
      return row !== null;
    },

    async removePending(key): Promise<void> {
      await db
        .prepare("DELETE FROM idempotency_claims WHERE key = ? AND status = 'pending'")
        .bind(key)
        .run();
    },

    async sweepStalePending(olderThan): Promise<number> {
      const { results } = await db
        .prepare("SELECT key FROM idempotency_claims WHERE status = 'pending' AND claimed_at < ?")
        .bind(olderThan.toISOString())
        .all<{ key: string }>();
      for (const row of results) {
        await db.prepare("DELETE FROM idempotency_claims WHERE key = ? AND status = 'pending'").bind(row.key).run();
      }
      return results.length;
    },
  };
}

// --- Per-offer monthly usage counters (FR-15) -------------------------------

export interface UsageReservation {
  /** True when a cap slot was claimed (the counter was incremented). */
  reserved: boolean;
  /** The current used count: post-increment when reserved, unchanged when held. */
  used: number;
}

export interface UsageStore {
  getUsed(offerId: string, period: string): Promise<number>;
  /**
   * FR-15 cap enforcement as an ATOMIC reservation (§13: "even D1 read-then-write
   * races" must be avoided). A single `INSERT … ON CONFLICT DO UPDATE … WHERE
   * used < cap RETURNING used` claims the slot before the render, so concurrent
   * publishes of different page versions can never both read `used < cap` and
   * both render past the cap. `reserved:false` means the conditional update was a
   * no-op — the offer is at cap. Compensate with `release` on render failure.
   */
  reserve(offerId: string, period: string, cap: number): Promise<UsageReservation>;
  /** Give a reserved slot back (render failed after reserving) — never below 0. */
  release(offerId: string, period: string): Promise<void>;
}

export function createUsageStore(db: D1Like, now: () => Date = () => new Date()): UsageStore {
  async function getUsed(offerId: string, period: string): Promise<number> {
    const row = await db
      .prepare('SELECT used FROM usage_counters WHERE offer_id = ? AND period = ?')
      .bind(offerId, period)
      .first<{ used: number }>();
    return row?.used ?? 0;
  }

  return {
    getUsed,

    async reserve(offerId, period, cap): Promise<UsageReservation> {
      if (cap <= 0) return { reserved: false, used: await getUsed(offerId, period) };
      const ts = now().toISOString();
      // Fresh insert (used=1) or increment-if-under-cap; RETURNING yields a row
      // only when a slot was actually claimed. A no-op update (existing
      // used >= cap) returns nothing → held.
      const row = await db
        .prepare(
          `INSERT INTO usage_counters (offer_id, period, used, updated_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(offer_id, period) DO UPDATE SET used = used + 1, updated_at = excluded.updated_at
             WHERE usage_counters.used < ?
           RETURNING used`,
        )
        .bind(offerId, period, ts, cap)
        .first<{ used: number }>();
      if (row) return { reserved: true, used: row.used };
      return { reserved: false, used: await getUsed(offerId, period) };
    },

    async release(offerId, period): Promise<void> {
      await db
        .prepare(
          'UPDATE usage_counters SET used = used - 1, updated_at = ? WHERE offer_id = ? AND period = ? AND used > 0',
        )
        .bind(now().toISOString(), offerId, period)
        .run();
    },
  };
}

// --- Per-offer CMS signing secrets (FR-2) -----------------------------------

export interface OfferRecord {
  offerId: string;
  secret: string;
  contractId: string;
  cap: number;
}

interface RawOfferRow {
  offer_id: string;
  secret: string;
  contract_id: string;
  cap: number;
}

export interface OfferStore {
  /** Arm an OG route: store its per-offer HMAC secret, contract, and cap. */
  arm(record: OfferRecord): Promise<void>;
  get(offerId: string): Promise<OfferRecord | null>;
  /** All armed offers (the monthly recurring re-post sweep, §10.7). */
  list(): Promise<OfferRecord[]>;
}

export function createOfferStore(db: D1Like, now: () => Date = () => new Date()): OfferStore {
  return {
    async arm(record): Promise<void> {
      const ts = now().toISOString();
      await db
        .prepare(
          `INSERT INTO cms_secrets (offer_id, secret, contract_id, cap, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(offer_id) DO UPDATE SET secret = excluded.secret, contract_id = excluded.contract_id,
             cap = excluded.cap, updated_at = excluded.updated_at`,
        )
        .bind(record.offerId, record.secret, record.contractId, record.cap, ts, ts)
        .run();
    },

    async get(offerId): Promise<OfferRecord | null> {
      const raw = await db
        .prepare('SELECT offer_id, secret, contract_id, cap FROM cms_secrets WHERE offer_id = ?')
        .bind(offerId)
        .first<RawOfferRow>();
      return raw
        ? { offerId: raw.offer_id, secret: raw.secret, contractId: raw.contract_id, cap: raw.cap }
        : null;
    },

    async list(): Promise<OfferRecord[]> {
      const { results } = await db
        .prepare('SELECT offer_id, secret, contract_id, cap FROM cms_secrets ORDER BY offer_id')
        .all<RawOfferRow>();
      return results.map((raw) => ({
        offerId: raw.offer_id,
        secret: raw.secret,
        contractId: raw.contract_id,
        cap: raw.cap,
      }));
    },
  };
}

// --- Async render jobs (social packs, A/B thumbnails) -----------------------

export type RenderJobStatus = 'claimed' | 'in_progress' | 'delivered' | 'parked' | 'rejected';
export type RenderJobOutcome = 'delivered' | 'rejected' | 'aborted';
export type RenderKind = 'social_pack' | 'thumbnail';

/** One graphic in a pack plan — fully self-describing so the consumer needs no re-fetch. */
export interface GraphicSpec {
  graphicId: string;
  templateId: string;
  format: string;
  brandKit: BrandKit;
  inputs: JobInputs;
}

export interface RenderPlan {
  kind: RenderKind;
  graphics: GraphicSpec[];
}

export interface RenderJobRow {
  jobKey: string;
  contractId: string;
  kind: RenderKind | null;
  milestoneId: string | null;
  plan: RenderPlan | null;
  templateArtifact: string | null;
  status: RenderJobStatus;
  outcome: RenderJobOutcome | null;
  parkReason: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

interface RawRenderJobRow {
  job_key: string;
  contract_id: string;
  kind: RenderKind | null;
  milestone_id: string | null;
  plan_json: string | null;
  template_json: string | null;
  status: RenderJobStatus;
  outcome: RenderJobOutcome | null;
  park_reason: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export type RenderClaimDecision =
  | { action: 'enqueue'; reason: 'fresh-claim' | 'claimed-not-planned' }
  | { action: 'skip'; reason: 'delivered' | 'in-progress' };

/** Pure claim-conflict policy (§8): claim + fan-out are not atomic. */
export function decideRenderConflict(
  row: Pick<RenderJobRow, 'status' | 'plan'>,
): RenderClaimDecision {
  if (row.status === 'delivered' || row.status === 'rejected') return { action: 'skip', reason: 'delivered' };
  if (row.plan !== null) return { action: 'skip', reason: 'in-progress' };
  return { action: 'enqueue', reason: 'claimed-not-planned' };
}

export interface RenderJobStore {
  claim(jobKey: string, contractId: string): Promise<RenderClaimDecision>;
  get(jobKey: string): Promise<RenderJobRow | null>;
  savePlan(jobKey: string, fields: { kind: RenderKind; milestoneId: string; plan: RenderPlan }): Promise<void>;
  saveTemplateArtifact(jobKey: string, artifact: string): Promise<void>;
  /**
   * Atomically claim the completion transition (§9): flip `in_progress →
   * delivered` and return true only for the invocation that won the flip. Each
   * graphic is its own queue message, so the last two graphics of a pack can
   * both observe the full output set concurrently — only the winner calls
   * `deliverMilestone`. `outcome` stays null until `markDelivered` finalizes it,
   * so `reopenForDelivery` can undo the claim if delivery then throws.
   */
  claimForDelivery(jobKey: string): Promise<boolean>;
  /** Undo an unfinished delivery claim (delivery threw after claiming). */
  reopenForDelivery(jobKey: string): Promise<void>;
  markDelivered(jobKey: string, outcome: RenderJobOutcome): Promise<void>;
  park(jobKey: string, reason: string): Promise<void>;
  reject(jobKey: string, reason: string): Promise<void>;
  listStuckClaims(olderThan: Date): Promise<RenderJobRow[]>;
}

export function createRenderJobStore(db: D1Like, now: () => Date = () => new Date()): RenderJobStore {
  const toRow = (raw: RawRenderJobRow): RenderJobRow => ({
    jobKey: raw.job_key,
    contractId: raw.contract_id,
    kind: raw.kind,
    milestoneId: raw.milestone_id,
    plan: raw.plan_json ? (JSON.parse(raw.plan_json) as RenderPlan) : null,
    templateArtifact: raw.template_json,
    status: raw.status,
    outcome: raw.outcome,
    parkReason: raw.park_reason,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    deliveredAt: raw.delivered_at,
  });

  async function get(jobKey: string): Promise<RenderJobRow | null> {
    const raw = await db.prepare('SELECT * FROM render_jobs WHERE job_key = ?').bind(jobKey).first<RawRenderJobRow>();
    return raw ? toRow(raw) : null;
  }

  return {
    get,

    async claim(jobKey, contractId): Promise<RenderClaimDecision> {
      const ts = now().toISOString();
      try {
        await db
          .prepare('INSERT INTO render_jobs (job_key, contract_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .bind(jobKey, contractId, 'claimed', ts, ts)
          .run();
        return { action: 'enqueue', reason: 'fresh-claim' };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const row = await get(jobKey);
        if (!row) throw err;
        return decideRenderConflict(row);
      }
    },

    async savePlan(jobKey, fields): Promise<void> {
      await db
        .prepare(
          "UPDATE render_jobs SET status = 'in_progress', kind = ?, milestone_id = ?, plan_json = ?, updated_at = ? WHERE job_key = ?",
        )
        .bind(fields.kind, fields.milestoneId, JSON.stringify(fields.plan), now().toISOString(), jobKey)
        .run();
    },

    async saveTemplateArtifact(jobKey, artifact): Promise<void> {
      await db
        .prepare('UPDATE render_jobs SET template_json = ?, updated_at = ? WHERE job_key = ?')
        .bind(artifact, now().toISOString(), jobKey)
        .run();
    },

    async claimForDelivery(jobKey): Promise<boolean> {
      const result = await db
        .prepare("UPDATE render_jobs SET status = 'delivered', updated_at = ? WHERE job_key = ? AND status = 'in_progress'")
        .bind(now().toISOString(), jobKey)
        .run();
      return rowsChanged(result) === 1;
    },

    async reopenForDelivery(jobKey): Promise<void> {
      await db
        .prepare("UPDATE render_jobs SET status = 'in_progress', updated_at = ? WHERE job_key = ? AND status = 'delivered' AND outcome IS NULL")
        .bind(now().toISOString(), jobKey)
        .run();
    },

    async markDelivered(jobKey, outcome): Promise<void> {
      const ts = now().toISOString();
      await db
        .prepare("UPDATE render_jobs SET status = 'delivered', outcome = ?, delivered_at = ?, updated_at = ? WHERE job_key = ?")
        .bind(outcome, ts, ts, jobKey)
        .run();
    },

    async park(jobKey, reason): Promise<void> {
      await db
        .prepare("UPDATE render_jobs SET status = 'parked', park_reason = ?, updated_at = ? WHERE job_key = ?")
        .bind(reason, now().toISOString(), jobKey)
        .run();
    },

    async reject(jobKey, reason): Promise<void> {
      const ts = now().toISOString();
      await db
        .prepare("UPDATE render_jobs SET status = 'rejected', outcome = 'rejected', park_reason = ?, delivered_at = ?, updated_at = ? WHERE job_key = ?")
        .bind(reason, ts, ts, jobKey)
        .run();
    },

    async listStuckClaims(olderThan): Promise<RenderJobRow[]> {
      const { results } = await db
        .prepare("SELECT * FROM render_jobs WHERE status = 'claimed' AND plan_json IS NULL AND created_at < ?")
        .bind(olderThan.toISOString())
        .all<RawRenderJobRow>();
      return results.map(toRow);
    },
  };
}

// --- Per-graphic outputs (pack fan-out reconciliation) ----------------------

export interface OutputRecord {
  jobKey: string;
  graphicId: string;
  templateId: string;
  format: string;
  r2Key: string;
  url: string;
  byteLength: number;
  /** 64-bit pHash as a decimal string (bigint is not a D1 column type). */
  phash: string;
  gatePass: boolean;
}

interface RawOutputRow {
  job_key: string;
  graphic_id: string;
  template_id: string;
  format: string;
  r2_key: string;
  url: string;
  byte_length: number;
  phash: string;
  gate_pass: number;
}

export interface OutputStore {
  save(record: OutputRecord): Promise<void>;
  list(jobKey: string): Promise<OutputRecord[]>;
}

export function createOutputStore(db: D1Like, now: () => Date = () => new Date()): OutputStore {
  const toRecord = (raw: RawOutputRow): OutputRecord => ({
    jobKey: raw.job_key,
    graphicId: raw.graphic_id,
    templateId: raw.template_id,
    format: raw.format,
    r2Key: raw.r2_key,
    url: raw.url,
    byteLength: raw.byte_length,
    phash: raw.phash,
    gatePass: raw.gate_pass === 1,
  });

  return {
    async save(record): Promise<void> {
      await db
        .prepare(
          `INSERT OR REPLACE INTO render_outputs
             (job_key, graphic_id, template_id, format, r2_key, url, byte_length, phash, gate_pass, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          record.jobKey,
          record.graphicId,
          record.templateId,
          record.format,
          record.r2Key,
          record.url,
          record.byteLength,
          record.phash,
          record.gatePass ? 1 : 0,
          now().toISOString(),
        )
        .run();
    },

    async list(jobKey): Promise<OutputRecord[]> {
      const { results } = await db
        .prepare('SELECT * FROM render_outputs WHERE job_key = ? ORDER BY graphic_id')
        .bind(jobKey)
        .all<RawOutputRow>();
      return results.map(toRecord);
    },
  };
}

// --- Gate audit log (§9 evidence) -------------------------------------------

export interface AuditStore {
  record(entry: {
    scope: string;
    graphicId?: string;
    gate: string;
    result: string;
    detail?: unknown;
  }): Promise<void>;
  /**
   * Bounded retention: `gate_audit` records a row for every gate on every
   * graphic/publish and is the fastest-growing table in D1, so the daily sweep
   * prunes rows older than the cutoff. Returns the number deleted.
   */
  pruneOlderThan(cutoff: Date): Promise<number>;
}

export function createAuditStore(db: D1Like, now: () => Date = () => new Date()): AuditStore {
  return {
    async record(entry): Promise<void> {
      await db
        .prepare('INSERT INTO gate_audit (scope, graphic_id, gate, result, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(
          entry.scope,
          entry.graphicId ?? null,
          entry.gate,
          entry.result,
          entry.detail === undefined ? null : JSON.stringify(entry.detail),
          now().toISOString(),
        )
        .run();
    },

    async pruneOlderThan(cutoff): Promise<number> {
      const result = await db
        .prepare('DELETE FROM gate_audit WHERE created_at < ?')
        .bind(cutoff.toISOString())
        .run();
      return rowsChanged(result);
    },
  };
}

// --- Reputation snapshot cache (read by /health, written by the cron) -------

export async function saveReputationSnapshot(db: D1Like, snapshot: unknown, now = new Date()): Promise<void> {
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
