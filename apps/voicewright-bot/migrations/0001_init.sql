-- VoiceWright D1 schema (PRD §7/§8).
-- Apply with: wrangler d1 migrations apply voicewright --remote
--
-- The `webhook_secret` and `negotiation_countered` tables are owned by
-- @botguild/agent-core-workers, which also self-creates them lazily
-- (CREATE TABLE IF NOT EXISTS with identical DDL) — included here so a fresh
-- database is complete after migrations alone.

-- Jobs + idempotency claims. job_key = sha256(contractId) (FR-13: the
-- milestone.funded payload carries no milestoneId). The UNIQUE primary key is
-- the idempotency claim; checkpoint_json holds the resumable per-variant
-- pipeline state and spend accounting (FR-5 caps survive queue retries).
CREATE TABLE IF NOT EXISTS jobs (
  job_key TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'parked', 'in_progress', 'delivered')),
  -- Terminal disposition, set when status becomes 'delivered':
  -- delivered | partial | aborted | rejected (§9 non-convergence outcomes).
  outcome TEXT,
  kind TEXT CHECK (kind IN ('adcopy', 'refresh', 'readability')),
  gig_id TEXT,
  brief_json TEXT,
  park_reason TEXT,
  moderation_attempts INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT,
  spent_usd REAL NOT NULL DEFAULT 0,
  batch_rounds INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);

-- Stored recurring briefs (FR-10). brief_id is issued at first delivery and
-- pasted by the buyer into each refresh gig description.
CREATE TABLE IF NOT EXISTS briefs (
  brief_id TEXT PRIMARY KEY,
  origin_contract_id TEXT NOT NULL,
  brief_json TEXT NOT NULL,
  cycle INTEGER NOT NULL DEFAULT 1,
  next_due_at TEXT,
  last_nudged_cycle INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Prior-cycle delivered variants — input to the deterministic
-- differs-from-prior-cycle gate (§9).
CREATE TABLE IF NOT EXISTS cycle_variants (
  brief_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  variant_id TEXT NOT NULL,
  angle TEXT NOT NULL,
  headline TEXT NOT NULL,
  primary_text TEXT NOT NULL,
  description TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (brief_id, cycle, variant_id)
);

-- Gate audit log (FR-11): every moderation/policy/gate decision, including the
-- full moderation verdict snapshots (§9), retained for the warranty window and
-- dispute evidence. detail_json carries the full record (vendor verdicts,
-- grapheme counts, checklist failures, diversity scores).
CREATE TABLE IF NOT EXISTS gate_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key TEXT NOT NULL,
  variant_id TEXT,
  gate TEXT NOT NULL,
  result TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gate_audit_job ON gate_audit (job_key);

-- Reputation snapshot cache — written by the 15-min cron sweep, read by
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
