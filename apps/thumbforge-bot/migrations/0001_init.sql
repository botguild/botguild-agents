-- ThumbForge D1 schema (PRD §7/§8).
-- Apply with: wrangler d1 migrations apply thumbforge --remote
--
-- The `webhook_secret` and `negotiation_countered` tables are owned by
-- @botguild/agent-core-workers, which also self-creates them lazily
-- (CREATE TABLE IF NOT EXISTS with identical DDL) — included here so a fresh
-- database is complete after migrations alone. Everything cap/count-relevant
-- lives in D1, never KV (§12 consistency discipline).

-- FR-3 idempotency claims — the atomic usage-count guard for the OG sync path.
-- key = sha256(page_url + title + content_hash_fields). The INSERT … 'pending'
-- wins or conflicts atomically; url + billed_at are written ONLY at successful
-- delivery, so a failed first attempt never wedges the page version.
CREATE TABLE IF NOT EXISTS idempotency_claims (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  offer_id TEXT NOT NULL,
  page_url TEXT NOT NULL,
  url TEXT,
  billed_at TEXT,
  claimed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_page_url ON idempotency_claims (page_url);

-- Per-offer CMS signing secrets + the armed OG route's contract and monthly cap
-- (FR-2). The secret is generated at arm time (milestone.funded) and handed to
-- the buyer via the drop-in signing snippet. Per-offer because wrangler secrets
-- are per-deployment static (§7).
CREATE TABLE IF NOT EXISTS cms_secrets (
  offer_id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  cap INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-offer monthly render counts (FR-15). period = 'YYYY-MM' (UTC). Over-cap
-- requests are held with a top-up prompt — never metered.
CREATE TABLE IF NOT EXISTS usage_counters (
  offer_id TEXT NOT NULL,
  period TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (offer_id, period)
);

-- Async gig state (social packs, A/B thumbnails). job_key = sha256(contractId)
-- (the milestone.funded payload has no milestoneId). plan_json holds the
-- fully-resolved per-graphic render plan so the queue consumer needs no re-fetch;
-- template_json is the editable Satori template artifact delivered at completion.
CREATE TABLE IF NOT EXISTS render_jobs (
  job_key TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('social_pack', 'thumbnail')),
  milestone_id TEXT,
  plan_json TEXT,
  template_json TEXT,
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'in_progress', 'delivered', 'parked', 'rejected')),
  outcome TEXT CHECK (outcome IN ('delivered', 'rejected', 'aborted')),
  park_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs (status);

-- One row per rendered graphic (the pack fan-out reconciliation input, FR-13).
-- phash is the 64-bit pHash as a decimal string (bigint is not a D1 type) —
-- the A/B distinctness gate compares the two stored hashes at completion.
CREATE TABLE IF NOT EXISTS render_outputs (
  job_key TEXT NOT NULL,
  graphic_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  format TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  url TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  phash TEXT NOT NULL,
  gate_pass INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_key, graphic_id)
);

-- Gate audit log (§9/§12 evidence): every gate outcome with its measured value,
-- idempotency-claim results, probe evidence, and usage-count events. scope is
-- the job_key or idempotency key the entry belongs to.
CREATE TABLE IF NOT EXISTS gate_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  graphic_id TEXT,
  gate TEXT NOT NULL,
  result TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gate_audit_scope ON gate_audit (scope);

-- Reputation snapshot cache — written by the */10 cron sweep, read by
-- GET /health (no timers survive Workers invocations).
CREATE TABLE IF NOT EXISTS reputation_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Owned by @botguild/agent-core-workers (webhookSecretStore.ts). The
-- platform-issued webhook signing secret is captured once at registration and
-- must survive redeploys.
CREATE TABLE IF NOT EXISTS webhook_secret (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret TEXT NOT NULL,
  webhook_id TEXT,
  captured_at TEXT NOT NULL
);

-- Owned by @botguild/agent-core-workers (negotiationStore.ts). "Counter once"
-- negotiation memory, hydrated per cron sweep.
CREATE TABLE IF NOT EXISTS negotiation_countered (
  proposal_id TEXT PRIMARY KEY,
  countered_at TEXT NOT NULL
);
