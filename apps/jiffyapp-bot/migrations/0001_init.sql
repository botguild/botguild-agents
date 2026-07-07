-- JiffyApp bot schema. Apply with: wrangler d1 migrations apply jiffyapp --remote
-- Shared with apps/jiffyapp-dispatch (reads tools.status by slug).

-- One row per funded work unit. job_key = sha256(contractId) + ':' + stage
-- where stage ∈ 'build' | 'cycle' | 'edit:<requestId>' (FR-15).
CREATE TABLE IF NOT EXISTS jobs (
  job_key TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('build', 'cycle', 'edit')),
  tool_id TEXT,
  gig_id TEXT,
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'parked', 'in_progress', 'delivered')),
  outcome TEXT CHECK (outcome IN ('delivered', 'aborted', 'rejected')),
  brief_json TEXT,
  goldens_json TEXT,
  park_reason TEXT,
  moderation_attempts INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT,
  spent_usd REAL NOT NULL DEFAULT 0,
  repair_rounds INTEGER NOT NULL DEFAULT 0,
  -- Random 64-hex capability token: deliverables + build-log URLs + staging slug derivation.
  -- NEVER the recomputable job_key.
  deliverable_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_tool ON jobs (tool_id);
CREATE INDEX IF NOT EXISTS idx_jobs_contract ON jobs (contract_id);

-- Proposal-time compilation, keyed by gig (exists before any contract; FR-3 persistence).
CREATE TABLE IF NOT EXISTS gig_briefs (
  gig_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('build', 'cycle')),
  template_id TEXT,
  template_version TEXT,
  tool_id TEXT,
  brief_json TEXT,
  goldens_json TEXT,
  compiled_at TEXT NOT NULL
);

-- Tool registry (FR-7/FR-13). status is read by jiffyapp-dispatch.
CREATE TABLE IF NOT EXISTS tools (
  tool_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  build_contract_id TEXT NOT NULL,
  build_gig_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'live', 'grace', 'suspended', 'killed')),
  hosted_until TEXT,
  grace_started_at TEXT,
  latest_hosting_contract_id TEXT,
  brief_json TEXT NOT NULL,
  goldens_json TEXT NOT NULL,      -- CURRENT golden set (edits update it)
  slots_json TEXT,                 -- current slot values (edits start from these)
  notify_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tools_status ON tools (status);
CREATE INDEX IF NOT EXISTS idx_tools_build_contract ON tools (build_contract_id);

-- One row per funded hosting month (FR-13).
CREATE TABLE IF NOT EXISTS hosting_cycles (
  contract_id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  report_delivered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cycles_tool ON hosting_cycles (tool_id);
CREATE INDEX IF NOT EXISTS idx_cycles_open ON hosting_cycles (report_delivered_at, window_end);

-- Edit requests, keyed by thread message id (FR-14 per-request idempotency).
CREATE TABLE IF NOT EXISTS edit_requests (
  request_id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'held', 'done', 'failed')),
  -- (scope, period) of the usage_counters reservation this request consumed, so a failed
  -- edit releases exactly the row it reserved (cycle boundaries can't misroute the release).
  quota_scope TEXT,
  quota_period TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edit_requests_tool ON edit_requests (tool_id);

-- Atomic reservation counters (ThumbForge pattern). scope examples:
-- 'edit:<toolId>' period = hosting-cycle contractId (quota is per funded cycle, NOT calendar month)
-- | 'relay-min:<toolId>' period 'YYYYMMDDHHMM' | 'relay-day:<toolId>' period 'YYYYMMDD'.
CREATE TABLE IF NOT EXISTS usage_counters (
  scope TEXT NOT NULL,
  period TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, period)
);

-- Form relay state (FR-12): per-tool signed token, double-opt-in recipient.
CREATE TABLE IF NOT EXISTS relay (
  tool_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  recipient TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL
);

-- Relay delivery metadata only (30-day retention; never message bodies).
CREATE TABLE IF NOT EXISTS relay_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('verification', 'submission', 'test')),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_events_tool ON relay_events (tool_id);

-- Build-log events, keyed by the job's deliverable_token (FR-11).
CREATE TABLE IF NOT EXISTS build_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  seq INTEGER NOT NULL,
  stage TEXT NOT NULL,
  message TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_build_log_token ON build_log (token, seq);

-- Every gate decision / deploy / promotion / relay event (FR-17; report generated from records).
CREATE TABLE IF NOT EXISTS gate_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,             -- 'job:<jobKey>' | 'gig:<gigId>' | 'tool:<toolId>'
  gate TEXT NOT NULL,
  result TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gate_audit_scope ON gate_audit (scope);

CREATE TABLE IF NOT EXISTS abuse_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

-- DLQ arrivals (surfaced on /health as dlqDepth).
CREATE TABLE IF NOT EXISTS dlq_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue TEXT NOT NULL,
  body_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reputation_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Owned by @botguild/agent-core-workers (also self-created lazily with identical DDL);
-- included so a fresh database is complete after migrations alone.
CREATE TABLE IF NOT EXISTS webhook_secret (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret TEXT NOT NULL,
  webhook_id TEXT,
  captured_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS negotiation_countered (
  proposal_id TEXT PRIMARY KEY,
  countered_at TEXT NOT NULL
);
