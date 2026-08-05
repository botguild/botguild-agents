-- LogoSmith D1 schema (PRD §7/§8).
-- Apply with: wrangler d1 migrations apply logosmith --remote
--
-- The `webhook_secret` and `negotiation_countered` tables are owned by
-- @botguild/agent-core-workers, which also self-creates them lazily
-- (CREATE TABLE IF NOT EXISTS with identical DDL) — included here so a fresh
-- database is complete after migrations alone.

-- Jobs + per-stage idempotency claims. job_key = sha256(contractId) + ':' +
-- stage, where stage is concepts | vector | single (FR-15: the
-- milestone.funded payload carries no milestoneId, and stage 2 is triggered by
-- selection/acceptance rather than funding). The PRIMARY KEY is the claim.
-- checkpoint_json holds the resumable per-slot state and spend accounting, so
-- FR-5 caps survive queue retries.
CREATE TABLE IF NOT EXISTS jobs (
  job_key TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('concepts', 'vector', 'single')),
  -- Unguessable capability token for deliverable URLs and the progress page
  -- (§12). NOT derived from contract_id.
  deliverable_token TEXT,
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'parked', 'in_progress', 'delivered')),
  -- Terminal disposition when status becomes 'delivered':
  -- delivered | partial | aborted | rejected (§9 non-convergence outcomes).
  outcome TEXT,
  kind TEXT CHECK (kind IN ('logo', 'favicon', 'taster')),
  gig_id TEXT,
  payer_id TEXT,
  brief_json TEXT,
  park_reason TEXT,
  moderation_attempts INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT,
  spent_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_contract ON jobs (contract_id);
-- The public progress page resolves jobs by capability token on every request.
CREATE INDEX IF NOT EXISTS idx_jobs_token ON jobs (deliverable_token);

-- One row per generated concept. Survives beyond the checkpoint because the
-- selection state machine and the M2 report both read it after stage 1 ends.
CREATE TABLE IF NOT EXISTS concepts (
  contract_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  axis_id TEXT NOT NULL,
  vendor TEXT NOT NULL,
  vendor_request_id TEXT,
  r2_key TEXT,
  -- 16-hex string form of the 64-bit pHash (FR-6).
  phash TEXT,
  ocr_transcription TEXT,
  ocr_score REAL,
  ocr_model TEXT,
  ocr_pass INTEGER NOT NULL DEFAULT 0,
  attempts_used INTEGER NOT NULL DEFAULT 0,
  -- R2 key of the sanitized Recraft-native SVG, when the vendor returned one.
  -- Stage 2 reads this to skip Vectorizer.ai entirely (the §13 mitigation).
  native_svg_key TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (contract_id, slot)
);

-- Selection state machine (FR-9). One row per contract, created at M1 delivery.
CREATE TABLE IF NOT EXISTS selection (
  contract_id TEXT PRIMARY KEY,
  state TEXT NOT NULL
    CHECK (state IN ('concepts_delivered', 'winner_selected', 'pack_delivered')),
  winner_slot INTEGER,
  source TEXT CHECK (source IN ('buyer', 'default')),
  m1_delivered_at TEXT NOT NULL,
  selected_at TEXT,
  updated_at TEXT NOT NULL
);

-- Free-gig quota (FR-14): a D1 hard count per payer. KV throttles are advisory
-- only and never authoritative.
CREATE TABLE IF NOT EXISTS free_gig_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payer_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('favicon', 'taster')),
  contract_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_free_gig_payer ON free_gig_usage (payer_id, created_at);

-- Per-image licensing provenance (§8, §14): vendor + request id + terms scope,
-- assembled into the delivered license manifest.
CREATE TABLE IF NOT EXISTS license_manifest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  artifact TEXT NOT NULL,
  vendor TEXT NOT NULL,
  vendor_request_id TEXT,
  terms_scope TEXT NOT NULL,
  terms_verified_on TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_license_contract ON license_manifest (contract_id);

-- One-shot dispute-response claim (§10.9): the MCP dispute response must fire
-- exactly once per contract even when dispute webhooks are redelivered.
CREATE TABLE IF NOT EXISTS dispute_responses (
  contract_id TEXT PRIMARY KEY,
  responded_at TEXT NOT NULL
);

-- Gate audit log (FR-17): every gate decision, cap counter, and selection
-- event, retained for the warranty window and dispute evidence.
CREATE TABLE IF NOT EXISTS gate_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key TEXT NOT NULL,
  contract_id TEXT,
  slot INTEGER,
  gate TEXT NOT NULL,
  result TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gate_audit_job ON gate_audit (job_key);

-- Reputation snapshot cache — written by the 15-min cron, read by GET /health.
CREATE TABLE IF NOT EXISTS reputation_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Owned by @botguild/agent-core-workers (webhookSecretStore.ts).
CREATE TABLE IF NOT EXISTS webhook_secret (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret TEXT NOT NULL,
  webhook_id TEXT,
  captured_at TEXT NOT NULL
);

-- Owned by @botguild/agent-core-workers (negotiationStore.ts).
CREATE TABLE IF NOT EXISTS negotiation_countered (
  proposal_id TEXT PRIMARY KEY,
  countered_at TEXT NOT NULL
);
