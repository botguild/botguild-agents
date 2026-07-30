# LogoSmith Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the LogoSmith bot per `docs/prds/logosmith.md`: a single Cloudflare Worker (`apps/logosmith-bot`) that turns a brand name + industry into three OCR-verified, pairwise-distinct logo concepts, then delivers the buyer-selected winner as a true-vector pack (SVG + PNG masters + full favicon set + brand metadata), every gate machine-evaluated and evidenced.

**Architecture:** One Worker on the proven `@botguild/agent-core-workers` shim (Hono fetch + Queue consumer + 2 crons), same lifecycle VoiceWright runs live: webhook ack → D1 stage claim → Queue consumer, cron-driven gig poller (there is no `gig.posted` webhook), poll-only negotiation, handler-scoped event self-filtering. Image *generation* is external APIs (Ideogram 3.0 for lettering-heavy axes, Recraft V3 for the vector-native axis, Vectorizer.ai for non-Recraft winners); everything else — renders, mono trace, ICO, palette, ZIP, and every gate — runs in-isolate as WASM/TS with no container and no headless browser. The contract is **one single-price escrow with two milestone checkpoints**: M1 three passing concepts, M2 the winner's pack, with selection collected from the cron-polled contract thread under a default-selection rule so the contract can never stall on silence.

**Tech Stack:** TypeScript (NodeNext), Hono, `@botguild/agent-core` + `@botguild/agent-core-workers` (both unmodified), `@botguild/sdk`, `@anthropic-ai/sdk` ^0.51.0 (Haiku: axis prompts, cover notes, delivery notes), Workers AI (`AI` binding — Llama 4 Scout vision for the OCR gate, FLUX.2 [klein] for the free taster), `@resvg/resvg-wasm` ^2.6.2, `esm-potrace-wasm`, `@cf-wasm/photon`, `svgo`, `fflate`, D1/KV/R2/Queues, OpenAI Moderation (pinned), Google Fonts API, `node:test` via tsx (NO vitest, NO miniflare).

## Global Constraints

Copied from `docs/prds/logosmith.md` and the fleet conventions established by VoiceWright, ThumbForge, and JiffyApp. Every task's requirements implicitly include this section.

- **Node ≥22, pnpm 9.15.0, Turborepo.** The new app is picked up by root `pnpm build/typecheck/test/lint` automatically. Do NOT add docker-compose or docker-build CI entries — Workers apps deploy via wrangler, not Fly.
- **Tests are `node:test` via tsx** (script: `"test": "tsx --test src/**/*.test.ts"`). No vitest, no miniflare. Workers bindings are consumed through structural interfaces (`D1Like`, `KVLike` from the shim; `AiLike`, `VendorLike`, `FetchLike`, `R2PutLike`, `QueueLike` defined in this app) so every module except `src/index.ts` is Node-testable. **`src/index.ts` is the ONLY module that touches real bindings.**
- **`module: NodeNext`** — every relative import carries a `.js` extension (`import { x } from './config.js'`).
- **tsconfig** extends `../../tsconfig.base.json` with `"types": ["@cloudflare/workers-types", "node"]`, `rootDir: ./src`, `outDir: ./dist`, and project references to `../../packages/agent-core` and `../../packages/agent-core-workers`.
- **Package naming:** `@botguild/logosmith-bot`, `"private": true`, `"version": "0.1.0"`, `"type": "module"`. Workspace deps as `"workspace:*"`. Caret pins by default; add new deps with `pnpm --filter @botguild/logosmith-bot add <pkg>` and commit the resolved caret rather than hand-writing a version.
- **Zero shim modifications and zero `agent-core` modifications** (PRD §15 success metric: "zero shim modifications required"). If a task appears to need one, stop and escalate.
- **`compatibility_date: "2026-06-01"`**, `"$schema": "node_modules/wrangler/config-schema.json"`, `compatibility_flags: ["nodejs_compat"]` (required by agent-core's Buffer use), `observability: { enabled: true }`, placeholder ids marked `⚠️ REPLACE`.
- **The platform webhook signing secret lives in D1** (captured by `ensureRegisteredWorkers` with an awaited write + read-back), never in wrangler secrets.
- **Never expose recomputable keys.** `jobKey = sha256(contractId)` is an idempotency key only. Everything publicly reachable — deliverable URLs *and* the progress page — derives from a per-job random 64-hex `deliverable_token` (the VoiceWright migration-0002 lesson).
- **Stage-suffixed claims.** Claim key = `sha256(contractId) + ':' + stage` where stage ∈ `concepts` | `vector` | `single`. The `milestone.funded` payload carries **no** milestone id; milestone ids for both deliveries are fetched via REST off the contract.
- **Webhooks are handler-scoped:** every contract-scoped handler self-filters with `withOwnershipFilter` / `isOwnContract`. Sibling bots' events WILL arrive at this endpoint.
- **KV is advisory only** (poller seen-ids, throttles). All correctness state — claims, caps, counters, free-gig quotas, selection — is D1 with unique-constraint INSERT / conditional-UPDATE atomicity.
- **Moderation fails closed:** pinned vendor OpenAI Moderation. Outage ⇒ `park(jobKey, 'moderation_outage')` + cron re-enqueue, thread notice after 3 attempts. Never skipped, never a pass on error. Never generate from an unscreened brief.
- **Hard caps (FR-5):** ≤2 regenerations per concept slot, ≤$2.50 image-API spend per job. Cap state lives in the D1 checkpoint so queue retries resume against the *remaining* budget, never restart it.
- **Numeric defaults are provisional until Phase 2 calibration** (PRD §9): OCR normalized-similarity ≥ 0.85, pHash Hamming ≥ 10, free-gig cap 3 per payer per rolling 30 days, stuck-claim sweep 30 minutes, queue `max_batch_size: 1` / `max_retries: 3` + DLQ. They live as named constants in `config.ts` marked `PROVISIONAL`.
- **Gate wording is contractual and deliberately honest.** Never claim trademark clearance, never claim aesthetic quality, never claim "Meta/registry approval". The warranty covers the OCR readback threshold, the true-vector parse, byte-verified dimensions, and ZIP integrity — nothing else.
- **Non-convergence is a contractual outcome, not an exception** (§9): 2-of-3 passing ⇒ deliver the pair with the shortfall itemized; <2 passing ⇒ deliver nothing, post itemized evidence to the thread, and **request** payer cancellation. Bot-side refund does not exist on the platform — gig terms say "request", never "initiate".
- **Latin script only in v1.** Intake validation skips non-Latin briefs at proposal time so un-intakeable work is never won.
- **Deliverables are Worker-served** (`/deliverables/:token/:file`) on the custom domain, never `r2.dev`, with a restrictive CSP and `Content-Disposition: attachment`.
- **Reused-with-attribution from ThumbForge** (structural decision, approved): `src/gates/phash.ts` and the `render/wasm.ts` + `wasm.node.ts` dual-source WASM-init pattern are adapted from `apps/thumbforge-bot`. Copy them with a header comment naming the source file; do NOT edit ThumbForge, and do NOT extract a shared package in v1. Extraction trigger: a third bot needing the same imaging primitives.
- **Branch/commits:** work on branch `logosmith` cut from `develop`. Conventional commits (`feat(logosmith): …`), one commit per task, each ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Run tests as:** `pnpm -w build && cd apps/logosmith-bot && pnpm test` (turbo `test` depends on `^build`; workspace imports resolve to `dist/`).
- **Out of code scope (ops — documented in the README only):** Phase 0 vendor commercial/resale terms verification + API keys (Ideogram, Recraft, Vectorizer.ai, FLUX.2 [klein] hosted outputs), the Vectorizer.ai plan purchase, the Google Fonts API key, the custom domain + route, listing the seed gig, and running the Phase 2 calibration to freeze the provisional thresholds.

---

## File Structure

```
apps/logosmith-bot/
  package.json  tsconfig.json  wrangler.jsonc  .dev.vars.example  README.md
  migrations/0001_init.sql     # jobs+claims, concepts, gate_audit, free_gig_usage,
                               #  license_manifest, reputation_snapshot + 2 shim tables
  src/index.ts                 # ONLY binding-touching module: Env, service graph,
                               #  routes, scheduled, queue; AI/R2/Queue adapters
  src/config.ts                # botProfile, scorerConfig, rateCard, pricingCalc,
                               #  caps, PROVISIONAL thresholds, model ids
  src/types.ts                 # LogoBrief, FaviconBrief, Concept, ConceptState,
                               #  JobCheckpoint, statuses, JobMessage
  src/brief.ts                 # fenced-JSON extraction, validation, Latin-script
                               #  check, logoUrl guard policy
  src/jobs.ts                  # D1: stage claims, checkpoints, concepts, selection
                               #  state machine, free-gig counters, audit
  src/threads.ts               # contract-thread reader + selection parsing
  src/moderation.ts            # pinned OpenAI Moderation, fail-closed
  src/axes.ts                  # Haiku → 3 declared distinct style axes
  src/generate.ts              # VendorLike adapters: Ideogram, Recraft, FLUX klein
  src/vectorize.ts             # Recraft-native | Vectorizer.ai → SVGO
  src/report.ts                # JSON validation report + license manifest
  src/progress.ts              # /p/:token page body + SSE frame builder
  src/pipeline.ts              # stage 1 (concepts→M1) + stage 2 (selection→pack→M2)
  src/sweeps.ts                # 15-min + daily cron sweeps
  src/testSupport.ts           # applyMigrations (node-only)
  src/gates/index.ts
  src/gates/ocr.ts             # Scout transcription + NFKC normalize + fuzzy match
  src/gates/phash.ts           # 64-bit 8x8 DCT pHash + Hamming (from ThumbForge)
  src/gates/dimensions.ts      # PNG IHDR byte-read dimension check
  src/gates/vector.ts          # true-vector parse gate + SVG sanitization
  src/gates/ico.ts             # ICO parse-back
  src/gates/zip.ts             # ZIP completeness
  src/pack/wasm.ts             # memoized once-per-isolate wasm init (source-injected)
  src/pack/wasm.node.ts        # Node-only wasm sources for tests
  src/pack/render.ts           # resvg renders at exact per-size targets
  src/pack/mono.ts             # photon threshold + potrace trace
  src/pack/ico.ts              # TS ICONDIR + PNG-entry assembly
  src/pack/palette.ts          # frequency-quantized swatch extraction
  src/pack/fonts.ts            # Google Fonts pairing (advisory)
  src/pack/zip.ts              # fflate ZIP + webmanifest + HTML snippet
  src/pack/index.ts            # buildPack orchestration
  src/calibration/harness.ts   # golden-set runner (OCR correctness/repeatability)
  src/calibration/goldens.json # ≥30-name golden set fixture
```

**Dependency direction:** `gates/*` and `pack/*` are leaf modules — they import only `types.ts`, `config.ts` (threshold/size constants), and their WASM/pure-JS libraries, never `jobs.ts`, `generate.ts`, or `index.ts`. `pipeline.ts` orchestrates and is injected with everything. `index.ts` builds the graph. This keeps every gate unit-testable with no bindings and no network.

---

## Phase A — Skeleton

### Task 1: App scaffold — package, wrangler, migrations, types, config

**Files:**
- Create: `apps/logosmith-bot/package.json`
- Create: `apps/logosmith-bot/tsconfig.json`
- Create: `apps/logosmith-bot/wrangler.jsonc`
- Create: `apps/logosmith-bot/.dev.vars.example`
- Create: `apps/logosmith-bot/migrations/0001_init.sql`
- Create: `apps/logosmith-bot/src/types.ts`
- Create: `apps/logosmith-bot/src/config.ts`
- Create: `apps/logosmith-bot/src/testSupport.ts`
- Create: `apps/logosmith-bot/src/brief.ts` — **inert stub only** (`parseFaviconBrief` always `{ok:false}`, `BriefResult<T>` shape per Task 2's contract): config.ts imports it, so Task 1 cannot build without it. Task 2 overwrites it wholesale — its RED evidence is failing assertions, not a missing module.
- Create: `apps/logosmith-bot/src/index.ts` — **bare 501 stub**: wrangler `main` points here and Step 10's dry-run must pass. Task 12 replaces it.
- Test: `apps/logosmith-bot/src/config.test.ts`

**Interfaces:**
- Consumes: `BotConfig`, `Gig`, `ProposalMilestone`, `RateCard`, `ResourceEstimate`, `ScorerConfig` from `@botguild/agent-core`; `D1Like` from `@botguild/agent-core-workers`.
- Produces: `botProfile`, `scorerConfig`, `rateCard`, `fallbackEstimate`, `pricingCalc(gig)`, and the constants `SEED_PRICE_USD`, `MAX_REGENS_PER_SLOT`, `MAX_SPEND_USD`, `OCR_SIMILARITY_THRESHOLD`, `MIN_PHASH_HAMMING`, `FREE_GIGS_PER_PAYER`, `FREE_GIG_WINDOW_DAYS`, `STUCK_CLAIM_MINUTES`, `MODERATION_ATTEMPTS_BEFORE_NOTICE`, `SCOUT_MODEL_ID`, `FLUX_MODEL_ID`, `HAIKU_MODEL_ID`, `CONCEPT_COUNT`; types `LogoBrief`, `FaviconBrief`, `Concept`, `ConceptState`, `JobCheckpoint`, `JobStage`, `JobStatus`, `JobOutcome`, `JobMessage`, `SelectionSource`; `applyMigrations(db)`.

- [ ] **Step 1: Create the workspace package**

`apps/logosmith-bot/package.json`:

```json
{
  "name": "@botguild/logosmith-bot",
  "version": "0.1.0",
  "private": true,
  "description": "LogoSmith — OCR-proven logo concepts and true-vector brand packs as a pure Cloudflare Worker (Hono fetch + Queues + Cron Triggers + D1/KV/R2 + Workers AI).",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "tsx --test src/**/*.test.ts",
    "lint": "eslint . --max-warnings=0"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.51.0",
    "@botguild/agent-core": "workspace:*",
    "@botguild/agent-core-workers": "workspace:*",
    "@resvg/resvg-wasm": "^2.6.2",
    "hono": "^4.12.23"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250620.0",
    "@types/node": "^22.0.0",
    "pino": "^9.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "wrangler": "^4.107.0"
  }
}
```

`apps/logosmith-bot/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "types": ["@cloudflare/workers-types", "node"]
  },
  "references": [
    { "path": "../../packages/agent-core" },
    { "path": "../../packages/agent-core-workers" }
  ],
  "include": ["src"]
}
```

- [ ] **Step 2: Add the remaining runtime dependencies**

The WASM/vector libraries are new to this repo — let pnpm resolve and pin them rather than hand-writing versions:

```bash
pnpm --filter @botguild/logosmith-bot add esm-potrace-wasm @cf-wasm/photon svgo fflate
pnpm install
```

Confirm the four carets landed in `apps/logosmith-bot/package.json` under `dependencies` and commit the lockfile change with this task.

- [ ] **Step 3: Write `wrangler.jsonc`**

```jsonc
// LogoSmith Worker configuration (PRD §7).
//
// Placeholder ids (marked ⚠️ REPLACE) must be filled in from `wrangler d1
// create` / `wrangler kv namespace create` output before a real deploy;
// `wrangler deploy --dry-run` works with the placeholders.
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "logosmith-bot",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  // Required by agent-core's Buffer use (client.ts data:-URL attachments).
  "compatibility_flags": ["nodejs_compat"],

  "vars": {
    // ⚠️ REPLACE with the deployed Worker's public URL (evidence links,
    // progress page, webhook registration).
    "WEBHOOK_BASE_URL": "https://logosmith-bot.example.workers.dev"
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "logosmith",
      // ⚠️ REPLACE with the id from `wrangler d1 create logosmith`.
      "database_id": "00000000-0000-0000-0000-000000000000"
    }
  ],

  "kv_namespaces": [
    {
      "binding": "CACHE",
      // ⚠️ REPLACE with the id from `wrangler kv namespace create CACHE`.
      "id": "00000000000000000000000000000000"
    }
  ],

  "r2_buckets": [{ "binding": "DELIVERABLES", "bucket_name": "logosmith-deliverables" }],

  // Workers AI: Llama 4 Scout vision (OCR gate) + FLUX.2 [klein] (free taster).
  // Account binding — no API key.
  "ai": { "binding": "AI" },

  "queues": {
    "producers": [{ "binding": "JOBS", "queue": "logosmith-jobs" }],
    "consumers": [
      {
        "queue": "logosmith-jobs",
        // One job stage per invocation — pixmap work is memory-bound (§12).
        "max_batch_size": 1,
        // Transient errors only; vendor outages park in D1 instead of
        // burning retries (FR-2).
        "max_retries": 3,
        "dead_letter_queue": "logosmith-jobs-dlq"
      },
      {
        // DLQ consumer: one operator alert per poisoned message (§12 runbook —
        // replay by re-enqueueing to logosmith-jobs; claims make it safe).
        "queue": "logosmith-jobs-dlq",
        "max_batch_size": 10,
        "max_retries": 0
      }
    ]
  },

  "triggers": {
    // */15: gig-poll + negotiation + thread-selection poll + parked re-enqueue
    //        + reputation refresh. 0 6: stuck-claim sweep.
    "crons": ["*/15 * * * *", "0 6 * * *"]
  },

  "observability": { "enabled": true }

  // Secrets (via `wrangler secret put <NAME>`; see .dev.vars.example):
  //   BOTGUILD_API_URL, BOTGUILD_API_KEY, BOTGUILD_BOT_ID, ANTHROPIC_API_KEY,
  //   MODERATION_API_KEY, IDEOGRAM_API_KEY, RECRAFT_API_KEY,
  //   VECTORIZER_AI_TOKEN, GOOGLE_FONTS_API_KEY, ADMIN_TOKEN
  // The platform-issued webhook signing secret is NOT a wrangler secret — it is
  // captured at registration and persisted in D1 (§10.2).
}
```

`apps/logosmith-bot/.dev.vars.example`:

```
BOTGUILD_API_URL=https://api.botguild.ai
BOTGUILD_API_KEY=
BOTGUILD_BOT_ID=bot-logosmith
ANTHROPIC_API_KEY=
MODERATION_API_KEY=
IDEOGRAM_API_KEY=
RECRAFT_API_KEY=
VECTORIZER_AI_TOKEN=
GOOGLE_FONTS_API_KEY=
ADMIN_TOKEN=
```

- [ ] **Step 4: Write the D1 schema**

`apps/logosmith-bot/migrations/0001_init.sql`:

```sql
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
```

- [ ] **Step 5: Write `src/types.ts`**

```typescript
// Domain types shared across the pipeline. Kept free of Workers globals so
// every gate module and test can import them under plain Node.

/** The fenced-JSON logo brief embedded in a gig description (PRD §8). */
export interface LogoBrief {
  brandName: string;
  industry: string;
  brief?: string;
  palettePreference?: string[];
  avoid?: string[];
  script?: string;
}

/** The FREE favicon gig's brief: one existing logo to repackage. */
export interface FaviconBrief {
  logoUrl: string;
}

export type JobKind = 'logo' | 'favicon' | 'taster';
export type JobStage = 'concepts' | 'vector' | 'single';
export type JobStatus = 'claimed' | 'parked' | 'in_progress' | 'delivered';
export type JobOutcome = 'delivered' | 'partial' | 'aborted' | 'rejected';
export type SelectionSource = 'buyer' | 'default';

/** A declared style axis compiled from the brief (FR-3). */
export interface StyleAxis {
  id: string;
  label: string;
  prompt: string;
  /** Which vendor this axis routes to (FR-4). */
  vendor: 'ideogram' | 'recraft' | 'flux';
}

/** Decoded RGBA raster. Width/height are the authoritative pixel dimensions. */
export interface Pixmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** One generated concept and its provenance. */
export interface Concept {
  slot: number;
  axisId: string;
  vendor: string;
  vendorRequestId?: string;
  png: Uint8Array;
  /** Vendor RNG seed when returned (Ideogram does) — makes a concept
   *  reproducible; recorded in the gate audit detail, not its own column. */
  seed?: number;
  /** Present when the vendor returned a native vector export (Recraft). */
  nativeSvg?: string;
}

/** The OCR readback verdict, snapshotted at delivery time (FR-5). */
export interface OcrVerdict {
  model: string;
  transcription: string;
  score: number;
  pass: boolean;
  unsafe: boolean;
  checkedAt: string;
}

export type ConceptStatus = 'pending' | 'passed' | 'failed';

/** Per-slot checkpoint entry persisted to D1 after every gate step. */
export interface ConceptState {
  slot: number;
  axis: StyleAxis;
  status: ConceptStatus;
  attempts: number;
  phash?: string;
  ocr?: OcrVerdict;
  r2Key?: string;
  vendorRequestId?: string;
  failReason?: string;
}

/** The resumable job checkpoint (FR-5: caps survive queue retries). */
export interface JobCheckpoint {
  slots: ConceptState[];
  spendUsd: number;
}

export interface JobMessage {
  contractId: string;
  jobKey: string;
  stage: JobStage;
}

// --- Binding-shaped structural interfaces ------------------------------------
// Declared here, in the one module with no dependencies of its own, so that
// gates/* and pack/* stay leaf modules: a gate must never import from
// generate.ts just to name the type of a binding it was handed.

/** The subset of `fetch` every network-touching module consumes. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The subset of the Workers AI binding this app uses. */
export interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
```

- [ ] **Step 6: Write `src/config.ts`**

```typescript
// ---------------------------------------------------------------------------
// LogoSmith configuration — bot identity, gig scoring, pricing anchors, and the
// hard caps and gate thresholds from PRD FR-5/FR-6/FR-14/§9.
// ---------------------------------------------------------------------------

import type {
  BotConfig,
  Gig,
  ProposalMilestone,
  RateCard,
  ResourceEstimate,
  ScorerConfig,
} from '@botguild/agent-core';
import { parseFaviconBrief } from './brief.js';

// --- Bot profile (registerBot) ----------------------------------------------
export const botProfile: BotConfig = {
  handlerId: 'bot-logosmith',
  name: 'LogoSmith',
  category: 'Design / Brand Identity',
  bio:
    'AI logos that can actually spell your name: three stylistically distinct concepts whose ' +
    'lettering is OCR-verified to read back as your brand, then the winner delivered as a true ' +
    'vector pack — SVG with zero embedded rasters, colour and mono masters, a full favicon set ' +
    'with favicon.ico and webmanifest, extracted brand hex codes, and a license-clean font pairing.',
  workingStyle: 'checkpoints',
  valueChainPosition: 'originator',
  toolchain: ['ideogram-3.0', 'recraft-v3', 'llama-4-scout', 'claude-haiku-4-5', 'resvg-wasm'],
  // §9 wording: readback threshold, vector parse, byte-verified dimensions,
  // ZIP integrity. NEVER trademark, NEVER taste.
  warrantyTerms:
    'For 14 days after delivery: any delivered concept whose lettering fails the stated OCR ' +
    'readback threshold as delivered, a logo.svg that does not pass the true-vector parse, any ' +
    'artifact at the wrong pixel dimensions, or a broken or incomplete ZIP is re-run free of ' +
    'charge, plus one revision round on the selected mark. Trademark clearance is NOT performed ' +
    'and NOT warranted.',
};

// --- Gig scoring -------------------------------------------------------------
export const scorerConfig: ScorerConfig = {
  categories: ['Design / Brand Identity', 'Design', 'Brand Identity', 'Graphic Design'],
  keywords: [
    'logo',
    'brand',
    'branding',
    'favicon',
    'icon',
    'wordmark',
    'mark',
    'identity',
    'vector',
    'svg',
  ],
  keywordsForFullScore: 3,
  budgetMin: 5,
  budgetMax: 150,
  proposalThreshold: 40,
};

// --- Pricing -----------------------------------------------------------------
// Gig-listing anchors (PRD §11). The estimator may bid above these
// (max(1.5×cost, gig.budget)); pricingCalc supplies the deterministic baseline
// plus the timeline and the two milestone checkpoints.
export const SEED_PRICE_USD = 25;

export const rateCard: RateCard = {
  perClaudeCall: 0.05,
  perKToken: 0.01,
  perBrowserMinute: 0, // no browser in this bot
  perComputeMinute: 0.05,
  perRun: 0.5,
  fixedOverhead: 5,
};

export const fallbackEstimate: ResourceEstimate = {
  claudeCalls: 8,
  claudeKTokens: 15,
  browserMinutes: 0,
  computeMinutes: 6,
  runs: 1,
};

export function pricingCalc(gig: Gig): {
  price: number;
  timeline: string;
  milestones: ProposalMilestone[];
} {
  const description = gig.description ?? '';
  // Free-funnel gigs anchor at $0 (US-2/US-3) and go through the estimator-free
  // proposer — otherwise the 1.5x-cost floor would re-price them. A favicon gig
  // is recognised by its brief shape; the taster shares the paid brief shape
  // and is recognised by its $0 budget.
  const isFavicon = parseFaviconBrief(description).ok;
  if (isFavicon || (gig.budget ?? 0) === 0) {
    return {
      price: 0,
      timeline: '1 business day',
      milestones: [
        {
          title: isFavicon
            ? 'Milestone 1 — Favicon package from your logo'
            : 'Milestone 1 — One free concept with its OCR verdict',
          duration: '1 business day',
          deliverables: isFavicon
            ? [
                'ZIP: favicon.ico (16/32/48, parse-back verified), PNGs at 16/32/48/180/192/512, site.webmanifest, HTML snippet.',
              ]
            : [
                'One 1024px logo concept with its lettering-readback verdict attached as labelled, non-blocking evidence.',
              ],
        },
      ],
    };
  }

  return {
    price: SEED_PRICE_USD,
    timeline: '2 business days',
    milestones: [
      {
        title: 'Milestone 1 — Three OCR-passing concepts',
        duration: '1 business day',
        deliverables: [
          'Three 1024px logo concepts on three distinct declared style axes.',
          'An OCR readback verdict per concept (model id, transcription, similarity score).',
          'A live progress page showing each concept and its verdict as it lands.',
        ],
      },
      {
        title: 'Milestone 2 — True-vector brand pack',
        duration: '1 business day',
        deliverables: [
          'logo.svg — parse-verified true vector, zero embedded rasters, outlined paths.',
          'Colour and mono PNG masters at 1024px and 2048px.',
          'Favicon set: 16/32/48/180/192/512 plus favicon.ico, site.webmanifest, HTML snippet.',
          'brand.json — extracted hex codes and a license-clean Google Fonts pairing.',
          'JSON validation report and per-image license manifest.',
        ],
      },
    ],
  };
}

// --- Hard caps (FR-5, FR-14) --------------------------------------------------
export const CONCEPT_COUNT = 3;
export const MAX_REGENS_PER_SLOT = 2;
export const MAX_SPEND_USD = 2.5;
export const FREE_GIGS_PER_PAYER = 3;
export const FREE_GIG_WINDOW_DAYS = 30;

/** Failed moderation attempts before the buyer gets a thread status message (FR-2). */
export const MODERATION_ATTEMPTS_BEFORE_NOTICE = 3;

/** `claimed` jobs older than this with no checkpoint are re-enqueued (§12). */
export const STUCK_CLAIM_MINUTES = 30;

/** Hours after M1 delivery before the default-selection rule fires (FR-9). */
export const SELECTION_TIMEOUT_HOURS = 72;

// --- Gate thresholds (§9) -----------------------------------------------------
// PROVISIONAL until the Phase 2 calibration freezes them against the ≥30-name
// golden set. Do NOT loosen these to make a job pass — §15 tracks regen burn
// precisely so drift triggers prompt tuning, never silent gate-loosening.
export const OCR_SIMILARITY_THRESHOLD = 0.85; // PROVISIONAL
export const MIN_PHASH_HAMMING = 10; // PROVISIONAL

// --- Models -------------------------------------------------------------------
export const HAIKU_MODEL_ID = 'claude-haiku-4-5';
export const SCOUT_MODEL_ID = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const FLUX_MODEL_ID = '@cf/black-forest-labs/flux-2-klein';

/** Haiku 4.5 list pricing, USD per million tokens — spend accounting. */
export const HAIKU_PRICING_PER_MTOK = {
  input: 1.0,
  output: 5.0,
  cacheWrite: 1.25,
  cacheRead: 0.1,
} as const;

/** Conservative flat per-image vendor costs for the FR-5 spend ledger (§11). */
export const IMAGE_COST_USD = {
  ideogram: 0.06,
  recraft: 0.08,
  flux: 0.001,
  vectorizer: 0.2,
} as const;

// --- Pack contract (§8) --------------------------------------------------------
export const FAVICON_SIZES = [16, 32, 48, 180, 192, 512] as const;
export const ICO_SIZES = [16, 32, 48] as const;
export const MASTER_SIZES = [1024, 2048] as const;
```

- [ ] **Step 7: Write `src/testSupport.ts`**

```typescript
// Node-only test helper — NEVER import from Worker code (it reads the
// migration files from disk). Applying the shipped migrations to the in-memory
// SQLite double guarantees tests exercise the exact schema a real D1 database
// gets from `wrangler d1 migrations apply`.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { D1Like } from '@botguild/agent-core-workers';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Apply every migration in `migrations/` (in filename order) against `db`. */
export async function applyMigrations(db: D1Like): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql
      .split(/;\s*\n/)
      .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await db.prepare(statement).run();
    }
  }
}
```

- [ ] **Step 8: Write the failing config test**

`apps/logosmith-bot/src/config.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import {
  CONCEPT_COUNT,
  FAVICON_SIZES,
  ICO_SIZES,
  MAX_REGENS_PER_SLOT,
  MAX_SPEND_USD,
  MIN_PHASH_HAMMING,
  OCR_SIMILARITY_THRESHOLD,
  SEED_PRICE_USD,
  botProfile,
  pricingCalc,
  scorerConfig,
} from './config.js';
import { applyMigrations } from './testSupport.js';

describe('config', () => {
  it('advertises the identity the PRD contracts for', () => {
    assert.equal(botProfile.handlerId, 'bot-logosmith');
    assert.equal(botProfile.valueChainPosition, 'originator');
    // §9: the warranty covers verifiable properties only.
    assert.match(botProfile.warrantyTerms ?? '', /Trademark clearance is NOT performed/);
  });

  it('scores logo-adjacent gigs outside an exact category match', () => {
    assert.ok(scorerConfig.keywords.includes('favicon'));
    assert.ok(scorerConfig.keywords.includes('wordmark'));
    assert.equal(scorerConfig.proposalThreshold, 40);
  });

  it('prices the seed gig as one price with two checkpoints', () => {
    const quote = pricingCalc({ id: 'g1', description: '', budget: 25 } as never);
    assert.equal(quote.price, SEED_PRICE_USD);
    assert.equal(quote.milestones.length, 2);
    // Milestones are checkpoints, not payment slices — no per-milestone amount.
    assert.ok(!('amount' in quote.milestones[0]!));
  });

  it('anchors the free gigs at $0 with a single milestone', () => {
    const favicon = pricingCalc({
      id: 'g2',
      description: '```json\n{ "logoUrl": "https://example.com/logo.png" }\n```',
      budget: 0,
    } as never);
    assert.equal(favicon.price, 0);
    assert.equal(favicon.milestones.length, 1);

    const taster = pricingCalc({
      id: 'g3',
      description: '```json\n{ "brandName": "Acme", "industry": "tools" }\n```',
      budget: 0,
    } as never);
    assert.equal(taster.price, 0);
  });

  it('pins the FR-5/FR-6 caps and thresholds', () => {
    assert.equal(CONCEPT_COUNT, 3);
    assert.equal(MAX_REGENS_PER_SLOT, 2);
    assert.equal(MAX_SPEND_USD, 2.5);
    assert.equal(OCR_SIMILARITY_THRESHOLD, 0.85);
    assert.equal(MIN_PHASH_HAMMING, 10);
  });

  it('declares the §8 pack size contract', () => {
    assert.deepEqual([...FAVICON_SIZES], [16, 32, 48, 180, 192, 512]);
    assert.deepEqual([...ICO_SIZES], [16, 32, 48]);
  });
});

describe('migrations', () => {
  it('creates every table the app and shim need', async () => {
    const db = createMemoryD1();
    await applyMigrations(db);
    for (const table of [
      'jobs',
      'concepts',
      'selection',
      'free_gig_usage',
      'license_manifest',
      'dispute_responses',
      'gate_audit',
      'reputation_snapshot',
      'webhook_secret',
      'negotiation_countered',
    ]) {
      const row = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .bind(table)
        .first<{ name: string }>();
      assert.equal(row?.name, table, `missing table: ${table}`);
    }
  });

  it('enforces the stage CHECK constraint on jobs', async () => {
    const db = createMemoryD1();
    await applyMigrations(db);
    await assert.rejects(() =>
      db
        .prepare(
          'INSERT INTO jobs (job_key, contract_id, stage, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind('k', 'c', 'not-a-stage', 'claimed', 'now', 'now')
        .run(),
    );
  });
});
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `pnpm -w build && cd apps/logosmith-bot && pnpm test`
Expected: FAIL — `Cannot find module './config.js'` before step 6 is applied, or a missing-table assertion if the migration is incomplete.

- [ ] **Step 10: Run the test to verify it passes**

Run: `pnpm -w build && cd apps/logosmith-bot && pnpm test`
Expected: PASS — all 7 tests.

Also run `pnpm --filter @botguild/logosmith-bot typecheck` and `pnpm --filter @botguild/logosmith-bot exec wrangler deploy --dry-run` (the dry run must succeed against the placeholder ids).

- [ ] **Step 11: Commit**

```bash
git checkout -b logosmith develop
git add apps/logosmith-bot pnpm-lock.yaml
git commit -m "feat(logosmith): scaffold Worker app, D1 schema, types, and config

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Brief intake — parsing, validation, and the `logoUrl` guard policy

**Files:**
- Create: `apps/logosmith-bot/src/brief.ts`
- Test: `apps/logosmith-bot/src/brief.test.ts`

**Interfaces:**
- Consumes: `LogoBrief`, `FaviconBrief` from `./types.js`. (Deliberately imports nothing from `config.js` — config imports `parseFaviconBrief` from here for the $0 pricing branch.)
- Produces:
  - `parseLogoBrief(description: string): BriefResult<LogoBrief>`
  - `parseFaviconBrief(description: string): BriefResult<FaviconBrief>`
  - `isLatinScript(text: string): boolean`
  - `checkLogoUrl(rawUrl: string): UrlCheck` — the pure SSRF/scheme policy decision (no fetch)
  - `type BriefResult<T> = { ok: true; brief: T } | { ok: false; reason: string }`
  - `type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/brief.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkLogoUrl, isLatinScript, parseFaviconBrief, parseLogoBrief } from './brief.js';

const fence = (json: unknown): string =>
  `We need a mark for our new place.\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;

describe('parseLogoBrief', () => {
  it('extracts a fenced JSON brief from a gig description', () => {
    const result = parseLogoBrief(
      fence({ brandName: 'Harbor & Vine', industry: 'boutique inn', script: 'latin' }),
    );
    assert.ok(result.ok);
    assert.equal(result.brief.brandName, 'Harbor & Vine');
    assert.equal(result.brief.industry, 'boutique inn');
  });

  it('accepts a brief with the optional fields present', () => {
    const result = parseLogoBrief(
      fence({
        brandName: 'Harbor & Vine',
        industry: 'boutique inn',
        brief: 'coastal, warm, understated luxury',
        palettePreference: ['#0F3D3E', '#E8C39E'],
        avoid: ['gradients', 'mascots'],
      }),
    );
    assert.ok(result.ok);
    assert.deepEqual(result.brief.avoid, ['gradients', 'mascots']);
  });

  it('rejects a description with no fenced block', () => {
    const result = parseLogoBrief('Please make me a logo, thanks!');
    assert.ok(!result.ok);
    assert.match(result.reason, /no fenced json/i);
  });

  it('rejects a brief missing a required field', () => {
    const result = parseLogoBrief(fence({ brandName: 'Harbor & Vine' }));
    assert.ok(!result.ok);
    assert.match(result.reason, /industry/);
  });

  it('rejects a blank brand name', () => {
    const result = parseLogoBrief(fence({ brandName: '   ', industry: 'inn' }));
    assert.ok(!result.ok);
    assert.match(result.reason, /brandName/);
  });

  it('rejects non-Latin brand names (v1 scope, PRD §13)', () => {
    const result = parseLogoBrief(fence({ brandName: '海港与藤', industry: 'inn' }));
    assert.ok(!result.ok);
    assert.match(result.reason, /latin/i);
  });

  it('rejects malformed JSON inside the fence', () => {
    const result = parseLogoBrief('```json\n{ brandName: nope }\n```');
    assert.ok(!result.ok);
    assert.match(result.reason, /parse/i);
  });
});

describe('isLatinScript', () => {
  it('accepts Latin letters, digits, punctuation, and diacritics', () => {
    assert.ok(isLatinScript('Harbor & Vine'));
    assert.ok(isLatinScript('Café Ünicode 42'));
    assert.ok(isLatinScript("O'Brien-Smith"));
  });

  it('rejects CJK, Arabic, and Devanagari', () => {
    assert.ok(!isLatinScript('海港'));
    assert.ok(!isLatinScript('مرحبا'));
    assert.ok(!isLatinScript('नमस्ते'));
  });
});

describe('parseFaviconBrief', () => {
  it('extracts a logoUrl brief', () => {
    const result = parseFaviconBrief(fence({ logoUrl: 'https://example.com/logo.png' }));
    assert.ok(result.ok);
    assert.equal(result.brief.logoUrl, 'https://example.com/logo.png');
  });

  it('rejects a brief whose logoUrl fails the guard policy', () => {
    const result = parseFaviconBrief(fence({ logoUrl: 'http://example.com/logo.png' }));
    assert.ok(!result.ok);
    assert.match(result.reason, /https/i);
  });
});

describe('checkLogoUrl', () => {
  it('accepts an https URL with a hostname', () => {
    const result = checkLogoUrl('https://example.com/logo.png');
    assert.ok(result.ok);
    assert.equal(result.url.hostname, 'example.com');
  });

  it('rejects non-https schemes', () => {
    for (const url of ['http://example.com/a.png', 'file:///etc/passwd', 'data:image/png;base64,x']) {
      const result = checkLogoUrl(url);
      assert.ok(!result.ok, `expected rejection: ${url}`);
    }
  });

  it('rejects IP literals and localhost (SSRF, §12)', () => {
    for (const host of [
      'https://127.0.0.1/a.png',
      'https://localhost/a.png',
      'https://localhost./a.png',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/a.png',
      'https://0.0.0.0/a.png',
      'https://10.0.0.5/a.png',
    ]) {
      const result = checkLogoUrl(host);
      assert.ok(!result.ok, `expected rejection: ${host}`);
      assert.match(result.reason, /host/i);
    }
  });

  it('rejects garbage that is not a URL at all', () => {
    const result = checkLogoUrl('not a url');
    assert.ok(!result.ok);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -w build && cd apps/logosmith-bot && pnpm test -- --test-name-pattern brief`
Expected: FAIL with `Cannot find module './brief.js'`.

- [ ] **Step 3: Write the implementation**

`apps/logosmith-bot/src/brief.ts`:

```typescript
// Brief intake (FR-1). The platform has no structured-brief primitive, so the
// brief rides as a fenced JSON block in the gig description. Parsed at proposal
// time (the scorer skips gigs whose brief is missing, invalid, or non-Latin, so
// un-intakeable work is never won) and re-validated at milestone.funded.
//
// Every function here is pure: `checkLogoUrl` decides the URL *policy* and does
// NOT fetch. The size/type/timeout guards run at fetch time in the pipeline.

import type { FaviconBrief, LogoBrief } from './types.js';

export type BriefResult<T> = { ok: true; brief: T } | { ok: false; reason: string };
export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)\n?```/i;

/** Pull the first fenced block out of a gig description and JSON-parse it. */
function extractFencedJson(description: string): BriefResult<Record<string, unknown>> {
  const match = FENCE_RE.exec(description);
  if (!match?.[1]) return { ok: false, reason: 'no fenced json block in the gig description' };
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: 'fenced json did not parse to an object' };
    }
    return { ok: true, brief: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'could not parse the fenced json block' };
  }
}

const nonBlankString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;

/**
 * Latin-script check (v1 scope, PRD §13). Accepts Basic Latin plus Latin-1
 * Supplement / Extended-A letters, digits, whitespace, and common punctuation —
 * so "Café", "O'Brien-Smith" and "Harbor & Vine" pass while CJK, Arabic, and
 * Devanagari are skipped at intake rather than garbling generation and OCR.
 */
export function isLatinScript(text: string): boolean {
  if (text.trim().length === 0) return false;
  return /^[\p{Script=Latin}\p{Nd}\p{P}\p{Zs}\p{M}+&@#$%^*<>=|~`]+$/u.test(text);
}

/** Parse + completeness-check the paid logo gig's brief. */
export function parseLogoBrief(description: string): BriefResult<LogoBrief> {
  const fenced = extractFencedJson(description);
  if (!fenced.ok) return fenced;
  const raw = fenced.brief;

  if (!nonBlankString(raw['brandName'])) {
    return { ok: false, reason: 'brief is missing a non-blank brandName' };
  }
  if (!nonBlankString(raw['industry'])) {
    return { ok: false, reason: 'brief is missing a non-blank industry' };
  }
  const brandName = raw['brandName'].trim();
  if (!isLatinScript(brandName)) {
    return { ok: false, reason: 'brandName is not Latin script (out of v1 scope)' };
  }

  return {
    ok: true,
    brief: {
      brandName,
      industry: raw['industry'].trim(),
      ...(nonBlankString(raw['brief']) ? { brief: raw['brief'].trim() } : {}),
      ...(stringArray(raw['palettePreference'])
        ? { palettePreference: stringArray(raw['palettePreference']) }
        : {}),
      ...(stringArray(raw['avoid']) ? { avoid: stringArray(raw['avoid']) } : {}),
      ...(nonBlankString(raw['script']) ? { script: raw['script'].trim() } : {}),
    },
  };
}

/** Parse the FREE favicon gig's brief and apply the URL policy up front. */
export function parseFaviconBrief(description: string): BriefResult<FaviconBrief> {
  const fenced = extractFencedJson(description);
  if (!fenced.ok) return fenced;
  const raw = fenced.brief;
  if (!nonBlankString(raw['logoUrl'])) {
    return { ok: false, reason: 'brief is missing a non-blank logoUrl' };
  }
  const check = checkLogoUrl(raw['logoUrl']);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, brief: { logoUrl: check.url.toString() } };
}

// Hostnames that must never be fetched: loopback, link-local (cloud metadata),
// and RFC1918 space. Checked as literals — DNS rebinding is out of scope for a
// buyer-supplied asset URL, but IP-literal SSRF is cheap to close (§12).
const BLOCKED_HOST_RE =
  /^(localhost|(\[)?::1(\])?|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+)$/i;

const IP_LITERAL_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[[0-9a-f:]+\])$/i;

/**
 * The `logoUrl` policy decision (§12): HTTPS only, no IP literals, no loopback
 * or link-local hosts. Size (10 MB), magic-byte type sniff (PNG/JPEG/SVG),
 * 15 s timeout, and the ≥512 px minimum are enforced at fetch/decode time.
 */
export function checkLogoUrl(rawUrl: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'logoUrl is not a valid URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'logoUrl must use https' };
  }
  // Strip one trailing dot: `localhost.` is the absolute-domain form of
  // localhost and resolves identically (Task 2 review finding — SSRF bypass).
  const host = url.hostname.replace(/\.$/, '');
  if (host.length === 0 || IP_LITERAL_RE.test(host) || BLOCKED_HOST_RE.test(host)) {
    return { ok: false, reason: 'logoUrl host is not permitted' };
  }
  return { ok: true, url };
}

/** The minimum source resolution the favicon gig accepts (US-2 AC1). Lives
 *  here, not in config.ts — config imports parseFaviconBrief from this module
 *  for the $0 pricing branch, so this file must stay import-free of config. */
export const MIN_SOURCE_PX = 512;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -w build && cd apps/logosmith-bot && pnpm test -- --test-name-pattern brief`
Expected: PASS — all 15 tests across the four describes.

- [ ] **Step 5: Commit**

```bash
git add apps/logosmith-bot/src/brief.ts apps/logosmith-bot/src/brief.test.ts
git commit -m "feat(logosmith): brief intake with Latin-script and logoUrl guards

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Phase B — Pack primitives

Everything in this phase is pure in-isolate CPU with **no vendor API and no network**. It is buildable and fully testable while Phase 0 vendor-terms verification is still outstanding, and it is on the critical path for both the paid M2 pack and the free favicon gig. Building it here also surfaces the §13 bundle-size / 128 MB isolate risk early, while the named container fallback is still cheap to take.

### Task 3: WASM init, resvg rendering, and the dimensions gate

**Files:**
- Create: `apps/logosmith-bot/src/pack/wasm.ts`
- Create: `apps/logosmith-bot/src/pack/wasm.node.ts`
- Create: `apps/logosmith-bot/src/pack/render.ts`
- Create: `apps/logosmith-bot/src/gates/dimensions.ts`
- Test: `apps/logosmith-bot/src/pack/render.test.ts`
- Test: `apps/logosmith-bot/src/gates/dimensions.test.ts`

**Interfaces:**
- Consumes: `Pixmap` from `../types.js`.
- Produces:
  - `ensureResvgReady(source: ResvgWasmSource): Promise<void>`
  - `ensurePotraceReady(source: PotraceWasmSource): Promise<void>`
  - `type WasmSources = { resvg: ResvgWasmSource; potrace: PotraceWasmSource }`
  - `nodeWasmSources(): WasmSources` (Node-only)
  - `renderSvgToPng(svg: string, size: number, sources: WasmSources): Promise<Uint8Array>`
  - `renderSvgToPixmap(svg: string, size: number, sources: WasmSources): Promise<Pixmap>`
  - `readPngDimensions(png: Uint8Array): Dimensions | null`
  - `checkDimensions(actual: Dimensions, expected: Dimensions): DimensionsResult`
  - `type Dimensions = { width: number; height: number }`

- [ ] **Step 1: Write the failing dimensions test**

`apps/logosmith-bot/src/gates/dimensions.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkDimensions, readPngDimensions } from './dimensions.js';

/** A minimal valid PNG header: 8-byte signature + IHDR length/type/w/h. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR chunk length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe('readPngDimensions', () => {
  it('reads width and height from the IHDR chunk', () => {
    assert.deepEqual(readPngDimensions(pngHeader(1024, 1024)), { width: 1024, height: 1024 });
    assert.deepEqual(readPngDimensions(pngHeader(16, 48)), { width: 16, height: 48 });
  });

  it('returns null for a non-PNG buffer', () => {
    assert.equal(readPngDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
  });

  it('returns null for a truncated PNG', () => {
    assert.equal(readPngDimensions(pngHeader(16, 16).slice(0, 20)), null);
  });

  it('returns null when the IHDR chunk type is wrong', () => {
    const bytes = pngHeader(16, 16);
    bytes.set([0x49, 0x44, 0x41, 0x54], 12); // "IDAT"
    assert.equal(readPngDimensions(bytes), null);
  });
});

describe('checkDimensions', () => {
  it('passes on an exact match', () => {
    const result = checkDimensions({ width: 512, height: 512 }, { width: 512, height: 512 });
    assert.equal(result.pass, true);
  });

  it('fails on any mismatch and reports both sides', () => {
    const result = checkDimensions({ width: 511, height: 512 }, { width: 512, height: 512 });
    assert.equal(result.pass, false);
    assert.deepEqual(result.actual, { width: 511, height: 512 });
    assert.deepEqual(result.expected, { width: 512, height: 512 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern Dimensions`
Expected: FAIL with `Cannot find module './dimensions.js'`.

- [ ] **Step 3: Write the dimensions gate**

`apps/logosmith-bot/src/gates/dimensions.ts`:

```typescript
// Dimensions gate (FR-13, §9): every PNG's size is read from the encoded IHDR
// bytes, never from render intent — so a resvg surprise fails the gate instead
// of shipping a wrongly-sized favicon.

export interface Dimensions {
  width: number;
  height: number;
}

export interface DimensionsResult {
  pass: boolean;
  actual: Dimensions;
  expected: Dimensions;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Read WxH out of a PNG's IHDR chunk. Returns null if this is not a PNG. */
export function readPngDimensions(png: Uint8Array): Dimensions | null {
  if (png.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (png[i] !== PNG_SIGNATURE[i]) return null;
  }
  // Bytes 12-15 must spell "IHDR" — the first chunk of every valid PNG.
  if (png[12] !== 0x49 || png[13] !== 0x48 || png[14] !== 0x44 || png[15] !== 0x52) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Assert exact pixel dimensions against the contracted target. */
export function checkDimensions(actual: Dimensions, expected: Dimensions): DimensionsResult {
  return {
    pass: actual.width === expected.width && actual.height === expected.height,
    actual: { width: actual.width, height: actual.height },
    expected: { width: expected.width, height: expected.height },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern Dimensions`
Expected: PASS — 6 tests.

- [ ] **Step 5: Write the WASM init modules**

Adapted from `apps/thumbforge-bot/src/render/wasm.ts` and `wasm.node.ts` — same memoize-the-init-promise-per-isolate pattern, with the wasm bytes injected as a source callback so the module stays runtime-agnostic and Node tests can read them off disk.

`apps/logosmith-bot/src/pack/wasm.ts`:

```typescript
// ---------------------------------------------------------------------------
// Lazy, once-per-isolate wasm initialization for the pack stack (PRD §7).
//
// Adapted from apps/thumbforge-bot/src/render/wasm.ts. Both resvg and potrace
// expose a global "init this module" call that must run exactly once per
// isolate; we memoize the init promise at module scope so the first caller pays
// the cost and every later (and concurrent) caller awaits the same promise. The
// wasm bytes are injected as a source callback — Node reads them off disk
// (./wasm.node.ts), the Worker passes its bundled `.wasm` imports — so this
// module never references a runtime-specific API.
// ---------------------------------------------------------------------------

import { initWasm, type InitInput } from '@resvg/resvg-wasm';
import { init as initPotraceRaw } from 'esm-potrace-wasm';

const initPotrace = initPotraceRaw as unknown as (
  input?: WebAssembly.Module | ArrayBuffer,
) => Promise<void>;

export type ResvgWasmSource = () => Promise<InitInput> | InitInput;
export type PotraceWasmSource = () => Promise<WebAssembly.Module> | WebAssembly.Module;

export interface WasmSources {
  resvg: ResvgWasmSource;
  potrace: PotraceWasmSource;
}

let resvgReady: Promise<void> | undefined;

/** Initialize resvg-wasm once per isolate; later calls await the same promise. */
export function ensureResvgReady(source: ResvgWasmSource): Promise<void> {
  resvgReady ??= Promise.resolve(source()).then((input) => initWasm(input));
  return resvgReady;
}

let potraceReady: Promise<void> | undefined;

/** Initialize the potrace tracer wasm once per isolate. */
export function ensurePotraceReady(source: PotraceWasmSource): Promise<void> {
  potraceReady ??= Promise.resolve(source()).then((module) => initPotrace(module));
  return potraceReady;
}
```

`apps/logosmith-bot/src/pack/wasm.node.ts`:

```typescript
// Node-only wasm sources for tests + local dev: read the resvg and potrace
// `.wasm` bytes from node_modules and compile them. NEVER import this from
// Worker code — the Worker passes its own bundled `.wasm` imports as sources.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { WasmSources } from './wasm.js';

const require = createRequire(import.meta.url);

async function compile(specifier: string): Promise<WebAssembly.Module> {
  return WebAssembly.compile(await readFile(require.resolve(specifier)));
}

/** Wasm sources that resolve the pack engine's `.wasm` files from node_modules. */
export function nodeWasmSources(): WasmSources {
  return {
    resvg: () => compile('@resvg/resvg-wasm/index_bg.wasm'),
    potrace: () => compile('esm-potrace-wasm/dist/potrace.wasm'),
  };
}
```

> **If `require.resolve('esm-potrace-wasm/dist/potrace.wasm')` throws,** list the package's shipped files with `ls node_modules/esm-potrace-wasm/dist` and use the actual `.wasm` filename. Do not guess a second time — fix the specifier and note it in the module comment.

- [ ] **Step 6: Write the failing render test**

`apps/logosmith-bot/src/pack/render.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readPngDimensions } from '../gates/dimensions.js';
import { renderSvgToPixmap, renderSvgToPng } from './render.js';
import { nodeWasmSources } from './wasm.node.js';

// Paths-only, no <text>, no external fonts — exactly the shape the true-vector
// gate guarantees, so resvg never needs to load a font.
const SQUARE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M10 10 H90 V90 H10 Z" fill="#0F3D3E"/></svg>';

describe('renderSvgToPng', () => {
  it('renders at the exact requested size', async () => {
    const sources = nodeWasmSources();
    for (const size of [16, 48, 512]) {
      const png = await renderSvgToPng(SQUARE_SVG, size, sources);
      assert.deepEqual(readPngDimensions(png), { width: size, height: size });
    }
  });

  it('renders each size from the vector, not by resizing a raster', async () => {
    // A 16px render and a 512px render are produced independently; the small
    // one must not simply be the large one's header.
    const sources = nodeWasmSources();
    const small = await renderSvgToPng(SQUARE_SVG, 16, sources);
    const large = await renderSvgToPng(SQUARE_SVG, 512, sources);
    assert.notEqual(small.length, large.length);
    assert.ok(large.length > small.length);
  });
});

describe('renderSvgToPixmap', () => {
  it('returns RGBA bytes matching the requested dimensions', async () => {
    const pixmap = await renderSvgToPixmap(SQUARE_SVG, 64, nodeWasmSources());
    assert.equal(pixmap.width, 64);
    assert.equal(pixmap.height, 64);
    assert.equal(pixmap.data.length, 64 * 64 * 4);
  });

  it('renders the declared fill colour into the centre pixel', async () => {
    const pixmap = await renderSvgToPixmap(SQUARE_SVG, 64, nodeWasmSources());
    const centre = (32 * 64 + 32) * 4;
    assert.equal(pixmap.data[centre], 0x0f);
    assert.equal(pixmap.data[centre + 1], 0x3d);
    assert.equal(pixmap.data[centre + 2], 0x3e);
    assert.equal(pixmap.data[centre + 3], 255);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern render`
Expected: FAIL with `Cannot find module './render.js'`.

- [ ] **Step 8: Write the renderer**

`apps/logosmith-bot/src/pack/render.ts`:

```typescript
// resvg rendering (FR-11). Every favicon and master PNG is rendered from the
// vector at its exact target size — never produced by resizing a larger raster,
// which is what makes the 16px favicon legible instead of mush.

import { Resvg } from '@resvg/resvg-wasm';
import type { Pixmap } from '../types.js';
import { ensureResvgReady, type WasmSources } from './wasm.js';

/** Render an SVG to a decoded RGBA pixmap at `size`x`size`. */
export async function renderSvgToPixmap(
  svg: string,
  size: number,
  sources: WasmSources,
): Promise<Pixmap> {
  await ensureResvgReady(sources.resvg);
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const rendered = resvg.render();
  return {
    width: rendered.width,
    height: rendered.height,
    data: new Uint8Array(rendered.pixels),
  };
}

/** Render an SVG to encoded PNG bytes at `size`x`size`. */
export async function renderSvgToPng(
  svg: string,
  size: number,
  sources: WasmSources,
): Promise<Uint8Array> {
  await ensureResvgReady(sources.resvg);
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return new Uint8Array(resvg.render().asPng());
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern render`
Expected: PASS — 4 tests.

If the centre-pixel assertion fails because resvg premultiplies alpha, assert the opaque RGB values it actually produces and note the premultiplication in a comment — do not delete the assertion.

- [ ] **Step 10: Commit**

```bash
git add apps/logosmith-bot/src/pack apps/logosmith-bot/src/gates
git commit -m "feat(logosmith): wasm init, exact-size resvg renders, dimensions gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Concept distinctness gate — pHash + Hamming

**Files:**
- Create: `apps/logosmith-bot/src/gates/phash.ts`
- Test: `apps/logosmith-bot/src/gates/phash.test.ts`

**Interfaces:**
- Consumes: `Pixmap` from `../types.js`; `MIN_PHASH_HAMMING`, `CONCEPT_COUNT` from `../config.js`.
- Produces:
  - `perceptualHash(pixmap: Pixmap): bigint`
  - `toHex(hash: bigint): string` / `fromHex(hex: string): bigint`
  - `hammingDistance(a: bigint, b: bigint): number`
  - `checkDistinctness(entries: DistinctEntry[], minHamming?: number): DistinctnessResult`
  - `type DistinctEntry = { slot: number; phash: string; axisId: string }`
  - `type DistinctnessResult = { pass: boolean; pairs: PairResult[]; failing: PairResult[] }`
  - `type PairResult = { a: number; b: number; distance: number; sameAxis: boolean; pass: boolean }`

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/gates/phash.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_PHASH_HAMMING } from '../config.js';
import type { Pixmap } from '../types.js';
import {
  checkDistinctness,
  fromHex,
  hammingDistance,
  perceptualHash,
  toHex,
} from './phash.js';

/** Build a pixmap by evaluating `shade(x, y)` into every RGBA pixel. */
function makePixmap(size: number, shade: (x: number, y: number) => number): Pixmap {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = shade(x, y);
      const i = (y * size + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

const leftHalfDark = makePixmap(64, (x) => (x < 32 ? 0 : 255));
const topHalfDark = makePixmap(64, (_x, y) => (y < 32 ? 0 : 255));
// pHash bit-vs-median is only stable on broadband images. Flat/ramp synthetics
// are DCT-sparse (median in a zero-coefficient cluster; one perturbed pixel
// measured 29-30 bit flips) — real vendor images are broadband, and the Phase-2
// calibration validates the threshold on real batches. Minimal flat-colour
// marks are the caveat; the axis-id rule is the second lock. (T4 execution ruling.)
const rings = makePixmap(64, (x, y) => ((x - 32) ** 2 + (y - 32) ** 2) % 256);
const ringsOnePixel = makePixmap(64, (x, y) =>
  x === 0 && y === 0 ? 128 : ((x - 32) ** 2 + (y - 32) ** 2) % 256,
);
const ringsRenderNoise = makePixmap(64, (x, y) =>
  Math.min(255, (((x - 32) ** 2 + (y - 32) ** 2) % 256) + ((x * 31 + y * 17) % 20 === 0 ? 6 : 0)),
);

describe('perceptualHash', () => {
  it('is deterministic for the same input', () => {
    assert.equal(perceptualHash(leftHalfDark), perceptualHash(leftHalfDark));
  });

  it('a one-pixel perturbation stays below the distinctness threshold', () => {
    const distance = hammingDistance(perceptualHash(rings), perceptualHash(ringsOnePixel));
    assert.ok(distance < MIN_PHASH_HAMMING, `expected < ${MIN_PHASH_HAMMING}, got ${distance}`);
  });

  it('distributed render noise stays below the distinctness threshold', () => {
    const distance = hammingDistance(perceptualHash(rings), perceptualHash(ringsRenderNoise));
    assert.ok(distance < MIN_PHASH_HAMMING, `expected < ${MIN_PHASH_HAMMING}, got ${distance}`);
  });

  it('differs substantially for a different composition', () => {
    const distance = hammingDistance(perceptualHash(leftHalfDark), perceptualHash(topHalfDark));
    assert.ok(distance >= 10, `expected >= 10, got ${distance}`);
  });
});

describe('hex round-trip', () => {
  it('survives toHex → fromHex', () => {
    const hash = perceptualHash(topHalfDark);
    assert.equal(fromHex(toHex(hash)), hash);
    assert.equal(toHex(hash).length, 16);
  });
});

describe('hammingDistance', () => {
  it('is zero for identical hashes and 64 for inverted ones', () => {
    assert.equal(hammingDistance(0n, 0n), 0);
    assert.equal(hammingDistance(0n, (1n << 64n) - 1n), 64);
    assert.equal(hammingDistance(0b1011n, 0b1001n), 1);
  });
});

describe('checkDistinctness', () => {
  const distinct = [
    { slot: 1, phash: '0000000000000000', axisId: 'wordmark' },
    { slot: 2, phash: 'ffffffffffffffff', axisId: 'lockup' },
    { slot: 3, phash: '0f0f0f0f0f0f0f0f', axisId: 'emblem' },
  ];

  it('passes when every pair clears the threshold and axes differ', () => {
    const result = checkDistinctness(distinct);
    assert.equal(result.pass, true);
    assert.equal(result.pairs.length, 3); // 3 choose 2
    assert.equal(result.failing.length, 0);
  });

  it('fails a pair below the Hamming threshold', () => {
    const result = checkDistinctness([
      { slot: 1, phash: '0000000000000000', axisId: 'wordmark' },
      { slot: 2, phash: '0000000000000001', axisId: 'lockup' },
      { slot: 3, phash: 'ffffffffffffffff', axisId: 'emblem' },
    ]);
    assert.equal(result.pass, false);
    assert.equal(result.failing.length, 1);
    assert.deepEqual([result.failing[0]!.a, result.failing[0]!.b], [1, 2]);
  });

  it('fails a pair that shares an axis even when pixels differ (§9)', () => {
    const result = checkDistinctness([
      { slot: 1, phash: '0000000000000000', axisId: 'wordmark' },
      { slot: 2, phash: 'ffffffffffffffff', axisId: 'wordmark' },
      { slot: 3, phash: '0f0f0f0f0f0f0f0f', axisId: 'emblem' },
    ]);
    assert.equal(result.pass, false);
    assert.ok(result.failing.some((p) => p.sameAxis));
  });

  it('honours an overridden threshold', () => {
    const entries = [
      { slot: 1, phash: '0000000000000000', axisId: 'a' },
      { slot: 2, phash: '000000000000000f', axisId: 'b' },
    ];
    assert.equal(checkDistinctness(entries, 4).pass, true);
    assert.equal(checkDistinctness(entries, 5).pass, false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern phash`
Expected: FAIL with `Cannot find module './phash.js'`.

- [ ] **Step 3: Write the gate**

`apps/logosmith-bot/src/gates/phash.ts`:

```typescript
// ---------------------------------------------------------------------------
// Concept distinctness gate (FR-6, §9). Adapted from
// apps/thumbforge-bot/src/gates/phash.ts — the same 64-bit 8x8 DCT perceptual
// hash, because the PRD pins LogoSmith's threshold "consistent with ThumbForge".
//
// Two concepts are distinct only when BOTH hold: Hamming distance >= the
// declared threshold AND the two concepts carry distinct declared style axis
// ids. Axis labels alone never satisfy the gate — three prompts that all
// produced the same lockup are not three concepts.
//
// pHash pipeline: luminance-downsample to 32x32, 2D DCT-II, keep the top-left
// 8x8 low-frequency block, set each bit against the block median.
// ---------------------------------------------------------------------------

import { MIN_PHASH_HAMMING } from '../config.js';
import type { Pixmap } from '../types.js';

const DCT_SIZE = 32;
const HASH_SIZE = 8;

/** Luminance-downsample a pixmap to a `size`x`size` grayscale grid (box average). */
export function downsampleGray(pixmap: Pixmap, size = DCT_SIZE): number[] {
  const grid = new Array<number>(size * size).fill(0);
  const cellW = pixmap.width / size;
  const cellH = pixmap.height / size;
  for (let gy = 0; gy < size; gy++) {
    for (let gx = 0; gx < size; gx++) {
      const x0 = Math.floor(gx * cellW);
      const y0 = Math.floor(gy * cellH);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cellW));
      const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * cellH));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * pixmap.width + x) * 4;
          const r = pixmap.data[i] ?? 0;
          const g = pixmap.data[i + 1] ?? 0;
          const b = pixmap.data[i + 2] ?? 0;
          sum += 0.299 * r + 0.587 * g + 0.114 * b;
          count++;
        }
      }
      grid[gy * size + gx] = count > 0 ? sum / count : 0;
    }
  }
  return grid;
}

/** 2D DCT-II over a `size`x`size` grid, returning the top-left `keep`x`keep` block. */
function dct2dTopLeft(grid: number[], size: number, keep: number): number[] {
  const cos: number[][] = [];
  for (let u = 0; u < keep; u++) {
    const row: number[] = [];
    for (let x = 0; x < size; x++) {
      row.push(Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size)));
    }
    cos.push(row);
  }
  // Rows first, then columns — separable DCT keeps this O(keep * size^2).
  const rows: number[][] = [];
  for (let y = 0; y < size; y++) {
    const out: number[] = [];
    for (let u = 0; u < keep; u++) {
      let sum = 0;
      for (let x = 0; x < size; x++) sum += (grid[y * size + x] ?? 0) * (cos[u]![x] ?? 0);
      out.push(sum);
    }
    rows.push(out);
  }
  const block: number[] = [];
  for (let v = 0; v < keep; v++) {
    for (let u = 0; u < keep; u++) {
      let sum = 0;
      for (let y = 0; y < size; y++) sum += (rows[y]![u] ?? 0) * (cos[v]![y] ?? 0);
      block.push(sum);
    }
  }
  return block;
}

/** 64-bit 8x8 DCT perceptual hash of a pixmap. */
export function perceptualHash(pixmap: Pixmap): bigint {
  const grid = downsampleGray(pixmap, DCT_SIZE);
  const block = dct2dTopLeft(grid, DCT_SIZE, HASH_SIZE);
  // The DC term carries overall brightness, not structure — exclude it from
  // the median so a uniformly darker variant is not "different".
  const ac = block.slice(1);
  const sorted = [...ac].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);

  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    hash <<= 1n;
    if ((block[i] ?? 0) > median) hash |= 1n;
  }
  return hash;
}

/** 16-hex-character string form, for the D1 `concepts.phash` column. */
export function toHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}

export function fromHex(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

export function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

export interface DistinctEntry {
  slot: number;
  phash: string;
  axisId: string;
}

export interface PairResult {
  a: number;
  b: number;
  distance: number;
  sameAxis: boolean;
  pass: boolean;
}

export interface DistinctnessResult {
  pass: boolean;
  pairs: PairResult[];
  failing: PairResult[];
}

/**
 * Pairwise distinctness over the delivered concept set. Every pair must clear
 * the Hamming threshold AND carry different axis ids.
 */
export function checkDistinctness(
  entries: DistinctEntry[],
  minHamming: number = MIN_PHASH_HAMMING,
): DistinctnessResult {
  const pairs: PairResult[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      const distance = hammingDistance(fromHex(a.phash), fromHex(b.phash));
      const sameAxis = a.axisId === b.axisId;
      pairs.push({
        a: a.slot,
        b: b.slot,
        distance,
        sameAxis,
        pass: distance >= minHamming && !sameAxis,
      });
    }
  }
  const failing = pairs.filter((p) => !p.pass);
  return { pass: failing.length === 0, pairs, failing };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern phash`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/logosmith-bot/src/gates/phash.ts apps/logosmith-bot/src/gates/phash.test.ts
git commit -m "feat(logosmith): pHash distinctness gate with axis-id enforcement

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: True-vector gate and SVG sanitization

**Files:**
- Create: `apps/logosmith-bot/src/gates/vector.ts`
- Test: `apps/logosmith-bot/src/gates/vector.test.ts`

**Interfaces:**
- Consumes: nothing beyond the DOM-free parser written here.
- Produces:
  - `sanitizeSvg(svg: string): string` — strips scripts, event attributes, `<foreignObject>`
  - `checkTrueVector(svg: string): VectorGateResult`
  - `type VectorGateResult = { pass: boolean; violations: string[]; census: NodeCensus }`
  - `type NodeCensus = { path: number; shape: number; image: number; text: number; foreignObject: number; script: number; hasViewBox: boolean }`

> **Why a regex/scan parser and not a DOM library:** Workers has no DOM, and pulling a full XML parser in for a census we can compute by scanning tag names is bundle weight the §13 size budget cannot spare. The gate is deliberately *conservative* — anything it cannot positively classify as a vector primitive counts as a violation.
>
> **⚠️ The code block below is the ORIGINAL draft and is KNOWN-VULNERABLE. The shipped `apps/logosmith-bot/src/gates/vector.ts` is authoritative.** Two execution-verified review rounds redesigned it; a reader implementing from this snippet would reintroduce a Critical bypass. What changed, and why:
> - **Namespace-qualified tags bypassed everything.** `countTag`'s `` `<${tag}[\s/>]` `` and `sanitizeSvg`'s strippers only matched bare names, so `<ns1:script>`, `<ns1:foreignObject>` and `<ns1:image>` passed `pass: true` — and sanitizing *laundered* the foreignObject case from fail into pass. Every tag pattern now carries an optional `(?:[\w.-]+:)?` prefix.
> - **The "conservative" claim was not implemented.** The census is a *blocklist*; the documented allowlist semantics now exist as a real check: scan opening tags with `/<([\w.-]+(?::[\w.-]+)?)(?=[\s/>])/g`, strip the prefix, and compare the local name against `svg, g, defs, path, circle, ellipse, rect, line, polyline, polygon, clipPath, mask, linearGradient, radialGradient, stop, pattern, symbol, use, title, desc, metadata`. Anything else is a violation *naming the element*. Note the capture must include `:` — the first attempt omitted it, and `matchAll` then yielded nothing for prefixed tags, leaving the backstop as dead code.
> - `<style>` and `<a>` are deliberately **not** allowlisted (CSS can smuggle `url(data:…)`; `<a href="javascript:…">` was a confirmed hole, now also caught by an explicit scheme check).
> - `sanitizeSvg` strips `<metadata>` subtrees so vendor `<rdf:RDF>`/`<dc:title>` are removed rather than newly false-rejected.
> - The `viewBox` test is case-**sensitive** (`/\sviewBox\s*=/`, no `i`): XML attribute names are case-sensitive, and lowercase `viewbox=` does not scale the mark.
> - Whitespace between `<` and a tag name is knowingly out of scope — no compliant XML/HTML parser treats `< script>` as a start tag.

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/gates/vector.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkTrueVector, sanitizeSvg } from './vector.js';

const TRUE_VECTOR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M10 10 H90 V90 H10 Z" fill="#0F3D3E"/>' +
  '<circle cx="50" cy="50" r="20" fill="#E8C39E"/></svg>';

describe('checkTrueVector', () => {
  it('passes a paths-and-shapes-only SVG with a viewBox', () => {
    const result = checkTrueVector(TRUE_VECTOR);
    assert.equal(result.pass, true);
    assert.deepEqual(result.violations, []);
    assert.equal(result.census.path, 1);
    assert.equal(result.census.shape, 1);
    assert.equal(result.census.hasViewBox, true);
  });

  it('fails an SVG that wraps a raster in an <image> element', () => {
    const result = checkTrueVector(
      '<svg viewBox="0 0 10 10"><image href="data:image/png;base64,iVBOR"/></svg>',
    );
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => /image/.test(v)));
  });

  it('fails an SVG with a raster href on any element', () => {
    const result = checkTrueVector(
      '<svg viewBox="0 0 10 10"><path d="M0 0" fill="url(data:image/png;base64,x)"/></svg>',
    );
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => /raster/i.test(v)));
  });

  it('fails an SVG containing <text> (outlined paths only)', () => {
    const result = checkTrueVector('<svg viewBox="0 0 10 10"><text x="0" y="0">Hi</text></svg>');
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => /text/.test(v)));
  });

  it('fails <foreignObject> and <script>', () => {
    for (const body of ['<foreignObject><div/></foreignObject>', '<script>alert(1)</script>']) {
      const result = checkTrueVector(`<svg viewBox="0 0 10 10">${body}</svg>`);
      assert.equal(result.pass, false, body);
    }
  });

  it('fails an event-handler attribute', () => {
    const result = checkTrueVector(
      '<svg viewBox="0 0 10 10"><path d="M0 0" onload="steal()"/></svg>',
    );
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => /event/i.test(v)));
  });

  it('fails an SVG with no viewBox', () => {
    const result = checkTrueVector('<svg><path d="M0 0"/></svg>');
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => /viewBox/.test(v)));
  });
});

describe('sanitizeSvg', () => {
  it('strips script elements and their contents', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 1 1"><script>alert(1)</script><path d="M0 0"/></svg>');
    assert.ok(!/script/i.test(out));
    assert.ok(/<path/.test(out));
  });

  it('strips foreignObject blocks', () => {
    const out = sanitizeSvg(
      '<svg viewBox="0 0 1 1"><foreignObject><div>x</div></foreignObject><path d="M0 0"/></svg>',
    );
    assert.ok(!/foreignObject/i.test(out));
    assert.ok(/<path/.test(out));
  });

  it('strips on* event attributes but keeps legitimate ones', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 1 1"><path d="M0 0" onclick="x()" fill="#fff"/></svg>');
    assert.ok(!/onclick/i.test(out));
    assert.ok(/fill="#fff"/.test(out));
    assert.ok(/d="M0 0"/.test(out));
  });

  it('produces output that passes the gate it defends', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<script>x()</script><path d="M10 10 H90 V90 H10 Z" onmouseover="y()" fill="#000"/></svg>';
    assert.equal(checkTrueVector(sanitizeSvg(dirty)).pass, true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern Vector`
Expected: FAIL with `Cannot find module './vector.js'`.

- [ ] **Step 3: Write the gate**

`apps/logosmith-bot/src/gates/vector.ts`:

```typescript
// ---------------------------------------------------------------------------
// True-vector gate (FR-10, §9) — the gate that makes "true vector" a verified
// property rather than a vendor claim. The delivered logo.svg must parse with
// ONLY vector primitives:
//
//   zero <image>           — an SVG wrapping a raster is the exact fraud the
//                            buyer fears; it fails, full stop
//   zero raster hrefs      — data:image/... or .png/.jpg refs anywhere
//   no <text>              — outlined paths only, which also guarantees the
//                            renderer never needs to load a font
//   no <foreignObject>     — arbitrary HTML inside an SVG
//   no <script>/on* attrs  — stripped defensively by sanitizeSvg first
//   viewBox present        — without it the mark does not scale predictably
//
// Workers has no DOM, and a full XML parser is bundle weight the §13 size
// budget cannot spare, so this is a conservative tag/attribute scan: anything
// not positively classified as a vector primitive counts as a violation.
// ---------------------------------------------------------------------------

export interface NodeCensus {
  path: number;
  shape: number;
  image: number;
  text: number;
  foreignObject: number;
  script: number;
  hasViewBox: boolean;
}

export interface VectorGateResult {
  pass: boolean;
  violations: string[];
  census: NodeCensus;
}

const SHAPE_TAGS = ['circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon'];
const RASTER_REF_RE = /(?:data:image\/|\.(?:png|jpe?g|gif|webp|bmp|avif)\b)/i;
const EVENT_ATTR_RE = /\son[a-z]+\s*=/i;

const countTag = (svg: string, tag: string): number =>
  (svg.match(new RegExp(`<${tag}[\\s/>]`, 'gi')) ?? []).length;

/**
 * Strip the actively dangerous constructs before the gate runs. Sanitization
 * and the gate are deliberately separate: sanitize removes what can be safely
 * removed, the gate then proves what remains is a true vector.
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<foreignObject\b[^>]*\/>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
}

/** Assert the SVG contains only vector primitives (FR-10). */
export function checkTrueVector(svg: string): VectorGateResult {
  const census: NodeCensus = {
    path: countTag(svg, 'path'),
    shape: SHAPE_TAGS.reduce((sum, tag) => sum + countTag(svg, tag), 0),
    image: countTag(svg, 'image'),
    text: countTag(svg, 'text') + countTag(svg, 'tspan'),
    foreignObject: countTag(svg, 'foreignObject'),
    script: countTag(svg, 'script'),
    hasViewBox: /\sviewBox\s*=/i.test(svg),
  };

  const violations: string[] = [];
  if (census.image > 0) violations.push(`contains ${census.image} <image> element(s)`);
  if (census.text > 0) violations.push(`contains ${census.text} <text>/<tspan> element(s)`);
  if (census.foreignObject > 0) violations.push('contains <foreignObject>');
  if (census.script > 0) violations.push('contains <script>');
  if (EVENT_ATTR_RE.test(svg)) violations.push('contains an on* event attribute');
  if (RASTER_REF_RE.test(svg)) violations.push('contains a raster reference (data: or image file)');
  if (!census.hasViewBox) violations.push('missing viewBox');
  if (census.path + census.shape === 0) violations.push('contains no vector primitives at all');

  return { pass: violations.length === 0, violations, census };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern Vector`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/logosmith-bot/src/gates/vector.ts apps/logosmith-bot/src/gates/vector.test.ts
git commit -m "feat(logosmith): true-vector gate and SVG sanitization

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Mono mark — threshold + potrace trace

**Files:**
- Create: `apps/logosmith-bot/src/pack/mono.ts`
- Test: `apps/logosmith-bot/src/pack/mono.test.ts`

**Interfaces:**
- Consumes: `Pixmap` from `../types.js`; `WasmSources`, `ensurePotraceReady` from `./wasm.js`; `sanitizeSvg` from `../gates/vector.js`.
- Produces:
  - `thresholdToBilevel(pixmap: Pixmap, cutoff?: number): Pixmap` — pure, no wasm
  - `traceMonoSvg(pixmap: Pixmap, sources: WasmSources): Promise<string>`

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/pack/mono.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkTrueVector } from '../gates/vector.js';
import type { Pixmap } from '../types.js';
import { thresholdToBilevel, traceMonoSvg } from './mono.js';
import { nodeWasmSources } from './wasm.node.js';

function makePixmap(size: number, shade: (x: number, y: number) => number): Pixmap {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = shade(x, y);
      const i = (y * size + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

// A dark disc on a light field — a stand-in for a solid mark.
const disc = makePixmap(128, (x, y) => {
  const dx = x - 64;
  const dy = y - 64;
  return dx * dx + dy * dy < 40 * 40 ? 20 : 240;
});

describe('thresholdToBilevel', () => {
  it('collapses every pixel to pure black or pure white', () => {
    const out = thresholdToBilevel(disc);
    for (let i = 0; i < out.data.length; i += 4) {
      const v = out.data[i]!;
      assert.ok(v === 0 || v === 255, `unexpected value ${v}`);
      assert.equal(out.data[i + 1], v);
      assert.equal(out.data[i + 2], v);
      assert.equal(out.data[i + 3], 255);
    }
  });

  it('puts the dark mark on the black side of the cutoff', () => {
    const out = thresholdToBilevel(disc);
    const centre = (64 * 128 + 64) * 4;
    const corner = 0;
    assert.equal(out.data[centre], 0);
    assert.equal(out.data[corner], 255);
  });

  it('honours an explicit cutoff', () => {
    const flat = makePixmap(8, () => 100);
    assert.equal(thresholdToBilevel(flat, 50).data[0], 255);
    assert.equal(thresholdToBilevel(flat, 150).data[0], 0);
  });

  it('preserves dimensions', () => {
    const out = thresholdToBilevel(disc);
    assert.equal(out.width, 128);
    assert.equal(out.height, 128);
  });
});

describe('traceMonoSvg', () => {
  it('produces an SVG that passes the true-vector gate', async () => {
    const svg = await traceMonoSvg(disc, nodeWasmSources());
    const result = checkTrueVector(svg);
    assert.equal(result.pass, true, result.violations.join('; '));
    assert.ok(result.census.path > 0, 'expected at least one traced path');
  });

  it('carries no <image> and no <text>', async () => {
    const svg = await traceMonoSvg(disc, nodeWasmSources());
    assert.ok(!/<image/i.test(svg));
    assert.ok(!/<text/i.test(svg));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern mono`
Expected: FAIL with `Cannot find module './mono.js'`.

- [ ] **Step 3: Write the implementation**

`apps/logosmith-bot/src/pack/mono.ts`:

```typescript
// Mono mark (FR-11). The colour winner is thresholded to bilevel and traced to
// a single-colour SVG — the "works on a stamp / one-colour print" deliverable.
//
// potrace is mono-only by construction: the PRD is explicit that it is NOT a
// fallback for full-colour vectorization (§13). Nothing here claims otherwise.

import { potrace } from 'esm-potrace-wasm';
import { sanitizeSvg } from '../gates/vector.js';
import type { Pixmap } from '../types.js';
import { ensurePotraceReady, type WasmSources } from './wasm.js';

const DEFAULT_CUTOFF = 128;

/**
 * Collapse a pixmap to pure black / pure white on a luminance cutoff. Pure and
 * wasm-free so the threshold behaviour is unit-testable on its own; alpha is
 * flattened onto white first so a transparent background becomes light, not
 * accidentally dark.
 */
export function thresholdToBilevel(pixmap: Pixmap, cutoff = DEFAULT_CUTOFF): Pixmap {
  const data = new Uint8Array(pixmap.data.length);
  for (let i = 0; i < pixmap.data.length; i += 4) {
    const alpha = (pixmap.data[i + 3] ?? 255) / 255;
    const r = (pixmap.data[i] ?? 0) * alpha + 255 * (1 - alpha);
    const g = (pixmap.data[i + 1] ?? 0) * alpha + 255 * (1 - alpha);
    const b = (pixmap.data[i + 2] ?? 0) * alpha + 255 * (1 - alpha);
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const v = luma < cutoff ? 0 : 255;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: pixmap.width, height: pixmap.height, data };
}

/** Threshold then trace to a mono SVG, sanitized and gate-ready. */
export async function traceMonoSvg(pixmap: Pixmap, sources: WasmSources): Promise<string> {
  await ensurePotraceReady(sources.potrace);
  const bilevel = thresholdToBilevel(pixmap);
  const imageData = {
    data: new Uint8ClampedArray(bilevel.data),
    width: bilevel.width,
    height: bilevel.height,
  };
  const traced = await potrace(imageData as ImageData, {
    turdsize: 2,
    extractcolors: false,
  });
  return sanitizeSvg(ensureViewBox(traced, bilevel.width, bilevel.height));
}

/**
 * potrace emits width/height attributes; the true-vector gate requires a
 * viewBox, so add one derived from the traced raster when it is absent.
 */
function ensureViewBox(svg: string, width: number, height: number): string {
  if (/\sviewBox\s*=/i.test(svg)) return svg;
  return svg.replace(/<svg\b/i, `<svg viewBox="0 0 ${width} ${height}"`);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern mono`
Expected: PASS — 6 tests.

If `potrace()` rejects the plain object cast to `ImageData`, construct a real `ImageData` under Node 22 (`new ImageData(new Uint8ClampedArray(...), w, h)`) and drop the cast. If the library's option names differ from `turdsize`/`extractcolors`, read `node_modules/esm-potrace-wasm/dist/index.d.ts` and use the declared names — do not silently pass unknown options.

- [ ] **Step 5: Commit**

```bash
git add apps/logosmith-bot/src/pack/mono.ts apps/logosmith-bot/src/pack/mono.test.ts
git commit -m "feat(logosmith): bilevel threshold and potrace mono mark

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: ICO assembly and the parse-back gate

**Files:**
- Create: `apps/logosmith-bot/src/pack/ico.ts`
- Create: `apps/logosmith-bot/src/gates/ico.ts`
- Test: `apps/logosmith-bot/src/pack/ico.test.ts`

**Interfaces:**
- Consumes: `ICO_SIZES` from `../config.js`; `readPngDimensions` from `../gates/dimensions.js`.
- Produces:
  - `assembleIco(entries: IcoEntry[]): Uint8Array`
  - `parseIco(ico: Uint8Array): IcoParseResult | null`
  - `checkIco(ico: Uint8Array, expectedSizes?: readonly number[]): IcoGateResult`
  - `type IcoEntry = { size: number; png: Uint8Array }`
  - `type IcoParseResult = { count: number; entries: Array<{ width: number; height: number; byteLength: number; offset: number }> }`
  - `type IcoGateResult = { pass: boolean; sizes: number[]; reason?: string }`

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/pack/ico.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIco, parseIco } from '../gates/ico.js';
import { assembleIco } from './ico.js';

/** A minimal valid PNG header (24 bytes) padded to a plausible payload size. */
function fakePng(size: number, padTo = 64): Uint8Array {
  const bytes = new Uint8Array(padTo);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, size);
  view.setUint32(20, size);
  return bytes;
}

const entries = [16, 32, 48].map((size) => ({ size, png: fakePng(size) }));

describe('assembleIco', () => {
  it('writes an ICONDIR header declaring the entry count', () => {
    const ico = assembleIco(entries);
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    assert.equal(view.getUint16(0, true), 0); // reserved
    assert.equal(view.getUint16(2, true), 1); // type 1 = icon
    assert.equal(view.getUint16(4, true), 3); // count
  });

  it('lays payloads out after the directory with correct offsets', () => {
    const ico = assembleIco(entries);
    const parsed = parseIco(ico);
    assert.ok(parsed);
    assert.equal(parsed.count, 3);
    const headerBytes = 6 + 16 * 3;
    assert.equal(parsed.entries[0]!.offset, headerBytes);
    assert.equal(parsed.entries[1]!.offset, headerBytes + 64);
    assert.equal(parsed.entries[2]!.offset, headerBytes + 128);
  });

  it('round-trips the declared sizes', () => {
    const parsed = parseIco(assembleIco(entries));
    assert.deepEqual(
      parsed!.entries.map((e) => e.width),
      [16, 32, 48],
    );
  });

  it('encodes 256 as 0 per the ICO format', () => {
    const parsed = parseIco(assembleIco([{ size: 256, png: fakePng(256) }]));
    assert.equal(parsed!.entries[0]!.width, 256);
  });

  it('preserves the payload bytes verbatim', () => {
    const ico = assembleIco(entries);
    const parsed = parseIco(ico)!;
    const first = parsed.entries[0]!;
    const slice = ico.slice(first.offset, first.offset + first.byteLength);
    assert.deepEqual([...slice.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});

describe('checkIco', () => {
  it('passes when the entry table lists exactly 16/32/48', () => {
    const result = checkIco(assembleIco(entries));
    assert.equal(result.pass, true);
    assert.deepEqual(result.sizes, [16, 32, 48]);
  });

  it('fails when a required size is missing', () => {
    const result = checkIco(assembleIco(entries.slice(0, 2)));
    assert.equal(result.pass, false);
    assert.match(result.reason ?? '', /48/);
  });

  it('fails on a buffer that is not an ICO at all', () => {
    const result = checkIco(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    assert.equal(result.pass, false);
  });

  it('fails when an entry offset runs past the buffer', () => {
    const ico = assembleIco(entries);
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    view.setUint32(6 + 12, 0xfffffff0, true); // corrupt entry 0's offset
    assert.equal(checkIco(ico).pass, false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern ico`
Expected: FAIL with `Cannot find module './ico.js'`.

- [ ] **Step 3: Write the assembler**

`apps/logosmith-bot/src/pack/ico.ts`:

```typescript
// favicon.ico assembly in plain TypeScript (FR-11). Windows and every current
// browser accept PNG-compressed ICO entries, which keeps this to a header
// write with no encoder. §13 names BMP-entry encoding as the pure-TS fallback
// if the browser/OS matrix in Phase 3 turns up a consumer that rejects PNG
// entries — do not switch pre-emptively.
//
// Layout: ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per image + the
// PNG payloads concatenated in entry order. All multi-byte fields little-endian.

export interface IcoEntry {
  size: number;
  png: Uint8Array;
}

const ICONDIR_BYTES = 6;
const ICONDIRENTRY_BYTES = 16;

/** Build a multi-size .ico from pre-rendered PNGs. */
export function assembleIco(entries: IcoEntry[]): Uint8Array {
  const headerBytes = ICONDIR_BYTES + ICONDIRENTRY_BYTES * entries.length;
  const total = entries.reduce((sum, entry) => sum + entry.png.byteLength, headerBytes);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint16(0, 0, true); // reserved, always 0
  view.setUint16(2, 1, true); // resource type: 1 = icon
  view.setUint16(4, entries.length, true);

  let offset = headerBytes;
  entries.forEach((entry, index) => {
    const base = ICONDIR_BYTES + index * ICONDIRENTRY_BYTES;
    // 256 is encoded as 0 — the field is a single byte.
    const dim = entry.size >= 256 ? 0 : entry.size;
    out[base] = dim; // width
    out[base + 1] = dim; // height
    out[base + 2] = 0; // palette colour count (0 = truecolour)
    out[base + 3] = 0; // reserved
    view.setUint16(base + 4, 1, true); // colour planes
    view.setUint16(base + 6, 32, true); // bits per pixel
    view.setUint32(base + 8, entry.png.byteLength, true);
    view.setUint32(base + 12, offset, true);
    out.set(entry.png, offset);
    offset += entry.png.byteLength;
  });

  return out;
}
```

- [ ] **Step 4: Write the parse-back gate**

`apps/logosmith-bot/src/gates/ico.ts`:

```typescript
// ICO validity gate (FR-13, §9): the delivered favicon.ico is parsed back and
// its entry table must list exactly the contracted sizes. Writing the file is
// not evidence that it is readable — reading it back is.

import { ICO_SIZES } from '../config.js';

export interface IcoParseResult {
  count: number;
  entries: Array<{ width: number; height: number; byteLength: number; offset: number }>;
}

export interface IcoGateResult {
  pass: boolean;
  sizes: number[];
  reason?: string;
}

const ICONDIR_BYTES = 6;
const ICONDIRENTRY_BYTES = 16;

/** Parse an ICO's directory. Returns null if the buffer is not a valid ICO. */
export function parseIco(ico: Uint8Array): IcoParseResult | null {
  if (ico.byteLength < ICONDIR_BYTES) return null;
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  if (view.getUint16(0, true) !== 0) return null;
  if (view.getUint16(2, true) !== 1) return null;
  const count = view.getUint16(4, true);
  if (count === 0) return null;
  if (ico.byteLength < ICONDIR_BYTES + ICONDIRENTRY_BYTES * count) return null;

  const entries: IcoParseResult['entries'] = [];
  for (let i = 0; i < count; i++) {
    const base = ICONDIR_BYTES + i * ICONDIRENTRY_BYTES;
    const rawW = ico[base] ?? 0;
    const rawH = ico[base + 1] ?? 0;
    entries.push({
      width: rawW === 0 ? 256 : rawW,
      height: rawH === 0 ? 256 : rawH,
      byteLength: view.getUint32(base + 8, true),
      offset: view.getUint32(base + 12, true),
    });
  }
  return { count, entries };
}

/** Assert the .ico parses back and lists exactly the contracted sizes. */
export function checkIco(
  ico: Uint8Array,
  expectedSizes: readonly number[] = ICO_SIZES,
): IcoGateResult {
  const parsed = parseIco(ico);
  if (!parsed) return { pass: false, sizes: [], reason: 'buffer did not parse as an ICO' };

  for (const entry of parsed.entries) {
    if (entry.offset + entry.byteLength > ico.byteLength) {
      return { pass: false, sizes: [], reason: 'an entry offset runs past the end of the buffer' };
    }
  }

  const sizes = parsed.entries.map((e) => e.width).sort((a, b) => a - b);
  const missing = expectedSizes.filter((size) => !sizes.includes(size));
  if (missing.length > 0) {
    return { pass: false, sizes, reason: `entry table is missing size(s): ${missing.join(', ')}` };
  }
  return { pass: true, sizes };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern ico`
Expected: PASS — 9 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/logosmith-bot/src/pack/ico.ts apps/logosmith-bot/src/gates/ico.ts apps/logosmith-bot/src/pack/ico.test.ts
git commit -m "feat(logosmith): TypeScript ICO assembly with parse-back gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Brand metadata — palette extraction and font pairing

**Files:**
- Create: `apps/logosmith-bot/src/pack/palette.ts`
- Create: `apps/logosmith-bot/src/pack/fonts.ts`
- Test: `apps/logosmith-bot/src/pack/palette.test.ts`
- Test: `apps/logosmith-bot/src/pack/fonts.test.ts`

**Interfaces:**
- Consumes: `Pixmap`, `FetchLike` from `../types.js`.
- Produces:
  - `extractPalette(pixmap: Pixmap, max?: number): Swatch[]`
  - `type Swatch = { hex: string; share: number }`
  - `fetchFontPairing(deps: { fetchImpl: FetchLike; apiKey: string }): Promise<FontPairing>`
  - `type FontPairing = { heading: FontRef; body: FontRef; note: string }`
  - `type FontRef = { family: string; category: string; license: string; url: string }`

- [ ] **Step 1: Write the failing palette test**

`apps/logosmith-bot/src/pack/palette.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pixmap } from '../types.js';
import { extractPalette } from './palette.js';

function pixmapFrom(colors: Array<[number, number, number, number]>): Pixmap {
  const data = new Uint8Array(colors.length * 4);
  colors.forEach(([r, g, b, a], i) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  });
  return { width: colors.length, height: 1, data };
}

const teal: [number, number, number, number] = [0x0f, 0x3d, 0x3e, 255];
const sand: [number, number, number, number] = [0xe8, 0xc3, 0x9e, 255];
const white: [number, number, number, number] = [255, 255, 255, 255];

describe('extractPalette', () => {
  it('returns the dominant colours as hex, most-common first', () => {
    const swatches = extractPalette(pixmapFrom([teal, teal, teal, sand, sand, white]));
    assert.equal(swatches[0]!.hex, '#0f3d3e');
    assert.equal(swatches[1]!.hex, '#e8c39e');
  });

  it('excludes the near-white background (§FR-12)', () => {
    const swatches = extractPalette(pixmapFrom([white, white, white, white, teal]));
    assert.ok(!swatches.some((s) => s.hex === '#ffffff'));
    assert.equal(swatches[0]!.hex, '#0f3d3e');
  });

  it('excludes fully transparent pixels', () => {
    const swatches = extractPalette(pixmapFrom([[0, 0, 0, 0], [0, 0, 0, 0], teal]));
    assert.equal(swatches.length, 1);
    assert.equal(swatches[0]!.hex, '#0f3d3e');
  });

  it('reports each swatch share as a fraction of counted pixels', () => {
    const swatches = extractPalette(pixmapFrom([teal, teal, sand, sand]));
    assert.equal(swatches[0]!.share, 0.5);
    assert.equal(swatches[1]!.share, 0.5);
  });

  it('caps the number of swatches returned', () => {
    const many = Array.from(
      { length: 40 },
      (_, i) => [i * 6, 40, 40, 255] as [number, number, number, number],
    );
    assert.ok(extractPalette(pixmapFrom(many), 5).length <= 5);
  });

  it('returns an empty array when every pixel is excluded', () => {
    assert.deepEqual(extractPalette(pixmapFrom([white, white])), []);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern palette`
Expected: FAIL with `Cannot find module './palette.js'`.

- [ ] **Step 3: Write the palette extractor**

`apps/logosmith-bot/src/pack/palette.ts`:

```typescript
// Brand hex extraction (FR-12) in plain TypeScript — replaces node-vibrant,
// which does not run on Workers. Frequency-quantized top swatches read off the
// 1024px pixmap, with the background excluded so "#ffffff" is never sold back
// to the buyer as a brand colour.

import type { Pixmap } from '../types.js';

export interface Swatch {
  hex: string;
  share: number;
}

/** Quantize each channel to 4 bits so near-identical AA pixels collapse together. */
const quantize = (value: number): number => value & 0xf0;

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Near-white and near-black are background/ink, not brand colour. */
function isBackground(r: number, g: number, b: number): boolean {
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma > 233 || luma < 12;
}

/** Top brand swatches by pixel frequency, most-common first. */
export function extractPalette(pixmap: Pixmap, max = 5): Swatch[] {
  const counts = new Map<string, { r: number; g: number; b: number; n: number }>();
  let counted = 0;

  for (let i = 0; i < pixmap.data.length; i += 4) {
    const a = pixmap.data[i + 3] ?? 0;
    if (a < 8) continue; // fully transparent
    const r = pixmap.data[i] ?? 0;
    const g = pixmap.data[i + 1] ?? 0;
    const b = pixmap.data[i + 2] ?? 0;
    if (isBackground(r, g, b)) continue;

    const key = `${quantize(r)},${quantize(g)},${quantize(b)}`;
    const bucket = counts.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.n += 1;
    } else {
      counts.set(key, { r, g, b, n: 1 });
    }
    counted++;
  }

  if (counted === 0) return [];

  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map((bucket) => ({
      // Average the bucket back to a representative colour rather than
      // reporting the quantized corner, which would shift every hex.
      hex: toHex(
        Math.round(bucket.r / bucket.n),
        Math.round(bucket.g / bucket.n),
        Math.round(bucket.b / bucket.n),
      ),
      share: bucket.n / counted,
    }));
}
```

- [ ] **Step 4: Write the failing fonts test**

`apps/logosmith-bot/src/pack/fonts.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFontPairing } from './fonts.js';

const apiPayload = {
  items: [
    { family: 'Inter', category: 'sans-serif', variants: ['regular', '700'] },
    { family: 'Fraunces', category: 'serif', variants: ['regular'] },
    { family: 'Comic Relief', category: 'display', variants: ['regular'] },
  ],
};

const okFetch = async (): Promise<Response> =>
  new Response(JSON.stringify(apiPayload), { status: 200 });

describe('fetchFontPairing', () => {
  it('returns a heading and body family with license metadata', async () => {
    const pairing = await fetchFontPairing({ fetchImpl: okFetch, apiKey: 'k' });
    assert.ok(pairing.heading.family.length > 0);
    assert.ok(pairing.body.family.length > 0);
    assert.match(pairing.heading.license, /OFL|Apache/);
  });

  it('labels the pairing advisory (§9: not a warranted property)', async () => {
    const pairing = await fetchFontPairing({ fetchImpl: okFetch, apiKey: 'k' });
    assert.match(pairing.note, /advisory/i);
  });

  it('falls back to the pinned default pairing when the API errors', async () => {
    const pairing = await fetchFontPairing({
      fetchImpl: async () => new Response('nope', { status: 500 }),
      apiKey: 'k',
    });
    assert.equal(pairing.heading.family, 'Inter');
    assert.match(pairing.note, /advisory/i);
  });

  it('falls back when the API is unreachable', async () => {
    const pairing = await fetchFontPairing({
      fetchImpl: async () => {
        throw new Error('network down');
      },
      apiKey: 'k',
    });
    assert.ok(pairing.heading.family.length > 0);
  });
});
```

- [ ] **Step 5: Write the fonts module**

`apps/logosmith-bot/src/pack/fonts.ts`:

```typescript
// Google Fonts pairing (FR-12). ADVISORY ONLY — §9 lists this as non-blocking:
// it is a recommendation with license metadata, never a warranted property, and
// an outage must never fail a job. Hence the pinned fallback pairing.

import type { FetchLike } from '../types.js';

export interface FontRef {
  family: string;
  category: string;
  license: string;
  url: string;
}

export interface FontPairing {
  heading: FontRef;
  body: FontRef;
  note: string;
}

const ADVISORY_NOTE =
  'Advisory recommendation only. Both families are served by Google Fonts under the SIL Open ' +
  'Font License; verify the licence for your own distribution. Font choice is not covered by the warranty.';

const googleUrl = (family: string): string =>
  `https://fonts.google.com/specimen/${encodeURIComponent(family.replace(/\s+/g, '+'))}`;

const ref = (family: string, category: string): FontRef => ({
  family,
  category,
  license: 'SIL Open Font License 1.1',
  url: googleUrl(family),
});

/** The pinned pairing used whenever the API is unavailable. */
const FALLBACK: FontPairing = {
  heading: ref('Inter', 'sans-serif'),
  body: ref('Source Serif 4', 'serif'),
  note: ADVISORY_NOTE,
};

interface GoogleFontItem {
  family: string;
  category: string;
}

/** Pick a heading/body pairing from the Google Fonts catalogue. */
export async function fetchFontPairing(deps: {
  fetchImpl: FetchLike;
  apiKey: string;
}): Promise<FontPairing> {
  try {
    const response = await deps.fetchImpl(
      `https://www.googleapis.com/webfonts/v1/webfonts?sort=popularity&key=${encodeURIComponent(deps.apiKey)}`,
    );
    if (!response.ok) return FALLBACK;
    const body = (await response.json()) as { items?: GoogleFontItem[] };
    const items = body.items ?? [];
    // A sans heading paired with a serif body reads as intentional; display
    // faces are excluded because they pair badly with an unknown mark.
    const heading = items.find((f) => f.category === 'sans-serif');
    const body2 = items.find((f) => f.category === 'serif');
    if (!heading || !body2) return FALLBACK;
    return {
      heading: ref(heading.family, heading.category),
      body: ref(body2.family, body2.category),
      note: ADVISORY_NOTE,
    };
  } catch {
    return FALLBACK;
  }
}
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern "palette|FontPairing"`
Expected: PASS — 10 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/logosmith-bot/src/pack/palette.ts apps/logosmith-bot/src/pack/fonts.ts apps/logosmith-bot/src/pack/palette.test.ts apps/logosmith-bot/src/pack/fonts.test.ts
git commit -m "feat(logosmith): brand palette extraction and advisory font pairing

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: ZIP assembly, webmanifest/snippet templating, and the completeness gate

**Files:**
- Create: `apps/logosmith-bot/src/pack/zip.ts`
- Create: `apps/logosmith-bot/src/gates/zip.ts`
- Test: `apps/logosmith-bot/src/pack/zip.test.ts`

**Interfaces:**
- Consumes: `fflate`; `FAVICON_SIZES`, `MASTER_SIZES` from `../config.js`.
- Produces:
  - `REQUIRED_ZIP_ENTRIES: readonly string[]` (the paid M2 contract) and `FAVICON_ZIP_ENTRIES: readonly string[]` (the free favicon gig's US-2 subset — Task 23 gates against this one)
  - `buildWebmanifest(brandName: string): string`
  - `buildHtmlSnippet(): string`
  - `zipFiles(files: Record<string, Uint8Array>): Uint8Array`
  - `unzipFiles(zip: Uint8Array): Record<string, Uint8Array>`
  - `checkZipCompleteness(zip: Uint8Array, required?: readonly string[]): ZipGateResult` — defaults to the paid contract; the favicon gig passes `FAVICON_ZIP_ENTRIES`
  - `type ZipGateResult = { pass: boolean; present: string[]; missing: string[]; reasons: string[] }`

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/pack/zip.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkZipCompleteness } from '../gates/zip.js';
import { REQUIRED_ZIP_ENTRIES, buildHtmlSnippet, buildWebmanifest, unzipFiles, zipFiles } from './zip.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A complete, valid pack — every §8 entry with plausible content. */
function completePack(): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const name of REQUIRED_ZIP_ENTRIES) {
    files[name] = bytes(`stub:${name}`);
  }
  files['site.webmanifest'] = bytes(buildWebmanifest('Harbor & Vine'));
  files['snippet.html'] = bytes(buildHtmlSnippet());
  return files;
}

describe('zipFiles / unzipFiles', () => {
  it('round-trips entries byte-for-byte', () => {
    const zip = zipFiles({ 'a.txt': bytes('hello'), 'b/c.txt': bytes('world') });
    const out = unzipFiles(zip);
    assert.equal(new TextDecoder().decode(out['a.txt']), 'hello');
    assert.equal(new TextDecoder().decode(out['b/c.txt']), 'world');
  });
});

describe('buildWebmanifest', () => {
  it('produces JSON that parses and names the brand', () => {
    const parsed = JSON.parse(buildWebmanifest('Harbor & Vine')) as {
      name: string;
      icons: Array<{ src: string; sizes: string }>;
    };
    assert.equal(parsed.name, 'Harbor & Vine');
    assert.ok(parsed.icons.some((i) => i.sizes === '192x192'));
    assert.ok(parsed.icons.some((i) => i.sizes === '512x512'));
  });

  it('escapes a brand name containing quotes', () => {
    const parsed = JSON.parse(buildWebmanifest('The "Real" Deal')) as { name: string };
    assert.equal(parsed.name, 'The "Real" Deal');
  });
});

describe('buildHtmlSnippet', () => {
  it('references only files that exist in the pack', () => {
    const snippet = buildHtmlSnippet();
    const refs = [...snippet.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      assert.ok(REQUIRED_ZIP_ENTRIES.includes(ref), `snippet references missing entry: ${ref}`);
    }
  });
});

describe('checkZipCompleteness', () => {
  it('passes a complete pack', () => {
    const result = checkZipCompleteness(zipFiles(completePack()));
    assert.equal(result.pass, true, result.reasons.join('; '));
    assert.deepEqual(result.missing, []);
  });

  it('fails when a required entry is absent', () => {
    const files = completePack();
    delete files['favicon.ico'];
    const result = checkZipCompleteness(zipFiles(files));
    assert.equal(result.pass, false);
    assert.ok(result.missing.includes('favicon.ico'));
  });

  it('fails when site.webmanifest does not parse as JSON', () => {
    const files = completePack();
    files['site.webmanifest'] = bytes('{ not json');
    const result = checkZipCompleteness(zipFiles(files));
    assert.equal(result.pass, false);
    assert.ok(result.reasons.some((r) => /webmanifest/i.test(r)));
  });

  it('fails when the snippet references an entry that is not in the ZIP', () => {
    const files = completePack();
    files['snippet.html'] = bytes('<link rel="icon" href="does-not-exist.png">');
    const result = checkZipCompleteness(zipFiles(files));
    assert.equal(result.pass, false);
    assert.ok(result.reasons.some((r) => /does-not-exist\.png/.test(r)));
  });

  it('fails when an entry is present but empty', () => {
    const files = completePack();
    files['logo.svg'] = new Uint8Array(0);
    const result = checkZipCompleteness(zipFiles(files));
    assert.equal(result.pass, false);
    assert.ok(result.reasons.some((r) => /logo\.svg/.test(r)));
  });

  it('fails on a buffer that is not a ZIP', () => {
    const result = checkZipCompleteness(bytes('not a zip'));
    assert.equal(result.pass, false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern zip`
Expected: FAIL with `Cannot find module './zip.js'`.

- [ ] **Step 3: Write the ZIP module**

`apps/logosmith-bot/src/pack/zip.ts`:

```typescript
// Pack ZIP assembly (FR-11) and the §8 entry contract. The entry list is the
// single source of truth shared by the builder, the snippet, and the
// completeness gate — so "the gate checks what we actually ship" is structural
// rather than something two lists have to agree about by hand.

import { unzipSync, zipSync } from 'fflate';

/** Every file the §8 M2 deliverable must contain. */
export const REQUIRED_ZIP_ENTRIES = [
  'logo.svg',
  'logo-mono.svg',
  'logo-color-1024.png',
  'logo-color-2048.png',
  'logo-mono-1024.png',
  'favicon.ico',
  'favicon-16.png',
  'favicon-32.png',
  'favicon-48.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'site.webmanifest',
  'snippet.html',
  'brand.json',
] as const;

/**
 * The FREE favicon gig's smaller contract (US-2 AC2) — favicons, manifest, and
 * snippet only. Deliberately NO logo.svg, mono mark, colour masters, or
 * brand.json: the source is the buyer's existing logo, usually a raster, so
 * there is no true-vector deliverable to promise.
 */
export const FAVICON_ZIP_ENTRIES = [
  'favicon.ico',
  'favicon-16.png',
  'favicon-32.png',
  'favicon-48.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'site.webmanifest',
  'snippet.html',
] as const;

export function zipFiles(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 6 });
}

export function unzipFiles(zip: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(zip);
}

/** A valid web app manifest naming the brand and the two PWA icon sizes. */
export function buildWebmanifest(brandName: string): string {
  return JSON.stringify(
    {
      name: brandName,
      short_name: brandName,
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
      theme_color: '#ffffff',
      background_color: '#ffffff',
      display: 'standalone',
    },
    null,
    2,
  );
}

/** The drop-in <head> snippet. Every href must resolve to a ZIP entry. */
export function buildHtmlSnippet(): string {
  return [
    '<link rel="icon" href="favicon.ico" sizes="any">',
    '<link rel="icon" type="image/png" sizes="16x16" href="favicon-16.png">',
    '<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">',
    '<link rel="icon" type="image/png" sizes="48x48" href="favicon-48.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">',
    '<link rel="manifest" href="site.webmanifest">',
  ].join('\n');
}
```

- [ ] **Step 4: Write the completeness gate**

`apps/logosmith-bot/src/gates/zip.ts`:

```typescript
// ZIP completeness gate (FR-13, §9). The pack is unzipped and checked entry by
// entry: every required file present and non-empty, the webmanifest parses as
// JSON, and every href in the HTML snippet resolves to a real entry. A pack
// whose snippet points at a file we never wrote is a broken deliverable even
// though every individual render passed.

import { REQUIRED_ZIP_ENTRIES, unzipFiles } from '../pack/zip.js';

export interface ZipGateResult {
  pass: boolean;
  present: string[];
  missing: string[];
  reasons: string[];
}

export function checkZipCompleteness(
  zip: Uint8Array,
  required: readonly string[] = REQUIRED_ZIP_ENTRIES,
): ZipGateResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipFiles(zip);
  } catch {
    return { pass: false, present: [], missing: [...required], reasons: ['buffer did not unzip'] };
  }

  const present = Object.keys(files);
  const missing = required.filter((name) => !(name in files));
  const reasons: string[] = [];
  if (missing.length > 0) reasons.push(`missing entries: ${missing.join(', ')}`);

  for (const name of required) {
    const bytes = files[name];
    if (bytes && bytes.byteLength === 0) reasons.push(`${name} is present but empty`);
  }

  const manifest = files['site.webmanifest'];
  if (manifest) {
    try {
      JSON.parse(new TextDecoder().decode(manifest));
    } catch {
      reasons.push('site.webmanifest did not parse as JSON');
    }
  }

  const snippet = files['snippet.html'];
  if (snippet) {
    const html = new TextDecoder().decode(snippet);
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const ref = match[1]!;
      if (!(ref in files)) reasons.push(`snippet.html references a missing entry: ${ref}`);
    }
  }

  return { pass: reasons.length === 0, present, missing, reasons };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern zip`
Expected: PASS — 11 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/logosmith-bot/src/pack/zip.ts apps/logosmith-bot/src/gates/zip.ts apps/logosmith-bot/src/pack/zip.test.ts
git commit -m "feat(logosmith): pack ZIP assembly and completeness gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: `buildPack` orchestration — vector in, gated pack out

**Files:**
- Create: `apps/logosmith-bot/src/pack/index.ts`
- Create: `apps/logosmith-bot/src/gates/index.ts`
- Test: `apps/logosmith-bot/src/pack/index.test.ts`

**Interfaces:**
- Consumes: everything from tasks 3–9.
- Produces:
  - `buildPack(input: PackInput): Promise<PackResult>`
  - `type PackInput = { svg: string; brandName: string; sources: WasmSources; fonts: FontPairing }`
  - `type PackResult = { zip: Uint8Array; files: Record<string, Uint8Array>; brand: BrandJson; gates: PackGateReport }`
  - `type PackGateReport = { vector: VectorGateResult; dimensions: Array<{ file: string } & DimensionsResult>; ico: IcoGateResult; zip: ZipGateResult; pass: boolean }`
  - `gates/index.ts` re-exports every gate for a single import site.

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/pack/index.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readPngDimensions } from '../gates/dimensions.js';
import { REQUIRED_ZIP_ENTRIES, unzipFiles } from './zip.js';
import { buildPack } from './index.js';
import { nodeWasmSources } from './wasm.node.js';

const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M20 20 H80 V80 H20 Z" fill="#0F3D3E"/>' +
  '<circle cx="50" cy="50" r="15" fill="#E8C39E"/></svg>';

const fonts = {
  heading: { family: 'Inter', category: 'sans-serif', license: 'OFL', url: 'https://x' },
  body: { family: 'Source Serif 4', category: 'serif', license: 'OFL', url: 'https://y' },
  note: 'advisory',
};

describe('buildPack', () => {
  it('produces every §8 entry and passes every gate', async () => {
    const result = await buildPack({
      svg: MARK_SVG,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
    });
    assert.equal(result.gates.pass, true, JSON.stringify(result.gates, null, 2));
    const files = unzipFiles(result.zip);
    for (const name of REQUIRED_ZIP_ENTRIES) {
      assert.ok(name in files, `missing pack entry: ${name}`);
    }
  });

  it('renders every favicon at its exact contracted size', async () => {
    const result = await buildPack({
      svg: MARK_SVG,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
    });
    const expected: Array<[string, number]> = [
      ['favicon-16.png', 16],
      ['favicon-32.png', 32],
      ['favicon-48.png', 48],
      ['apple-touch-icon.png', 180],
      ['icon-192.png', 192],
      ['icon-512.png', 512],
      ['logo-color-1024.png', 1024],
      ['logo-color-2048.png', 2048],
    ];
    for (const [file, size] of expected) {
      assert.deepEqual(readPngDimensions(result.files[file]!), { width: size, height: size }, file);
    }
  });

  it('writes brand.json with extracted hex codes and the font pairing', async () => {
    const result = await buildPack({
      svg: MARK_SVG,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
    });
    assert.ok(result.brand.colors.length > 0);
    assert.match(result.brand.colors[0]!.hex, /^#[0-9a-f]{6}$/);
    assert.equal(result.brand.fonts.heading.family, 'Inter');
    assert.match(result.brand.licenseNote, /advisory|not.*warrant/i);
  });

  it('refuses to build a pack from an SVG that fails the vector gate', async () => {
    await assert.rejects(
      () =>
        buildPack({
          svg: '<svg viewBox="0 0 10 10"><image href="data:image/png;base64,x"/></svg>',
          brandName: 'Nope',
          sources: nodeWasmSources(),
          fonts,
        }),
      /true-vector/i,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern buildPack`
Expected: FAIL with `Cannot find module './index.js'`.

- [ ] **Step 3: Write the gate barrel**

`apps/logosmith-bot/src/gates/index.ts`:

```typescript
// Single import site for every gate, so pipeline code reads as a checklist.
export * from './dimensions.js';
export * from './ico.js';
export * from './phash.js';
export * from './vector.js';
export * from './zip.js';
```

- [ ] **Step 4: Write the orchestrator**

`apps/logosmith-bot/src/pack/index.ts`:

```typescript
// buildPack (FR-11 + FR-13): winner SVG in, fully gated brand pack out.
//
// Order matters. The true-vector gate runs FIRST and throws — every later step
// renders *from* this SVG, so building a pack from a raster-wrapping "SVG"
// would produce artifacts that all individually pass while the deliverable is
// exactly the fraud §9 exists to prevent.

import { FAVICON_SIZES, ICO_SIZES, MASTER_SIZES } from '../config.js';
import {
  checkDimensions,
  checkIco,
  checkTrueVector,
  checkZipCompleteness,
  readPngDimensions,
  type DimensionsResult,
  type IcoGateResult,
  type VectorGateResult,
  type ZipGateResult,
} from '../gates/index.js';
import type { FontPairing } from './fonts.js';
import { assembleIco } from './ico.js';
import { traceMonoSvg } from './mono.js';
import { extractPalette, type Swatch } from './palette.js';
import { renderSvgToPixmap, renderSvgToPng } from './render.js';
import type { WasmSources } from './wasm.js';
import { buildHtmlSnippet, buildWebmanifest, zipFiles } from './zip.js';

export interface PackInput {
  svg: string;
  brandName: string;
  sources: WasmSources;
  fonts: FontPairing;
}

export interface BrandJson {
  brandName: string;
  colors: Swatch[];
  fonts: FontPairing;
  licenseNote: string;
}

export interface PackGateReport {
  vector: VectorGateResult;
  dimensions: Array<{ file: string } & DimensionsResult>;
  ico: IcoGateResult;
  zip: ZipGateResult;
  pass: boolean;
}

export interface PackResult {
  zip: Uint8Array;
  files: Record<string, Uint8Array>;
  brand: BrandJson;
  gates: PackGateReport;
}

const FAVICON_FILENAMES: Record<number, string> = {
  16: 'favicon-16.png',
  32: 'favicon-32.png',
  48: 'favicon-48.png',
  180: 'apple-touch-icon.png',
  192: 'icon-192.png',
  512: 'icon-512.png',
};

export async function buildPack(input: PackInput): Promise<PackResult> {
  const { svg, brandName, sources, fonts } = input;

  const vector = checkTrueVector(svg);
  if (!vector.pass) {
    throw new Error(`refusing to build a pack: true-vector gate failed — ${vector.violations.join('; ')}`);
  }

  const files: Record<string, Uint8Array> = {};
  const dimensions: Array<{ file: string } & DimensionsResult> = [];
  const encoder = new TextEncoder();

  const record = (file: string, png: Uint8Array, size: number): void => {
    files[file] = png;
    const actual = readPngDimensions(png) ?? { width: -1, height: -1 };
    dimensions.push({ file, ...checkDimensions(actual, { width: size, height: size }) });
  };

  // Masters and favicons are each rendered from the vector at their exact
  // target size — never resized from a larger raster (FR-11).
  for (const size of MASTER_SIZES) {
    record(`logo-color-${size}.png`, await renderSvgToPng(svg, size, sources), size);
  }
  for (const size of FAVICON_SIZES) {
    record(FAVICON_FILENAMES[size]!, await renderSvgToPng(svg, size, sources), size);
  }

  // Mono mark: threshold + trace the 1024px pixmap, then render its own master.
  const masterPixmap = await renderSvgToPixmap(svg, 1024, sources);
  const monoSvg = await traceMonoSvg(masterPixmap, sources);
  files['logo-mono.svg'] = encoder.encode(monoSvg);
  record('logo-mono-1024.png', await renderSvgToPng(monoSvg, 1024, sources), 1024);

  // favicon.ico reuses the already-rendered 16/32/48 PNGs.
  const ico = assembleIco(ICO_SIZES.map((size) => ({ size, png: files[FAVICON_FILENAMES[size]!]! })));
  files['favicon.ico'] = ico;

  const brand: BrandJson = {
    brandName,
    colors: extractPalette(masterPixmap),
    fonts,
    licenseNote:
      'Colour codes are extracted from the delivered mark. The font pairing is an advisory ' +
      'recommendation and is not a warranted property of this delivery.',
  };

  files['logo.svg'] = encoder.encode(svg);
  files['site.webmanifest'] = encoder.encode(buildWebmanifest(brandName));
  files['snippet.html'] = encoder.encode(buildHtmlSnippet());
  files['brand.json'] = encoder.encode(JSON.stringify(brand, null, 2));

  const zip = zipFiles(files);
  const gates: PackGateReport = {
    vector,
    dimensions,
    ico: checkIco(ico),
    zip: checkZipCompleteness(zip),
    pass: false,
  };
  gates.pass =
    gates.vector.pass &&
    gates.dimensions.every((d) => d.pass) &&
    gates.ico.pass &&
    gates.zip.pass;

  return { zip, files, brand, gates };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern buildPack`
Expected: PASS — 4 tests.

- [ ] **Step 6: Measure the bundle and peak memory (the §13 risk checkpoint)**

This is the moment the plan deliberately reaches early. Run:

```bash
cd apps/logosmith-bot && pnpm exec wrangler deploy --dry-run --outdir /tmp/logosmith-bundle
du -sh /tmp/logosmith-bundle
```

Record the compressed bundle size in the commit message. If it approaches the Workers limit, or if the 2048 px render in the test above shows runaway memory, **stop and escalate** — §16 names a plain Cloudflare Container for the pack stage as the fallback, and taking it here is far cheaper than at Task 21.

- [ ] **Step 7: Commit**

```bash
git add apps/logosmith-bot/src/pack/index.ts apps/logosmith-bot/src/gates/index.ts apps/logosmith-bot/src/pack/index.test.ts
git commit -m "feat(logosmith): buildPack orchestration with full gate report

Bundle size after the full WASM set: <record the du output here>.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Phase C — State and Worker entry

### Task 11: D1 stores — stage claims, checkpoints, concepts, selection, quotas

**Files:**
- Create: `apps/logosmith-bot/src/jobs.ts`
- Test: `apps/logosmith-bot/src/jobs.test.ts`

**Interfaces:**
- Consumes: `D1Like` from `@botguild/agent-core-workers`; types from `./types.js`; `applyMigrations` from `./testSupport.js` (tests only).
- Produces:
  - `sha256Hex(input: string): Promise<string>`
  - `randomDeliverableToken(): string`
  - `buildJobKey(contractId: string, stage: JobStage): Promise<string>`
  - `decideOnConflict(row): ClaimDecision`
  - `createJobStore(db, now?): JobStore` — `claim`, `get`, `getByToken`, `setInProgress`, `saveCheckpoint`, `park`, `unpark`, `incrementModerationAttempts`, `markDelivered`, `listParked`, `listStuckClaims`, `recordGateAudit`
  - `createConceptStore(db, now?): ConceptStore` — `upsert`, `list`, `listPassing`
  - `createSelectionStore(db, now?): SelectionStore` — `open`, `get`, `select`, `markPackDelivered`, `listAwaitingSelection`
  - `createQuotaStore(db, now?): QuotaStore` — `countRecent`, `record`
  - `saveReputationSnapshot(db, snapshot, now?)` / `loadReputationSnapshot(db)`

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/jobs.test.ts`:

```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import type { D1Like } from '@botguild/agent-core-workers';
import { applyMigrations } from './testSupport.js';
import {
  buildJobKey,
  createConceptStore,
  createJobStore,
  createQuotaStore,
  createSelectionStore,
  decideOnConflict,
  randomDeliverableToken,
} from './jobs.js';

let db: D1Like;
beforeEach(async () => {
  db = createMemoryD1();
  await applyMigrations(db);
});

describe('buildJobKey', () => {
  it('produces a distinct key per stage for the same contract', async () => {
    const concepts = await buildJobKey('c1', 'concepts');
    const vector = await buildJobKey('c1', 'vector');
    assert.notEqual(concepts, vector);
    assert.ok(concepts.endsWith(':concepts'));
    assert.ok(vector.endsWith(':vector'));
  });

  it('is stable across calls', async () => {
    assert.equal(await buildJobKey('c1', 'concepts'), await buildJobKey('c1', 'concepts'));
  });
});

describe('randomDeliverableToken', () => {
  it('is 64 hex characters and not derived from anything', () => {
    const a = randomDeliverableToken();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, randomDeliverableToken());
  });
});

describe('decideOnConflict', () => {
  it('re-enqueues a bare claim whose queue send may have been lost', () => {
    assert.deepEqual(decideOnConflict({ status: 'claimed', checkpoint: null }), {
      action: 'enqueue',
      reason: 'claimed-not-checkpointed',
    });
  });

  it('skips delivered, parked, in-progress, and checkpointed jobs', () => {
    assert.equal(decideOnConflict({ status: 'delivered', checkpoint: null }).action, 'skip');
    assert.equal(decideOnConflict({ status: 'parked', checkpoint: null }).action, 'skip');
    assert.equal(decideOnConflict({ status: 'in_progress', checkpoint: null }).action, 'skip');
    assert.equal(
      decideOnConflict({ status: 'claimed', checkpoint: { slots: [], spendUsd: 0 } }).action,
      'skip',
    );
  });
});

describe('JobStore', () => {
  it('claims once and re-enqueues on a redelivered webhook', async () => {
    const jobs = createJobStore(db);
    const key = await buildJobKey('c1', 'concepts');
    assert.deepEqual(await jobs.claim(key, 'c1', 'concepts'), {
      action: 'enqueue',
      reason: 'fresh-claim',
    });
    assert.deepEqual(await jobs.claim(key, 'c1', 'concepts'), {
      action: 'enqueue',
      reason: 'claimed-not-checkpointed',
    });
  });

  it('lets both stages of one contract claim independently', async () => {
    const jobs = createJobStore(db);
    const a = await jobs.claim(await buildJobKey('c1', 'concepts'), 'c1', 'concepts');
    const b = await jobs.claim(await buildJobKey('c1', 'vector'), 'c1', 'vector');
    assert.equal(a.action, 'enqueue');
    assert.equal(b.action, 'enqueue');
  });

  it('does not re-enqueue once the consumer has started', async () => {
    const jobs = createJobStore(db);
    const key = await buildJobKey('c1', 'concepts');
    await jobs.claim(key, 'c1', 'concepts');
    await jobs.setInProgress(key, { kind: 'logo', gigId: 'g1', payerId: 'p1', briefJson: '{}' });
    assert.equal((await jobs.claim(key, 'c1', 'concepts')).action, 'skip');
  });

  it('resumes spend from the checkpoint rather than restarting it', async () => {
    const jobs = createJobStore(db);
    const key = await buildJobKey('c1', 'concepts');
    await jobs.claim(key, 'c1', 'concepts');
    await jobs.saveCheckpoint(key, { slots: [], spendUsd: 1.75 });
    const row = await jobs.get(key);
    assert.equal(row?.spentUsd, 1.75);
    assert.equal(row?.checkpoint?.spendUsd, 1.75);
  });

  it('finds a job by its deliverable token', async () => {
    const jobs = createJobStore(db);
    const key = await buildJobKey('c1', 'concepts');
    await jobs.claim(key, 'c1', 'concepts');
    const token = (await jobs.get(key))!.deliverableToken!;
    assert.equal((await jobs.getByToken(token))?.jobKey, key);
    assert.equal(await jobs.getByToken('0'.repeat(64)), null);
  });

  it('parks, unparks, and lists parked jobs by reason', async () => {
    const jobs = createJobStore(db);
    const key = await buildJobKey('c1', 'concepts');
    await jobs.claim(key, 'c1', 'concepts');
    await jobs.park(key, 'moderation_outage');
    assert.equal((await jobs.listParked('moderation_outage')).length, 1);
    await jobs.unpark(key);
    assert.equal((await jobs.listParked()).length, 0);
  });

  it('lists stuck claims older than the cutoff with no checkpoint', async () => {
    const past = new Date('2026-07-30T00:00:00.000Z');
    const jobs = createJobStore(db, () => past);
    await jobs.claim(await buildJobKey('c1', 'concepts'), 'c1', 'concepts');
    assert.equal((await jobs.listStuckClaims(new Date('2026-07-30T01:00:00.000Z'))).length, 1);
    assert.equal((await jobs.listStuckClaims(new Date('2026-07-29T00:00:00.000Z'))).length, 0);
  });

  it('records gate audit entries', async () => {
    const jobs = createJobStore(db);
    await jobs.recordGateAudit({
      jobKey: 'k',
      contractId: 'c1',
      slot: 2,
      gate: 'ocr',
      result: 'fail',
      detail: { score: 0.4 },
    });
    const row = await db
      .prepare('SELECT gate, result, detail_json FROM gate_audit WHERE job_key = ?')
      .bind('k')
      .first<{ gate: string; result: string; detail_json: string }>();
    assert.equal(row?.gate, 'ocr');
    assert.deepEqual(JSON.parse(row!.detail_json), { score: 0.4 });
  });
});

describe('ConceptStore', () => {
  it('upserts a slot and lists concepts in slot order', async () => {
    const concepts = createConceptStore(db);
    await concepts.upsert({
      contractId: 'c1',
      slot: 2,
      axisId: 'lockup',
      vendor: 'recraft',
      ocrPass: true,
      ocrScore: 0.95,
    });
    await concepts.upsert({
      contractId: 'c1',
      slot: 1,
      axisId: 'wordmark',
      vendor: 'ideogram',
      ocrPass: false,
      ocrScore: 0.4,
    });
    const rows = await concepts.list('c1');
    assert.deepEqual(rows.map((r) => r.slot), [1, 2]);
  });

  it('overwrites a slot on regeneration rather than duplicating it', async () => {
    const concepts = createConceptStore(db);
    await concepts.upsert({ contractId: 'c1', slot: 1, axisId: 'a', vendor: 'ideogram', ocrScore: 0.4 });
    await concepts.upsert({ contractId: 'c1', slot: 1, axisId: 'a', vendor: 'ideogram', ocrScore: 0.9 });
    const rows = await concepts.list('c1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.ocrScore, 0.9);
  });

  it('lists only passing concepts, best OCR score first', async () => {
    const concepts = createConceptStore(db);
    await concepts.upsert({ contractId: 'c1', slot: 1, axisId: 'a', vendor: 'v', ocrPass: true, ocrScore: 0.9 });
    await concepts.upsert({ contractId: 'c1', slot: 2, axisId: 'b', vendor: 'v', ocrPass: false, ocrScore: 0.99 });
    await concepts.upsert({ contractId: 'c1', slot: 3, axisId: 'c', vendor: 'v', ocrPass: true, ocrScore: 0.95 });
    const passing = await concepts.listPassing('c1');
    assert.deepEqual(passing.map((r) => r.slot), [3, 1]);
  });
});

describe('SelectionStore', () => {
  it('walks concepts_delivered → winner_selected → pack_delivered', async () => {
    const selection = createSelectionStore(db);
    await selection.open('c1');
    assert.equal((await selection.get('c1'))?.state, 'concepts_delivered');
    await selection.select('c1', 2, 'buyer');
    const selected = await selection.get('c1');
    assert.equal(selected?.state, 'winner_selected');
    assert.equal(selected?.winnerSlot, 2);
    assert.equal(selected?.source, 'buyer');
    await selection.markPackDelivered('c1');
    assert.equal((await selection.get('c1'))?.state, 'pack_delivered');
  });

  it('does not let a late buyer reply overwrite a default selection', async () => {
    const selection = createSelectionStore(db);
    await selection.open('c1');
    await selection.select('c1', 1, 'default');
    await selection.select('c1', 3, 'buyer');
    const row = await selection.get('c1');
    assert.equal(row?.winnerSlot, 1);
    assert.equal(row?.source, 'default');
  });

  it('lists contracts still awaiting selection past the cutoff', async () => {
    const past = new Date('2026-07-30T00:00:00.000Z');
    const selection = createSelectionStore(db, () => past);
    await selection.open('c1');
    const due = await selection.listAwaitingSelection(new Date('2026-08-02T01:00:00.000Z'));
    assert.deepEqual(due.map((r) => r.contractId), ['c1']);
    assert.equal((await selection.listAwaitingSelection(past)).length, 0);
  });
});

describe('QuotaStore', () => {
  it("counts a payer's free gigs inside the rolling window", async () => {
    const quota = createQuotaStore(db, () => new Date('2026-07-30T00:00:00.000Z'));
    await quota.record('p1', 'favicon', 'c1');
    await quota.record('p1', 'taster', 'c2');
    await quota.record('p2', 'favicon', 'c3');
    assert.equal(await quota.countRecent('p1', 30), 2);
    assert.equal(await quota.countRecent('p2', 30), 1);
    assert.equal(await quota.countRecent('p3', 30), 0);
  });

  it('excludes usage older than the window', async () => {
    let now = new Date('2026-06-01T00:00:00.000Z');
    const quota = createQuotaStore(db, () => now);
    await quota.record('p1', 'favicon', 'c1');
    now = new Date('2026-07-30T00:00:00.000Z');
    assert.equal(await quota.countRecent('p1', 30), 0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern "JobStore|ConceptStore|SelectionStore|QuotaStore"`
Expected: FAIL with `Cannot find module './jobs.js'`.

- [ ] **Step 3: Write the stores**

`apps/logosmith-bot/src/jobs.ts`:

```typescript
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
}

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

export function createJobStore(db: D1Like, now: () => Date = () => new Date()): JobStore {
  const touch = (): string => now().toISOString();

  async function get(jobKey: string): Promise<JobRow | null> {
    const raw = await db.prepare('SELECT * FROM jobs WHERE job_key = ?').bind(jobKey).first<RawJobRow>();
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
        .bind('in_progress', fields.kind, fields.gigId, fields.payerId, fields.briefJson, touch(), jobKey)
        .run();
    },

    async saveCheckpoint(jobKey, checkpoint) {
      await db
        .prepare('UPDATE jobs SET checkpoint_json = ?, spent_usd = ?, updated_at = ? WHERE job_key = ?')
        .bind(JSON.stringify(checkpoint), checkpoint.spendUsd, touch(), jobKey)
        .run();
    },

    async park(jobKey, reason) {
      await db
        .prepare('UPDATE jobs SET status = ?, park_reason = ?, updated_at = ? WHERE job_key = ?')
        .bind('parked', reason, touch(), jobKey)
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
      const ts = touch();
      await db
        .prepare(
          'UPDATE jobs SET status = ?, outcome = ?, delivered_at = ?, updated_at = ? WHERE job_key = ?',
        )
        .bind('delivered', outcome, ts, ts, jobKey)
        .run();
    },

    async listParked(reason) {
      const query = reason
        ? db.prepare('SELECT * FROM jobs WHERE status = ? AND park_reason = ?').bind('parked', reason)
        : db.prepare('SELECT * FROM jobs WHERE status = ?').bind('parked');
      const { results } = await query.all<RawJobRow>();
      return results.map(toJobRow);
    },

    async listStuckClaims(olderThan) {
      const { results } = await db
        .prepare('SELECT * FROM jobs WHERE status = ? AND checkpoint_json IS NULL AND created_at < ?')
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

export function createSelectionStore(db: D1Like, now: () => Date = () => new Date()): SelectionStore {
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern "JobStore|ConceptStore|SelectionStore|QuotaStore|buildJobKey|decideOnConflict|randomDeliverableToken"`
Expected: PASS — 22 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/logosmith-bot/src/jobs.ts apps/logosmith-bot/src/jobs.test.ts
git commit -m "feat(logosmith): D1 stores for claims, concepts, selection, and quotas

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Worker entry — bindings, service graph, webhook handlers, routes

**Files:**
- Create: `apps/logosmith-bot/src/index.ts`
- Create: `apps/logosmith-bot/src/assets.d.ts`
- Test: `apps/logosmith-bot/src/handlers.test.ts`

**Interfaces:**
- Consumes: `createWorkersWebhookApp`, `withOwnershipFilter`, `ensureRegisteredWorkers`, `createD1WebhookSecretStore`, `createD1NegotiationStore`, `createKVSeenStore`, `createConsoleLogger` from `@botguild/agent-core-workers`; `AgentClient`, `AgentMcpClient`, `createCostEstimator`, `createProposer`, `logContractReview` from `@botguild/agent-core`; the stores from `./jobs.js`.
- Produces: `interface Env`; the default export `{ fetch, scheduled, queue }`; and — extracted so they are testable without bindings — `buildWebhookHandlers(deps): Record<string, WebhookHandler>` and `resolveDeliverable(token, file): { key: string; contentType: string } | null`.

> **Testability rule:** `index.ts` is the only module allowed to touch a real binding, so the *decisions* inside it (which stage a webhook claims, what a deliverable path resolves to) are pure functions exported from `index.ts` and unit-tested directly. Wiring is not tested; policy is.

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/handlers.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeliverable } from './index.js';

describe('resolveDeliverable', () => {
  it('maps a whitelisted file to its R2 key and content type', () => {
    const token = 'a'.repeat(64);
    assert.deepEqual(resolveDeliverable(token, 'pack.zip'), {
      key: `${token}/pack.zip`,
      contentType: 'application/zip',
    });
    assert.equal(resolveDeliverable(token, 'report.json')?.contentType, 'application/json');
    assert.equal(resolveDeliverable(token, 'concept-1.png')?.contentType, 'image/png');
  });

  it('rejects a file that is not whitelisted', () => {
    assert.equal(resolveDeliverable('a'.repeat(64), 'secrets.env'), null);
    assert.equal(resolveDeliverable('a'.repeat(64), '../../etc/passwd'), null);
  });

  it('rejects a token that is not 64 hex characters', () => {
    assert.equal(resolveDeliverable('short', 'pack.zip'), null);
    assert.equal(resolveDeliverable('g'.repeat(64), 'pack.zip'), null);
  });

  it('accepts only the three concept slots', () => {
    const token = 'a'.repeat(64);
    assert.ok(resolveDeliverable(token, 'concept-3.png'));
    assert.equal(resolveDeliverable(token, 'concept-4.png'), null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern resolveDeliverable`
Expected: FAIL with `Cannot find module './index.js'`.

- [ ] **Step 3: Write the Worker entry**

`apps/logosmith-bot/src/index.ts`:

```typescript
// ---------------------------------------------------------------------------
// LogoSmith Worker entry — the ONLY module that touches Workers bindings.
//
//   fetch:     POST /webhook               (shim app: HMAC verify → handlers)
//              GET  /health                (shim app + D1-cached reputation)
//              GET  /deliverables/:token/:file
//              GET  /p/:token  +  /p/:token/events   (progress page, FR-7)
//              POST /admin/register        (protected; run once at deploy)
//   queue:     logosmith-jobs consumer + DLQ alerting
//   scheduled: 15-min sweep and daily sweep, dispatched by cron expression
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import {
  AgentClient,
  AgentMcpClient,
  createCostEstimator,
  createProposer,
  logContractReview,
} from '@botguild/agent-core';
import type { CostEstimator, Proposer } from '@botguild/agent-core';
import {
  createConsoleLogger,
  createD1NegotiationStore,
  createD1WebhookSecretStore,
  createKVSeenStore,
  createWorkersWebhookApp,
  ensureRegisteredWorkers,
  withOwnershipFilter,
  type D1WebhookSecretStore,
  type WebhookHandler,
} from '@botguild/agent-core-workers';
import type { Hono } from 'hono';
// Bundled wasm — wrangler compiles .wasm imports to CompiledWasm modules;
// assets.d.ts supplies the TypeScript module type. Node tests never import
// these (wasm.node.ts reads the same files off disk). The potrace path carries
// the Task 3 hedge: if the package ships its wasm elsewhere, fix the specifier
// here and in wasm.node.ts together.
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import potraceWasm from 'esm-potrace-wasm/dist/potrace.wasm';
import { botProfile, fallbackEstimate, pricingCalc, rateCard } from './config.js';
import {
  buildJobKey,
  createConceptStore,
  createJobStore,
  createQuotaStore,
  createSelectionStore,
  loadReputationSnapshot,
  type ConceptStore,
  type JobStore,
  type QuotaStore,
  type SelectionStore,
} from './jobs.js';
import { renderProgressPage, renderProgressEvent } from './progress.js';
import { processJobMessage, type PipelineConfig } from './pipeline.js';
import {
  resolveSelectionForContract,
  runDailySweep,
  runFifteenMinuteSweep,
  type SweepServices,
} from './sweeps.js';
import type { JobMessage } from './types.js';

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  DELIVERABLES: R2Bucket;
  JOBS: Queue<JobMessage>;
  AI: Ai;
  // wrangler.jsonc vars
  WEBHOOK_BASE_URL: string;
  // wrangler secrets (.dev.vars locally)
  BOTGUILD_API_URL: string;
  BOTGUILD_API_KEY: string;
  BOTGUILD_BOT_ID: string;
  ANTHROPIC_API_KEY: string;
  MODERATION_API_KEY: string;
  IDEOGRAM_API_KEY: string;
  RECRAFT_API_KEY: string;
  VECTORIZER_AI_TOKEN: string;
  GOOGLE_FONTS_API_KEY: string;
  /** Protects POST /admin/register. Unset ⇒ the route is disabled. */
  ADMIN_TOKEN?: string;
}

const SERVICE = 'logosmith-bot';
const DAILY_CRON = '0 6 * * *'; // the */15 sweep is the default branch

// --- Pure policy (unit-tested; no bindings) ---------------------------------

const DELIVERABLE_TYPES: Record<string, string> = {
  'pack.zip': 'application/zip',
  'report.json': 'application/json',
  'licenses.json': 'application/json',
  'concept-1.png': 'image/png',
  'concept-2.png': 'image/png',
  'concept-3.png': 'image/png',
};

/**
 * Resolve a deliverables request to an R2 key. The path segment is the per-job
 * unguessable capability token (§12) — never the recomputable job key — and
 * file names are whitelisted, so the R2 namespace is neither enumerable nor
 * derivable from a known contract id.
 */
export function resolveDeliverable(
  token: string,
  file: string,
): { key: string; contentType: string } | null {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const contentType = DELIVERABLE_TYPES[file];
  if (!contentType) return null;
  return { key: `${token}/${file}`, contentType };
}

// --- Service graph ----------------------------------------------------------

interface Services {
  logger: Logger;
  client: AgentClient;
  secretStore: D1WebhookSecretStore;
  jobs: JobStore;
  concepts: ConceptStore;
  selection: SelectionStore;
  quota: QuotaStore;
  proposer: Proposer;
  freeProposer: Proposer;
  costEstimator: CostEstimator;
  pipeline: PipelineConfig;
  sweeps: SweepServices;
  app: Hono;
}

// One service graph per isolate — env bindings are stable for its lifetime.
let services: Services | undefined;

function getServices(env: Env): Services {
  if (services) return services;

  const botId = env.BOTGUILD_BOT_ID;
  const logger = createConsoleLogger({ service: SERVICE, botId });
  const client = new AgentClient({
    apiUrl: env.BOTGUILD_API_URL,
    apiKey: env.BOTGUILD_API_KEY,
    botId,
    logger,
  });
  const mcpClient = new AgentMcpClient({
    apiUrl: env.BOTGUILD_API_URL,
    apiKey: env.BOTGUILD_API_KEY,
    logger,
  });

  const secretStore = createD1WebhookSecretStore(env.DB);
  const jobs = createJobStore(env.DB);
  const concepts = createConceptStore(env.DB);
  const selection = createSelectionStore(env.DB);
  const quota = createQuotaStore(env.DB);

  const costEstimator = createCostEstimator({
    apiKey: env.ANTHROPIC_API_KEY,
    botName: botProfile.name,
    botDescription: botProfile.bio,
    rateCard,
    fallbackEstimate,
    logger,
  });
  const proposerProfile = {
    name: botProfile.name,
    category: botProfile.category,
    capabilities: botProfile.toolchain,
    workingStyle: botProfile.workingStyle,
    warrantyTerms: botProfile.warrantyTerms,
  };
  const proposer = createProposer({
    apiKey: env.ANTHROPIC_API_KEY,
    botProfile: proposerProfile,
    pricingCalc,
    costEstimator,
    logger,
  });
  // No estimator: the FREE gigs must bid their $0 anchor, and the estimator
  // would floor the bid at 1.5x cost.
  const freeProposer = createProposer({
    apiKey: env.ANTHROPIC_API_KEY,
    botProfile: proposerProfile,
    pricingCalc,
    logger,
  });

  const publicBaseUrl = env.WEBHOOK_BASE_URL.replace(/\/$/, '');

  // Bindings are adapted to the structural interfaces the pipeline consumes, so
  // every module below this line stays Node-testable.
  const pipeline: PipelineConfig = {
    jobs,
    concepts,
    selection,
    quota,
    client,
    ai: env.AI,
    deliverables: {
      put: async (key, value, contentType) => {
        await env.DELIVERABLES.put(key, value, { httpMetadata: { contentType } });
      },
      // Stage 2 reads the winner's artifacts back (Task 21); null on a miss.
      get: async (key) => {
        const object = await env.DELIVERABLES.get(key);
        return object ? new Uint8Array(await object.arrayBuffer()) : null;
      },
    },
    // Once-per-isolate wasm sources for the pack stack (pack/wasm.ts memoizes
    // the init promises; these callbacks just hand over the bundled modules).
    sources: { resvg: () => resvgWasm, potrace: () => potraceWasm },
    secrets: {
      moderationApiKey: env.MODERATION_API_KEY,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      ideogramApiKey: env.IDEOGRAM_API_KEY,
      recraftApiKey: env.RECRAFT_API_KEY,
      vectorizerToken: env.VECTORIZER_AI_TOKEN,
      googleFontsApiKey: env.GOOGLE_FONTS_API_KEY,
    },
    fetchImpl: (url, init) => fetch(url, init),
    publicBaseUrl,
    logger,
  };

  const sweeps: SweepServices = {
    db: env.DB,
    client,
    jobs,
    concepts,
    selection,
    seen: createKVSeenStore(env.CACHE),
    negotiationStore: createD1NegotiationStore(env.DB),
    reputationSource: mcpClient,
    proposer,
    freeProposer,
    costEstimator,
    queue: env.JOBS,
    apiUrl: env.BOTGUILD_API_URL,
    apiKey: env.BOTGUILD_API_KEY,
    botId,
    logger,
  };

  const app = buildApp(env, { logger, client, secretStore, jobs, concepts, selection, botId });
  services = {
    logger,
    client,
    secretStore,
    jobs,
    concepts,
    selection,
    quota,
    proposer,
    freeProposer,
    costEstimator,
    pipeline,
    sweeps,
    app,
  };
  return services;
}

function buildApp(
  env: Env,
  deps: {
    logger: Logger;
    client: AgentClient;
    secretStore: D1WebhookSecretStore;
    jobs: JobStore;
    concepts: ConceptStore;
    selection: SelectionStore;
    botId: string;
  },
): Hono {
  const { logger, client, secretStore, jobs, concepts, selection, botId } = deps;

  // Funding starts stage 1 only. Stage 2 (`vector`) is claimed by the selection
  // sweep, not by a webhook — the payload has no milestone id and M2 begins
  // when a winner exists, not when escrow is funded (FR-15).
  const onMilestoneFunded: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    const jobKey = await buildJobKey(contractId, 'concepts');
    const decision = await jobs.claim(jobKey, contractId, 'concepts');
    logger.info({ contractId, jobKey, ...decision }, 'milestone.funded claim decision');
    if (decision.action === 'enqueue') {
      await env.JOBS.send({ contractId, jobKey, stage: 'concepts' });
    }
  };

  const onProposalAccepted: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    await client.sendMessage(
      contractId,
      'Proposal accepted — concept generation begins as soon as escrow is funded.',
    );
  };

  // M1 acceptance and auto-accept are FR-9 selection triggers: a buyer who
  // accepted the concepts without ever posting a selection gets the thread read
  // once more, then the default rule — instead of idling until the 72 h cron
  // timeout. The helper no-ops unless the selection row is at
  // `concepts_delivered`, so M2-side events fall through harmlessly.
  const selectionDeps = () => ({
    client,
    jobs,
    selection,
    queue: env.JOBS,
    apiUrl: env.BOTGUILD_API_URL,
    apiKey: env.BOTGUILD_API_KEY,
    botId,
    logger,
  });

  const onMilestoneAccepted: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    await logContractReview({ client, contractId, logger });
    await resolveSelectionForContract(selectionDeps(), contractId, { force: true });
  };

  const onAutoApproved: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    await resolveSelectionForContract(selectionDeps(), contractId, { force: true });
  };

  const logOnly =
    (eventType: string): WebhookHandler =>
    async (event) => {
      logger.info({ eventType, payload: event.payload }, 'lifecycle event received');
    };

  const ownership = { client, botId, logger };
  const app = createWorkersWebhookApp({
    // Resolved from D1 on every delivery by design: the platform issues the
    // secret at runtime and a fresh registration must take effect without an
    // isolate restart. Empty/missing secret ⇒ 503 and the platform retries.
    secret: async () => (await secretStore.loadWebhookSecret())?.secret ?? '',
    botId,
    logger,
    handlers: {
      // Contract-scoped handlers are ownership-filtered: webhooks are
      // handler-scoped and sibling bots' events WILL arrive here (FR-16).
      'milestone.funded': withOwnershipFilter(onMilestoneFunded, ownership),
      'proposal.accepted': withOwnershipFilter(onProposalAccepted, ownership),
      'milestone.accepted': withOwnershipFilter(onMilestoneAccepted, ownership),
      'milestone.delivered': logOnly('milestone.delivered'),
      'acceptance.auto_approved': withOwnershipFilter(onAutoApproved, ownership),
      'contract.status.changed': logOnly('contract.status.changed'),
      'dispute.response_submitted': logOnly('dispute.response_submitted'),
    },
    healthExtra: async () => {
      const reputation = await loadReputationSnapshot(env.DB).catch(() => null);
      return reputation ? { reputation } : {};
    },
  });

  app.get('/deliverables/:token/:file', async (c) => {
    const resolved = resolveDeliverable(c.req.param('token'), c.req.param('file'));
    if (!resolved) return c.json({ error: 'Not found' }, 404);
    const object = await env.DELIVERABLES.get(resolved.key);
    if (!object) return c.json({ error: 'Not found' }, 404);
    return new Response(object.body as ReadableStream, {
      headers: {
        'Content-Type': resolved.contentType,
        'Content-Disposition': `attachment; filename="logosmith-${c.req.param('file')}"`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  // Progress/evidence page (FR-7): public, unguessable, read-only, no PII.
  app.get('/p/:token', async (c) => {
    const job = await jobs.getByToken(c.req.param('token'));
    if (!job) return c.text('Not found', 404);
    const rows = await concepts.list(job.contractId);
    return c.html(renderProgressPage(job, rows));
  });

  app.get('/p/:token/events', async (c) => {
    const job = await jobs.getByToken(c.req.param('token'));
    if (!job) return c.text('Not found', 404);
    const rows = await concepts.list(job.contractId);
    // A single snapshot frame then close: the client reconnects on the SSE
    // retry interval, which degrades to plain polling if SSE is unavailable.
    return new Response(renderProgressEvent(job, rows), {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      },
    });
  });

  // Registration runs from an explicit trigger (§10.2): this admin route once
  // at deploy, with a first-run branch of the cron sweep as backstop.
  app.post('/admin/register', async (c) => {
    if (!env.ADMIN_TOKEN) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
    if ((c.req.header('Authorization') ?? '') !== `Bearer ${env.ADMIN_TOKEN}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const result = await ensureRegisteredWorkers({
      client,
      registration: {
        apiUrl: env.BOTGUILD_API_URL,
        apiKey: env.BOTGUILD_API_KEY,
        botConfig: botProfile,
        logger,
      },
      webhookBaseUrl: env.WEBHOOK_BASE_URL,
      secretStore,
      logger,
    });
    return c.json(result);
  });

  return app;
}

async function scheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const s = getServices(env);
  s.logger.info({ cron: controller.cron }, 'cron sweep starting');

  if (controller.cron === DAILY_CRON) {
    await runDailySweep(s.sweeps);
    return;
  }

  // First-run registration backstop: if registration never ran (no stored
  // secret), run it before sweeping — and let a failure throw. A bot that
  // cannot verify webhooks must not look healthy.
  if ((await s.secretStore.loadWebhookSecret()) === null) {
    s.logger.warn('no stored webhook secret — running first-run registration from cron backstop');
    await ensureRegisteredWorkers({
      client: s.client,
      registration: {
        apiUrl: env.BOTGUILD_API_URL,
        apiKey: env.BOTGUILD_API_KEY,
        botConfig: botProfile,
        logger: s.logger,
      },
      webhookBaseUrl: env.WEBHOOK_BASE_URL,
      secretStore: s.secretStore,
      logger: s.logger,
    });
  }
  await runFifteenMinuteSweep(s.sweeps);
}

async function queue(
  batch: MessageBatch<JobMessage>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const s = getServices(env);

  // DLQ consumer: these exhausted their retries. They do NOT auto-replay — the
  // operator re-enqueues to logosmith-jobs, where the stage claims and
  // checkpoints make replay safe (§12 runbook).
  if (batch.queue.endsWith('-dlq')) {
    for (const message of batch.messages) {
      s.logger.error(
        { queue: batch.queue, body: message.body, messageId: message.id, attempts: message.attempts },
        'DEAD-LETTERED JOB — operator action required (see README runbook)',
      );
      message.ack();
    }
    return;
  }

  for (const message of batch.messages) {
    try {
      await processJobMessage(s.pipeline, message.body);
      message.ack();
    } catch (err) {
      s.logger.error(
        {
          err,
          contractId: message.body.contractId,
          jobKey: message.body.jobKey,
          stage: message.body.stage,
          attempts: message.attempts,
        },
        'pipeline failed with a transient error; retrying via queue',
      );
      message.retry();
    }
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> =>
    getServices(env).app.fetch(request, env, ctx),
  scheduled,
  queue,
};
```

> This file imports `./progress.js`, `./pipeline.js`, and `./sweeps.js`, which are written in Tasks 13, 18/21, and 22. Until those land, create each as a stub exporting the named symbols with `throw new Error('not implemented')` bodies so `tsc` passes; every later task replaces its stub. Record the stubs in the commit message so nothing ships unimplemented by accident.

`apps/logosmith-bot/src/assets.d.ts` (mirrors ThumbForge's `assets.d.ts` — types the bundled `.wasm` imports):

```typescript
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm -w build && cd apps/logosmith-bot && pnpm test -- --test-name-pattern resolveDeliverable`
Expected: PASS — 4 tests. Also run `pnpm --filter @botguild/logosmith-bot typecheck` and `wrangler deploy --dry-run`.

- [ ] **Step 5: Commit**

```bash
git add apps/logosmith-bot/src/index.ts apps/logosmith-bot/src/assets.d.ts apps/logosmith-bot/src/handlers.test.ts apps/logosmith-bot/src/progress.ts apps/logosmith-bot/src/pipeline.ts apps/logosmith-bot/src/sweeps.ts
git commit -m "feat(logosmith): Worker entry, webhook handlers, deliverable routes

Stubs pending: progress.ts (task 13), pipeline.ts (tasks 18/21), sweeps.ts (task 22).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Progress and evidence page

**Files:**
- Create: `apps/logosmith-bot/src/progress.ts` (replaces the Task 12 stub)
- Test: `apps/logosmith-bot/src/progress.test.ts`

**Interfaces:**
- Consumes: `JobRow`, `ConceptRow` from `./jobs.js`.
- Produces: `renderProgressPage(job: JobRow, concepts: ConceptRow[]): string`; `renderProgressEvent(job: JobRow, concepts: ConceptRow[]): string`.

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/progress.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConceptRow, JobRow } from './jobs.js';
import { renderProgressEvent, renderProgressPage } from './progress.js';

const job = {
  jobKey: 'k:concepts',
  contractId: 'c1',
  stage: 'concepts',
  deliverableToken: 'a'.repeat(64),
  status: 'in_progress',
  outcome: null,
  kind: 'logo',
  gigId: 'g1',
  payerId: 'p1',
  briefJson: '{"brandName":"Harbor & Vine"}',
  parkReason: null,
  moderationAttempts: 0,
  checkpoint: null,
  spentUsd: 0.12,
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:01:00.000Z',
  deliveredAt: null,
} as JobRow;

const concepts: ConceptRow[] = [
  {
    contractId: 'c1',
    slot: 1,
    axisId: 'wordmark',
    vendor: 'ideogram',
    vendorRequestId: 'req-1',
    r2Key: `${'a'.repeat(64)}/concept-1.png`,
    phash: '0f0f0f0f0f0f0f0f',
    ocrTranscription: 'Harbor & Vine',
    ocrScore: 0.97,
    ocrModel: 'scout',
    ocrPass: true,
    attemptsUsed: 0,
  },
  {
    contractId: 'c1',
    slot: 2,
    axisId: 'lockup',
    vendor: 'recraft',
    vendorRequestId: 'req-2',
    r2Key: null,
    phash: null,
    ocrTranscription: 'Harbcr & Vlne',
    ocrScore: 0.71,
    ocrModel: 'scout',
    ocrPass: false,
    attemptsUsed: 1,
  },
];

describe('renderProgressPage', () => {
  it('shows each concept with its OCR verdict', () => {
    const html = renderProgressPage(job, concepts);
    assert.match(html, /Harbor &amp; Vine/);
    assert.match(html, /0\.97/);
    assert.match(html, /0\.71/);
    assert.match(html, /wordmark/);
  });

  it('links delivered concepts through the token route, never r2.dev', () => {
    const html = renderProgressPage(job, concepts);
    assert.match(html, new RegExp(`/deliverables/${'a'.repeat(64)}/concept-1\\.png`));
    assert.ok(!/r2\.dev/.test(html));
  });

  it('leaks no PII — no payer id, no contract id, no gig id', () => {
    const html = renderProgressPage(job, concepts);
    assert.ok(!html.includes('p1'), 'payer id leaked');
    assert.ok(!html.includes('c1'), 'contract id leaked');
    assert.ok(!html.includes('g1'), 'gig id leaked');
  });

  it('escapes concept text so a transcription cannot inject markup', () => {
    const hostile = [{ ...concepts[0]!, ocrTranscription: '<img src=x onerror=alert(1)>' }];
    const html = renderProgressPage(job, hostile);
    assert.ok(!/<img/i.test(html));
    assert.match(html, /&lt;img/);
  });

  it('renders a waiting state when no concept has landed yet', () => {
    const html = renderProgressPage(job, []);
    assert.match(html, /generating|waiting|in progress/i);
  });
});

describe('renderProgressEvent', () => {
  it('emits a well-formed SSE frame with a retry hint', () => {
    const frame = renderProgressEvent(job, concepts);
    assert.match(frame, /^retry: \d+$/m);
    assert.match(frame, /^data: /m);
    assert.ok(frame.endsWith('\n\n'));
  });

  it('carries the concept verdicts as JSON', () => {
    const frame = renderProgressEvent(job, concepts);
    const line = frame.split('\n').find((l) => l.startsWith('data: '))!;
    const payload = JSON.parse(line.slice(6)) as { concepts: Array<{ slot: number; score: number | null }> };
    assert.equal(payload.concepts.length, 2);
    assert.equal(payload.concepts[0]!.slot, 1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern renderProgress`
Expected: FAIL — the stub throws `not implemented`.

- [ ] **Step 3: Write the module**

`apps/logosmith-bot/src/progress.ts`:

```typescript
// Per-job progress/evidence page (FR-7). Public and read-only at an unguessable
// URL, and deliberately PII-free: no payer, contract, or gig id ever reaches
// the page — the capability token is the only identifier a viewer sees.
//
// This page IS the launch demo artifact ("AI logos that can actually spell —
// proven on camera"), so the OCR verdict is shown next to every concept
// including the failures; a bot that hides its failed readbacks is not
// evidencing anything.

import type { ConceptRow, JobRow } from './jobs.js';

const SSE_RETRY_MS = 5000;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function conceptCard(concept: ConceptRow, token: string): string {
  const score = concept.ocrScore === null ? '—' : concept.ocrScore.toFixed(2);
  const verdict = concept.ocrPass ? 'PASS' : 'REGENERATING';
  const image = concept.r2Key
    ? `<img src="/deliverables/${token}/concept-${concept.slot}.png" alt="Concept ${concept.slot}" width="320">`
    : '<div class="pending">rendering…</div>';
  return [
    '<article>',
    `<h2>Concept ${concept.slot} — ${escapeHtml(concept.axisId)}</h2>`,
    image,
    `<p class="verdict ${concept.ocrPass ? 'pass' : 'fail'}">Lettering readback: <strong>${verdict}</strong> (${score})</p>`,
    `<p class="transcription">Model read: “${escapeHtml(concept.ocrTranscription ?? '')}”</p>`,
    '</article>',
  ].join('');
}

/** The full HTML page. */
export function renderProgressPage(job: JobRow, concepts: ConceptRow[]): string {
  const token = job.deliverableToken ?? '';
  const body =
    concepts.length === 0
      ? '<p class="pending">Generating concepts — this page updates automatically.</p>'
      : concepts.map((concept) => conceptCard(concept, token)).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>LogoSmith — build progress</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 60rem; padding: 2rem 1rem; }
  article { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: .75rem; margin-block: 1rem; padding: 1rem; }
  img { max-width: 100%; height: auto; border-radius: .5rem; }
  .verdict.pass { color: #157f3d; }
  .verdict.fail { color: #a8471b; }
  .transcription { font-style: italic; opacity: .8; }
  .pending { opacity: .7; }
</style>
</head>
<body>
<h1>Build progress</h1>
<p>Every concept below is checked by a vision model to confirm its lettering reads back as the brand name. Failing concepts are regenerated, never delivered.</p>
${body}
<script>
  // Each SSE connection delivers ONE snapshot frame then closes; the browser
  // reconnects on the retry interval. Reload only when the snapshot CHANGES —
  // reloading on every frame would loop the page forever, since the first
  // frame arrives immediately after every (re)connect.
  let last = null;
  const source = new EventSource(location.pathname.replace(/\\/$/, '') + '/events');
  source.onmessage = (event) => {
    if (last !== null && event.data !== last) location.reload();
    last = event.data;
  };
</script>
</body>
</html>`;
}

/** One SSE snapshot frame. The client reconnects on the retry interval, which
 *  degrades to plain polling wherever SSE is unavailable. */
export function renderProgressEvent(job: JobRow, concepts: ConceptRow[]): string {
  const payload = {
    status: job.status,
    updatedAt: job.updatedAt,
    concepts: concepts.map((concept) => ({
      slot: concept.slot,
      axisId: concept.axisId,
      score: concept.ocrScore,
      pass: concept.ocrPass,
    })),
  };
  return `retry: ${SSE_RETRY_MS}\ndata: ${JSON.stringify(payload)}\n\n`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern renderProgress`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/logosmith-bot/src/progress.ts apps/logosmith-bot/src/progress.test.ts
git commit -m "feat(logosmith): PII-free progress and evidence page with SSE frames

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Phase D — Concept pipeline

Everything from here depends on Phase 0 vendor keys. Tasks 14, 15, and 17 are testable with injected fakes and need no live key; Task 16's adapters need one live call each to confirm the request shapes, which the README runbook covers.

### Task 14: Input moderation — pinned vendor, fail-closed

**Files:**
- Create: `apps/logosmith-bot/src/moderation.ts`
- Test: `apps/logosmith-bot/src/moderation.test.ts`

**Interfaces:**
- Consumes: `FetchLike` from `./types.js`.
- Produces: `createModerationClient(deps: { fetchImpl: FetchLike; apiKey: string }): ModerationClient` with `screen(text: string): Promise<ModerationOutcome>`; `type ModerationOutcome = { status: 'clear' | 'flagged'; verdict: ModerationVerdict } | { status: 'unavailable'; error: string }`; `MODERATION_VENDOR`, `MODERATION_MODEL`.

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/moderation.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createModerationClient } from './moderation.js';

const respond = (body: unknown, status = 200): (() => Promise<Response>) =>
  async () => new Response(JSON.stringify(body), { status });

describe('moderation', () => {
  it('returns clear for an unflagged brief and snapshots the verdict', async () => {
    const client = createModerationClient({
      fetchImpl: respond({ results: [{ flagged: false, categories: {} }] }),
      apiKey: 'k',
    });
    const outcome = await client.screen('Harbor & Vine, a boutique inn');
    assert.equal(outcome.status, 'clear');
    assert.ok(outcome.status === 'clear' && outcome.verdict.model.length > 0);
    assert.ok(outcome.status === 'clear' && outcome.verdict.checkedAt.length > 0);
  });

  it('returns flagged when the vendor flags the input', async () => {
    const client = createModerationClient({
      fetchImpl: respond({ results: [{ flagged: true, categories: { violence: true } }] }),
      apiKey: 'k',
    });
    assert.equal((await client.screen('bad')).status, 'flagged');
  });

  it('fails CLOSED on a vendor error — never a pass', async () => {
    const client = createModerationClient({ fetchImpl: respond({}, 500), apiKey: 'k' });
    const outcome = await client.screen('anything');
    assert.equal(outcome.status, 'unavailable');
  });

  it('fails CLOSED on a network throw', async () => {
    const client = createModerationClient({
      fetchImpl: async () => {
        throw new Error('socket hang up');
      },
      apiKey: 'k',
    });
    assert.equal((await client.screen('anything')).status, 'unavailable');
  });

  it('fails CLOSED on a malformed response body', async () => {
    const client = createModerationClient({ fetchImpl: respond({ nope: true }), apiKey: 'k' });
    assert.equal((await client.screen('anything')).status, 'unavailable');
  });

  it('retains the vendor response verbatim for dispute evidence', async () => {
    const raw = { results: [{ flagged: false, categories: { harassment: false } }] };
    const client = createModerationClient({ fetchImpl: respond(raw), apiKey: 'k' });
    const outcome = await client.screen('x');
    assert.ok(outcome.status === 'clear');
    assert.deepEqual(outcome.verdict.response, raw);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern moderation`
Expected: FAIL with `Cannot find module './moderation.js'`.

- [ ] **Step 3: Write the module**

`apps/logosmith-bot/src/moderation.ts`:

```typescript
// Input moderation (FR-2). The brand name and brief are screened BEFORE any
// image-API call — never generate from an unscreened brief.
//
// Fail-closed is the whole point: a vendor 429, a 5xx, a network drop, or a
// body we cannot parse all return `unavailable`, and the caller parks the job
// for cron re-enqueue. An outage must never read as a pass.

import type { FetchLike } from './types.js';

export const MODERATION_VENDOR = 'openai';
export const MODERATION_MODEL = 'omni-moderation-2024-09-26';

export interface ModerationVerdict {
  vendor: string;
  model: string;
  flagged: boolean;
  /** The vendor's full response body, retained verbatim for dispute evidence. */
  response: unknown;
  checkedAt: string;
}

export type ModerationOutcome =
  | { status: 'clear'; verdict: ModerationVerdict }
  | { status: 'flagged'; verdict: ModerationVerdict }
  | { status: 'unavailable'; error: string };

export interface ModerationClient {
  screen(text: string): Promise<ModerationOutcome>;
}

export function createModerationClient(deps: {
  fetchImpl: FetchLike;
  apiKey: string;
  now?: () => Date;
}): ModerationClient {
  const now = deps.now ?? ((): Date => new Date());

  return {
    async screen(text) {
      try {
        const response = await deps.fetchImpl('https://api.openai.com/v1/moderations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${deps.apiKey}`,
          },
          body: JSON.stringify({ model: MODERATION_MODEL, input: text }),
        });
        if (!response.ok) {
          return { status: 'unavailable', error: `moderation vendor returned ${response.status}` };
        }
        const body = (await response.json()) as { results?: Array<{ flagged?: boolean }> };
        const first = body.results?.[0];
        if (!first || typeof first.flagged !== 'boolean') {
          return { status: 'unavailable', error: 'moderation response was not in the expected shape' };
        }
        const verdict: ModerationVerdict = {
          vendor: MODERATION_VENDOR,
          model: MODERATION_MODEL,
          flagged: first.flagged,
          response: body,
          checkedAt: now().toISOString(),
        };
        return first.flagged ? { status: 'flagged', verdict } : { status: 'clear', verdict };
      } catch (err) {
        return { status: 'unavailable', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes → Commit**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern moderation` — 6 tests PASS.

```bash
git add apps/logosmith-bot/src/moderation.ts apps/logosmith-bot/src/moderation.test.ts
git commit -m "feat(logosmith): fail-closed input moderation with verdict snapshots

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: Style-axis compiler

**Files:**
- Create: `apps/logosmith-bot/src/axes.ts`
- Test: `apps/logosmith-bot/src/axes.test.ts`

**Interfaces:**
- Consumes: `LogoBrief`, `StyleAxis` from `./types.js`; `HAIKU_MODEL_ID` from `./config.js`; `@anthropic-ai/sdk`.
- Produces: `DEFAULT_AXES: readonly StyleAxis[]`; `createAxisCompiler(deps): AxisCompiler` with `compile(brief: LogoBrief): Promise<StyleAxis[]>`; `buildAxisPrompt(brief, axis): string`.

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/axes.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AXES, buildAxisPrompt, createAxisCompiler } from './axes.js';
import type { LogoBrief } from './types.js';

const brief: LogoBrief = {
  brandName: 'Harbor & Vine',
  industry: 'boutique inn',
  brief: 'coastal, warm, understated luxury',
  avoid: ['anchors', 'rope'],
  palettePreference: ['#0F3D3E'],
};

describe('DEFAULT_AXES', () => {
  it('declares three distinct axes routed to the right vendors', () => {
    assert.equal(DEFAULT_AXES.length, 3);
    assert.equal(new Set(DEFAULT_AXES.map((a) => a.id)).size, 3);
    // Lettering-heavy axes go to Ideogram; the icon-led axis to Recraft (FR-4).
    assert.ok(DEFAULT_AXES.some((a) => a.vendor === 'recraft'));
    assert.ok(DEFAULT_AXES.filter((a) => a.vendor === 'ideogram').length >= 1);
  });
});

describe('buildAxisPrompt', () => {
  it('embeds the exact brand string (FR-3)', () => {
    const prompt = buildAxisPrompt(brief, DEFAULT_AXES[0]!);
    assert.ok(prompt.includes('Harbor & Vine'));
  });

  it('carries the industry, the free-text brief, and the avoid list', () => {
    const prompt = buildAxisPrompt(brief, DEFAULT_AXES[0]!);
    assert.ok(prompt.includes('boutique inn'));
    assert.ok(prompt.includes('understated luxury'));
    assert.ok(/anchors/.test(prompt));
  });

  it('works when every optional field is absent', () => {
    const prompt = buildAxisPrompt({ brandName: 'Acme', industry: 'tools' }, DEFAULT_AXES[1]!);
    assert.ok(prompt.includes('Acme'));
    assert.ok(prompt.length > 0);
  });
});

describe('createAxisCompiler', () => {
  const fakeAnthropic = (payload: unknown) => ({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    },
  });

  it('returns three axes with the brand string in every prompt', async () => {
    const compiler = createAxisCompiler({
      anthropic: fakeAnthropic({
        axes: DEFAULT_AXES.map((a) => ({ id: a.id, label: a.label, prompt: `${a.label} for Harbor & Vine` })),
      }) as never,
    });
    const axes = await compiler.compile(brief);
    assert.equal(axes.length, 3);
    for (const axis of axes) assert.ok(axis.prompt.includes('Harbor & Vine'));
  });

  it('falls back to the default axes when the model returns unusable JSON', async () => {
    const compiler = createAxisCompiler({
      anthropic: fakeAnthropic({ nope: true }) as never,
    });
    const axes = await compiler.compile(brief);
    assert.equal(axes.length, 3);
    assert.deepEqual(axes.map((a) => a.id), DEFAULT_AXES.map((a) => a.id));
  });

  it('falls back when the model call throws', async () => {
    const compiler = createAxisCompiler({
      anthropic: {
        messages: {
          create: async () => {
            throw new Error('overloaded');
          },
        },
      } as never,
    });
    assert.equal((await compiler.compile(brief)).length, 3);
  });

  it('preserves the vendor routing regardless of what the model returns', async () => {
    const compiler = createAxisCompiler({
      anthropic: fakeAnthropic({
        axes: DEFAULT_AXES.map((a) => ({ id: a.id, label: 'x', prompt: 'y', vendor: 'flux' })),
      }) as never,
    });
    const axes = await compiler.compile(brief);
    assert.deepEqual(axes.map((a) => a.vendor), DEFAULT_AXES.map((a) => a.vendor));
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write the module**

`apps/logosmith-bot/src/axes.ts`:

```typescript
// Style-axis compilation (FR-3). Haiku turns the brief into three prompts on
// three DECLARED, distinct axes. The axis ids persist to D1 and feed the
// distinctness gate — which is why the model is never allowed to choose the
// axis set or the vendor routing: it writes the prompt text, we own the
// taxonomy. A model that renamed the axes could satisfy "three distinct axis
// labels" while producing three identical lockups.

import Anthropic from '@anthropic-ai/sdk';
import { HAIKU_MODEL_ID } from './config.js';
import type { LogoBrief, StyleAxis } from './types.js';

/** The fixed v1 axis taxonomy and its vendor routing (FR-4). */
export const DEFAULT_AXES: readonly StyleAxis[] = [
  {
    id: 'wordmark',
    label: 'lettering-forward wordmark',
    prompt: '',
    vendor: 'ideogram',
  },
  {
    id: 'lockup',
    label: 'icon + wordmark lockup',
    prompt: '',
    vendor: 'ideogram',
  },
  {
    id: 'emblem',
    label: 'emblem / monogram',
    prompt: '',
    vendor: 'recraft',
  },
] as const;

/** The deterministic prompt used as the fallback and as the model's template. */
export function buildAxisPrompt(brief: LogoBrief, axis: StyleAxis): string {
  const parts = [
    `A professional ${axis.label} logo for "${brief.brandName}", a ${brief.industry}.`,
    'The brand name must be rendered as clean, correctly spelled, legible lettering.',
  ];
  if (brief.brief) parts.push(`Style direction: ${brief.brief}.`);
  if (brief.palettePreference?.length) {
    parts.push(`Preferred colours: ${brief.palettePreference.join(', ')}.`);
  }
  if (brief.avoid?.length) parts.push(`Avoid: ${brief.avoid.join(', ')}.`);
  parts.push('Flat vector style, plain background, no photographic texture, no mockup.');
  return parts.join(' ');
}

export interface AxisCompiler {
  compile(brief: LogoBrief): Promise<StyleAxis[]>;
}

// MEASURED 2026-07-30: this system prompt plus a representative user message is
// 143 tokens. Haiku 4.5's minimum cacheable prefix is 4096, so the
// `cache_control` marker below is a NO-OP — two identical live calls each
// returned cache_creation_input_tokens: 0 and cache_read_input_tokens: 0, with
// no error. The marker is kept (it is free, and becomes live if the prompt
// grows past the floor or the model changes) but prompt caching is NOT a cost
// control on this call. See the verified-live note under this task.
const SYSTEM_PROMPT =
  'You write image-generation prompts for logo design. You will be given a brand brief and three ' +
  'fixed style axes. Return ONLY JSON of the shape {"axes":[{"id":"...","label":"...","prompt":"..."}]} ' +
  'with exactly one entry per supplied axis id, preserving the ids. Each prompt must contain the ' +
  'brand name verbatim and must describe a visually distinct composition from the other two.';

export function createAxisCompiler(deps: {
  anthropic: Anthropic;
  axes?: readonly StyleAxis[];
}): AxisCompiler {
  const axes = deps.axes ?? DEFAULT_AXES;

  return {
    async compile(brief) {
      // The deterministic prompts are both the fallback and the floor: if the
      // model adds nothing usable, the job still runs.
      const fallback = axes.map((axis) => ({ ...axis, prompt: buildAxisPrompt(brief, axis) }));

      try {
        const response = await deps.anthropic.messages.create({
          model: HAIKU_MODEL_ID,
          max_tokens: 1024,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [
            {
              role: 'user',
              content: JSON.stringify({
                brief,
                axes: axes.map((a) => ({ id: a.id, label: a.label })),
                baseline: fallback.map((a) => ({ id: a.id, prompt: a.prompt })),
              }),
            },
          ],
        });

        const text = response.content.find((block) => block.type === 'text');
        if (!text || text.type !== 'text') return fallback;
        const parsed = JSON.parse(text.text) as {
          axes?: Array<{ id?: string; label?: string; prompt?: string }>;
        };
        if (!Array.isArray(parsed.axes)) return fallback;

        // Vendor routing and axis ids are ours, not the model's.
        const compiled = axes.map((axis) => {
          const match = parsed.axes!.find((a) => a.id === axis.id);
          const prompt =
            typeof match?.prompt === 'string' && match.prompt.includes(brief.brandName)
              ? match.prompt
              : buildAxisPrompt(brief, axis);
          return { ...axis, label: match?.label ?? axis.label, prompt };
        });
        return compiled;
      } catch {
        return fallback;
      }
    },
  };
}
```

> **VERIFIED LIVE 2026-07-30 — prompt caching does not engage here, and that is not a bug to fix.** The minimum cacheable prefix is **model-dependent and not monotonic**: 512 tokens on Opus 5, 1024 on Opus 4.8 / Sonnet, but **4096 on Haiku 4.5**. This task's prefix measures 143 tokens (`count_tokens`, real API), and two identical live calls both returned `cache_creation_input_tokens: 0` / `cache_read_input_tokens: 0` — the API accepts the `cache_control` marker and silently ignores it. Model ids confirmed: both `claude-haiku-4-5` (alias, what `config.ts` uses) and `claude-haiku-4-5-20251001` return 200; the alias is the documented preference.
>
> **Consequence for the fleet, not just this task.** `CLAUDE.md` lists "**Prompt caching** — Always cache the Claude system prompt to control token costs" as a key design decision, and `agent-core`'s `proposer.ts:179` and `estimator.ts:221` both set `cache_control` on Haiku calls. Any of those whose prefix is under 4096 tokens is paying full price while appearing to be cached. `proposer.ts` already logs `cacheCreationTokens` / `cacheReadTokens` — **read those fields in production before claiming caching works anywhere in this fleet.** If the numbers are zero, the options are: accept it (these prompts are small, so the absolute cost is low), grow the cached prefix past 4096, or move the call to a model with a lower floor. Do not "fix" it by deleting the marker — it is free and becomes live if either changes.

- [ ] **Step 3: Run it to verify it passes → Commit**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern "AXES|AxisPrompt|AxisCompiler"` — 8 tests PASS.

```bash
git add apps/logosmith-bot/src/axes.ts apps/logosmith-bot/src/axes.test.ts
git commit -m "feat(logosmith): Haiku style-axis compiler with deterministic fallback

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 16: Image vendor adapters — Ideogram, Recraft, FLUX

**Files:**
- Create: `apps/logosmith-bot/src/generate.ts`
- Test: `apps/logosmith-bot/src/generate.test.ts`

**Interfaces:**
- Consumes: `AiLike`, `FetchLike`, `StyleAxis`, `Concept` from `./types.js`; `IMAGE_COST_USD`, `FLUX_MODEL_ID` from `./config.js`.
- Produces:
  - `createGenerator(deps: { fetchImpl: FetchLike; ai: AiLike; ideogramApiKey: string; recraftApiKey: string }): Generator`
  - `interface Generator { generate(axis: StyleAxis, prompt: string): Promise<GenerateResult> }`
  - `type GenerateResult = { ok: true; concept: Omit<Concept, 'slot'>; costUsd: number } | { ok: false; retryable: boolean; error: string }`

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/generate.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGenerator } from './generate.js';
import type { StyleAxis } from './types.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const ideogramAxis: StyleAxis = { id: 'wordmark', label: 'w', prompt: 'p', vendor: 'ideogram' };
const recraftAxis: StyleAxis = { id: 'emblem', label: 'e', prompt: 'p', vendor: 'recraft' };
const fluxAxis: StyleAxis = { id: 'taster', label: 't', prompt: 'p', vendor: 'flux' };

const imageResponse = async (): Promise<Response> =>
  new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });

function fetchStub(handlers: Record<string, () => Promise<Response>>) {
  return async (url: string): Promise<Response> => {
    for (const [fragment, handler] of Object.entries(handlers)) {
      if (url.includes(fragment)) return handler();
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const noAi = { run: async () => ({}) };

describe('generate', () => {
  it('returns PNG bytes and the vendor request id for Ideogram', async () => {
    const generator = createGenerator({
      fetchImpl: fetchStub({
        'ideogram.ai': async () =>
          new Response(JSON.stringify({ created: 'req-9', data: [{ url: 'https://cdn/x.png' }] }), {
            status: 200,
          }),
        cdn: imageResponse,
      }),
      ai: noAi,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(ideogramAxis, 'a mark for Acme');
    assert.ok(result.ok);
    assert.equal(result.concept.vendor, 'ideogram');
    assert.equal(result.concept.vendorRequestId, 'req-9');
    assert.deepEqual([...result.concept.png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.ok(result.costUsd > 0);
  });

  it('captures Recraft native SVG when the vendor returns one', async () => {
    const generator = createGenerator({
      fetchImpl: fetchStub({
        'recraft.ai': async () =>
          new Response(
            JSON.stringify({ id: 'rc-1', data: [{ url: 'https://cdn/x.svg', image_id: 'rc-1' }] }),
            { status: 200 },
          ),
        'cdn/x.svg': async () =>
          new Response('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>', {
            status: 200,
            headers: { 'Content-Type': 'image/svg+xml' },
          }),
      }),
      ai: noAi,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(recraftAxis, 'an emblem for Acme');
    assert.ok(result.ok);
    assert.match(result.concept.nativeSvg ?? '', /<svg/);
  });

  it('routes the flux axis through the Workers AI binding, not fetch', async () => {
    let called = false;
    const generator = createGenerator({
      fetchImpl: async () => {
        throw new Error('fetch must not be used for flux');
      },
      ai: {
        run: async () => {
          called = true;
          return { image: Buffer.from(PNG).toString('base64') };
        },
      },
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(fluxAxis, 'a taster for Acme');
    assert.ok(result.ok);
    assert.ok(called);
    assert.equal(result.concept.vendor, 'flux');
  });

  it('marks a 429 as retryable and a 400 as not', async () => {
    const make = (status: number) =>
      createGenerator({
        fetchImpl: fetchStub({ 'ideogram.ai': async () => new Response('no', { status }) }),
        ai: noAi,
        ideogramApiKey: 'i',
        recraftApiKey: 'r',
      });
    const rateLimited = await make(429).generate(ideogramAxis, 'p');
    const badRequest = await make(400).generate(ideogramAxis, 'p');
    assert.ok(!rateLimited.ok && rateLimited.retryable);
    assert.ok(!badRequest.ok && !badRequest.retryable);
  });

  it('reports a network throw as a retryable failure, never a throw', async () => {
    const generator = createGenerator({
      fetchImpl: async () => {
        throw new Error('socket hang up');
      },
      ai: noAi,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(ideogramAxis, 'p');
    assert.ok(!result.ok && result.retryable);
  });

  it('rejects a response whose bytes are not a PNG', async () => {
    const generator = createGenerator({
      fetchImpl: fetchStub({
        'ideogram.ai': async () =>
          new Response(JSON.stringify({ created: 'r', data: [{ url: 'https://cdn/x' }] }), { status: 200 }),
        cdn: async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
      }),
      ai: noAi,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(ideogramAxis, 'p');
    assert.ok(!result.ok);
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write the module**

`apps/logosmith-bot/src/generate.ts`:

```typescript
// Image vendor adapters (FR-4). One entry point, three back ends:
//   ideogram — lettering-heavy axes (its lettering quality is the whole reason
//              the OCR gate is winnable)
//   recraft  — the vector-native/icon-led axis; its native SVG export, when
//              present, lets M2 skip Vectorizer.ai entirely
//   flux     — the FREE taster only, via the Workers AI binding (near-free)
//
// Every path returns a result object rather than throwing: a vendor failure is
// a pipeline decision (retry within caps, or park), not an exception.

import { FLUX_MODEL_ID, IMAGE_COST_USD } from './config.js';
import type { AiLike, Concept, FetchLike, StyleAxis } from './types.js';

export type GenerateResult =
  | { ok: true; concept: Omit<Concept, 'slot'>; costUsd: number }
  | { ok: false; retryable: boolean; error: string };

export interface Generator {
  generate(axis: StyleAxis, prompt: string): Promise<GenerateResult>;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const isPng = (bytes: Uint8Array): boolean =>
  bytes.length > 8 && PNG_MAGIC.every((byte, i) => bytes[i] === byte);

/** 5xx and 429 are worth another attempt; 4xx means the request itself is wrong. */
const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

export function createGenerator(deps: {
  fetchImpl: FetchLike;
  ai: AiLike;
  ideogramApiKey: string;
  recraftApiKey: string;
}): Generator {
  async function fetchBytes(url: string): Promise<Uint8Array> {
    const response = await deps.fetchImpl(url);
    if (!response.ok) throw new Error(`asset fetch returned ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function generateIdeogram(prompt: string): Promise<GenerateResult> {
    const response = await deps.fetchImpl('https://api.ideogram.ai/v1/ideogram-v3/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': deps.ideogramApiKey },
      body: JSON.stringify({ prompt, rendering_speed: 'QUALITY', num_images: 1 }),
    });
    if (!response.ok) {
      return {
        ok: false,
        retryable: isRetryableStatus(response.status),
        error: `ideogram returned ${response.status}`,
      };
    }
    // VERIFIED LIVE 2026-07-30 against the real API. `created` is an ISO
    // TIMESTAMP, not an id — the real per-request id is the `x-request-id`
    // RESPONSE HEADER, and that is what the licence manifest must persist.
    const requestId = response.headers.get('x-request-id') ?? undefined;
    const body = (await response.json()) as {
      created?: string;
      data?: Array<{ url?: string; seed?: number; is_image_safe?: boolean }>;
    };
    const first = body.data?.[0];
    const url = first?.url;
    if (!url) return { ok: false, retryable: true, error: 'ideogram returned no image url' };
    // The URL is EPHEMERAL — signed, with a 24 h `exp`. Fetch it now; never
    // persist it. The pipeline PUTs the bytes to R2 immediately (Task 18) so a
    // parked or DLQ-replayed job never depends on a dead vendor link.
    const png = await fetchBytes(url);
    if (!isPng(png)) return { ok: false, retryable: true, error: 'ideogram asset was not a PNG' };
    return {
      ok: true,
      costUsd: IMAGE_COST_USD.ideogram,
      // `seed` makes a concept reproducible; record it in the gate audit detail.
      concept: { axisId: '', vendor: 'ideogram', vendorRequestId: requestId, png, seed: first.seed },
    };
  }

  async function generateRecraft(prompt: string): Promise<GenerateResult> {
    const response = await deps.fetchImpl('https://external.api.recraft.ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.recraftApiKey}` },
      body: JSON.stringify({ prompt, style: 'vector_illustration', model: 'recraftv3', n: 1 }),
    });
    if (!response.ok) {
      return {
        ok: false,
        retryable: isRetryableStatus(response.status),
        error: `recraft returned ${response.status}`,
      };
    }
    const body = (await response.json()) as {
      id?: string;
      data?: Array<{ url?: string; image_id?: string }>;
    };
    const url = body.data?.[0]?.url;
    if (!url) return { ok: false, retryable: true, error: 'recraft returned no image url' };
    const bytes = await fetchBytes(url);
    const requestId = body.id ?? body.data?.[0]?.image_id;

    // A vector-native return is the prize: it lets M2 skip Vectorizer.ai. When
    // the URL yields only an SVG, the PNG comes back EMPTY — the pipeline
    // (Task 18) rasterizes the sanitized SVG at 1024px for the OCR/pHash gates
    // and persists the SVG to R2 for stage 2's short-circuit.
    if (!isPng(bytes)) {
      const text = new TextDecoder().decode(bytes);
      if (text.includes('<svg')) {
        return {
          ok: true,
          costUsd: IMAGE_COST_USD.recraft,
          concept: {
            axisId: '',
            vendor: 'recraft',
            vendorRequestId: requestId,
            png: new Uint8Array(0),
            nativeSvg: text,
          },
        };
      }
      return { ok: false, retryable: true, error: 'recraft asset was neither PNG nor SVG' };
    }
    return {
      ok: true,
      costUsd: IMAGE_COST_USD.recraft,
      concept: { axisId: '', vendor: 'recraft', vendorRequestId: requestId, png: bytes },
    };
  }

  async function generateFlux(prompt: string): Promise<GenerateResult> {
    const output = (await deps.ai.run(FLUX_MODEL_ID, { prompt })) as { image?: string };
    if (typeof output.image !== 'string') {
      return { ok: false, retryable: true, error: 'workers ai returned no image' };
    }
    const binary = atob(output.image);
    const png = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) png[i] = binary.charCodeAt(i);
    if (!isPng(png)) return { ok: false, retryable: true, error: 'workers ai asset was not a PNG' };
    return {
      ok: true,
      costUsd: IMAGE_COST_USD.flux,
      concept: { axisId: '', vendor: 'flux', png },
    };
  }

  return {
    async generate(axis, prompt) {
      try {
        const result =
          axis.vendor === 'ideogram'
            ? await generateIdeogram(prompt)
            : axis.vendor === 'recraft'
              ? await generateRecraft(prompt)
              : await generateFlux(prompt);
        // Stamp the axis id here so no back end has to remember to.
        return result.ok ? { ...result, concept: { ...result.concept, axisId: axis.id } } : result;
      } catch (err) {
        return {
          ok: false,
          retryable: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
```

- [ ] **Step 3: Verify the live request shapes**

The request bodies above are written from each vendor's documented v3 API. Before Task 18 depends on them, make one live call per vendor with a real key and confirm the response field names (`created` / `data[].url` for Ideogram, `id` / `data[].url` for Recraft). If a field differs, fix the adapter and the test fixture together — do not leave the test asserting a shape the vendor does not return.

**Ideogram is now VERIFIED LIVE (2026-07-30)** — the adapter above encodes the real shape, so do not "correct" it back toward the guess:
- `POST /v1/ideogram-v3/generate` with header `Api-Key` and a JSON body ✅
- top level is `{ created, data[] }`; `created` is an ISO **timestamp**, NOT an id
- the real per-request id is the **`x-request-id` response header**
- `data[0]` = `{ url, seed, resolution, style_type, prompt, is_image_safe, upscaled_resolution }`
- `data[0].url` is **signed and ephemeral (24 h `exp`)**, returning a genuine 1024×1024 PNG
- `rendering_speed: "TURBO"` is the cheap tier for calibration runs

Recraft remains unverified — make one live call and fix its adapter + fixtures together if the shape differs.

- [ ] **Step 4: Run it to verify it passes → Commit**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern generate` — 6 tests PASS.

```bash
git add apps/logosmith-bot/src/generate.ts apps/logosmith-bot/src/generate.test.ts
git commit -m "feat(logosmith): Ideogram/Recraft/FLUX adapters with retryable failures

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 17: The lettering readback gate

**Files:**
- Create: `apps/logosmith-bot/src/gates/ocr.ts`
- Modify: `apps/logosmith-bot/src/gates/index.ts` (add the re-export)
- Test: `apps/logosmith-bot/src/gates/ocr.test.ts`

**Interfaces:**
- Consumes: `AiLike`, `OcrVerdict` from `../types.js`; `OCR_SIMILARITY_THRESHOLD`, `SCOUT_MODEL_ID` from `../config.js`.
- Produces:
  - `normalizeForMatch(text: string): string`
  - `similarity(a: string, b: string): number` — normalized Levenshtein ratio in [0, 1]
  - `createOcrGate(deps: { ai: AiLike; now?: () => Date }): OcrGate`
  - `MIN_VISION_PROMPT_TOKENS` — the hallucination canary (see the verified-live note below)
  - `interface OcrGate { check(png: Uint8Array, brandName: string, threshold?: number): Promise<OcrOutcome> }`
  - `type OcrOutcome = { status: 'ok'; verdict: OcrVerdict } | { status: 'unavailable'; error: string }`

> **This is the gate that names the bot.** Two properties matter and are tested directly: normalization must not be so aggressive that it passes garbage (stripping every non-letter would make "H@rb0r" match "Harbor"), and the vision call must be temperature 0 with the model id and raw transcription snapshotted — vision models drift, and the snapshot is the contractual record of what passed.

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/gates/ocr.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOcrGate, normalizeForMatch, similarity } from './ocr.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const aiReturning = (text: string) => ({
  run: async () => ({ response: text }),
});

describe('normalizeForMatch', () => {
  it('case-folds and strips punctuation and whitespace', () => {
    assert.equal(normalizeForMatch('Harbor & Vine'), 'harborvine');
    assert.equal(normalizeForMatch('HARBOR&VINE'), 'harborvine');
    assert.equal(normalizeForMatch("  O'Brien-Smith "), 'obriensmith');
  });

  it('folds diacritics so Café matches Cafe', () => {
    assert.equal(normalizeForMatch('Café'), normalizeForMatch('Cafe'));
  });

  it('does NOT fold digits or symbols into letters (garbled must stay garbled)', () => {
    assert.notEqual(normalizeForMatch('H@rb0r'), normalizeForMatch('Harbor'));
    assert.notEqual(normalizeForMatch('V1NE'), normalizeForMatch('VINE'));
  });
});

describe('similarity', () => {
  it('is 1 for identical strings and 0 for wholly different ones', () => {
    assert.equal(similarity('harborvine', 'harborvine'), 1);
    assert.ok(similarity('harborvine', 'zzzzzzzzzz') < 0.2);
  });

  it('scores a one-character slip high and glyph soup low', () => {
    assert.ok(similarity('harborvine', 'harborvin') > 0.85);
    assert.ok(similarity('harborvine', 'hrbcrvlne') < 0.85);
  });

  it('handles empty input without dividing by zero', () => {
    assert.equal(similarity('', ''), 1);
    assert.equal(similarity('abc', ''), 0);
  });
});

describe('OcrGate', () => {
  it('passes a clean readback and snapshots the model id and raw text', async () => {
    const gate = createOcrGate({ ai: aiReturning('{"text":"Harbor & Vine","unsafe":false}') });
    const outcome = await gate.check(PNG, 'Harbor & Vine');
    assert.ok(outcome.status === 'ok');
    assert.equal(outcome.verdict.pass, true);
    assert.equal(outcome.verdict.transcription, 'Harbor & Vine');
    assert.ok(outcome.verdict.model.length > 0);
    assert.ok(outcome.verdict.checkedAt.length > 0);
  });

  it('fails glyph soup below the threshold', async () => {
    const gate = createOcrGate({ ai: aiReturning('{"text":"Hrbcr & Vlne","unsafe":false}') });
    const outcome = await gate.check(PNG, 'Harbor & Vine');
    assert.ok(outcome.status === 'ok');
    assert.equal(outcome.verdict.pass, false);
    assert.ok(outcome.verdict.score < 0.85);
  });

  it('fails an unsafe-flagged image regardless of the readback score', async () => {
    const gate = createOcrGate({ ai: aiReturning('{"text":"Harbor & Vine","unsafe":true}') });
    const outcome = await gate.check(PNG, 'Harbor & Vine');
    assert.ok(outcome.status === 'ok');
    assert.equal(outcome.verdict.unsafe, true);
    assert.equal(outcome.verdict.pass, false);
  });

  it('honours an explicit threshold', async () => {
    const gate = createOcrGate({ ai: aiReturning('{"text":"Harbor Vin","unsafe":false}') });
    const strict = await gate.check(PNG, 'Harbor Vine', 0.99);
    assert.ok(strict.status === 'ok' && !strict.verdict.pass);
    const lenient = await gate.check(PNG, 'Harbor Vine', 0.5);
    assert.ok(lenient.status === 'ok' && lenient.verdict.pass);
  });

  it('tolerates a model that wraps its JSON in prose or fences', async () => {
    const gate = createOcrGate({
      ai: aiReturning('Sure!\n```json\n{"text":"Harbor & Vine","unsafe":false}\n```'),
    });
    const outcome = await gate.check(PNG, 'Harbor & Vine');
    assert.ok(outcome.status === 'ok' && outcome.verdict.pass);
  });

  it('reports unavailable when the model call throws — never a silent pass', async () => {
    const gate = createOcrGate({
      ai: {
        run: async () => {
          throw new Error('AI binding unavailable');
        },
      },
    });
    assert.equal((await gate.check(PNG, 'Harbor & Vine')).status, 'unavailable');
  });

  it('reports unavailable when the response has no usable text', async () => {
    const gate = createOcrGate({ ai: aiReturning('I cannot read this image.') });
    assert.equal((await gate.check(PNG, 'Harbor & Vine')).status, 'unavailable');
  });
});
```

> The first assertion in `normalizeForMatch` above is deliberately awkward to write; replace it with the straightforward form once you have chosen the exact normalization — the intent is that `'Harbor & Vine'` and `'HARBOR&VINE'` normalize identically. Keep the diacritic and digit cases exactly as written.

- [ ] **Step 2: Run it to verify it fails, then write the gate**

`apps/logosmith-bot/src/gates/ocr.ts`:

```typescript
// ---------------------------------------------------------------------------
// Lettering readback gate (FR-5, §9) — the headline gate.
//
// Every paid concept's visible brand text is transcribed by the pinned Workers
// AI vision model and matched against the brand name at a normalized
// similarity threshold. Failing concepts are REGENERATED, never delivered.
//
// This is not classical OCR: a vision model is nondeterministic and can drift
// between versions. Two consequences are baked in here — temperature 0, and a
// verdict snapshot (model id + raw transcription + score) that becomes the
// contractual record of what passed at delivery time.
//
// Normalization is deliberately conservative. Folding case, NFKC forms,
// diacritics, punctuation and whitespace makes "Harbor & Vine" match
// "HARBOR&VINE"; folding digits or symbols into letters would make "H@rb0r"
// match "Harbor", which is exactly the failure the gate exists to catch.
// ---------------------------------------------------------------------------

import { OCR_SIMILARITY_THRESHOLD, SCOUT_MODEL_ID } from '../config.js';
import type { AiLike, OcrVerdict } from '../types.js';

export type OcrOutcome =
  | { status: 'ok'; verdict: OcrVerdict }
  | { status: 'unavailable'; error: string };

export interface OcrGate {
  check(png: Uint8Array, brandName: string, threshold?: number): Promise<OcrOutcome>;
}

/** NFKC case-fold, strip diacritics, drop punctuation and whitespace. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '') // combining marks (diacritics)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, '');
}

/** Levenshtein distance, iterative two-row form. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Normalized similarity ratio in [0, 1] over already-normalized strings. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

const VISION_PROMPT =
  'Transcribe the text visible in this logo image EXACTLY as it appears, character for character. ' +
  'Do not correct spelling, do not guess at a brand name, do not add words that are not visibly ' +
  'rendered. Also report whether the image contains unsafe or inappropriate content. ' +
  'Respond with ONLY JSON: {"text":"<exact transcription>","unsafe":<true|false>}';

/**
 * Floor on `usage.prompt_tokens` below which we assume the image never
 * reached the model. Measured: 40 with the image silently dropped, 2497 with
 * a 1024px image ingested. 500 sits far from both.
 */
export const MIN_VISION_PROMPT_TOKENS = 500;

/** base64 for Workers (no Buffer): chunked to avoid blowing the arg limit. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Pull the first JSON object out of a response that may carry prose or fences. */
function extractJson(text: string): { text?: unknown; unsafe?: unknown } | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as { text?: unknown; unsafe?: unknown };
  } catch {
    return null;
  }
}

export function createOcrGate(deps: { ai: AiLike; now?: () => Date }): OcrGate {
  const now = deps.now ?? ((): Date => new Date());

  return {
    async check(png, brandName, threshold = OCR_SIMILARITY_THRESHOLD) {
      try {
        // VERIFIED LIVE 2026-07-30. Scout is a CHAT model: it takes
        // `messages` with content parts and a base64 data URI. The
        // byte-array `{ prompt, image: [...png] }` form used by the older
        // llava-style models is ACCEPTED WITH HTTP 200 AND SILENTLY IGNORES
        // THE IMAGE — measured prompt_tokens 40, and the model returned a
        // confident, well-formed, entirely hallucinated transcription ("The
        // quick brown fox jumps over the lazy dog" for an image reading
        // "ACME"). The correct form measured prompt_tokens 2497 and returned
        // "ACME". Do not "simplify" this back to the byte-array form.
        const output = (await deps.ai.run(SCOUT_MODEL_ID, {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: VISION_PROMPT },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${toBase64(png)}` } },
              ],
            },
          ],
          // Nondeterminism is the risk (§13); pin it as far down as the API allows.
          temperature: 0,
          max_tokens: 256,
        })) as { response?: unknown; usage?: { prompt_tokens?: number } };

        // Hallucination canary. A prompt that carried a 1024px image measures
        // in the thousands of tokens; an ignored image measures in the tens.
        // Without this check a silently-dropped image yields a confident wrong
        // verdict — the one failure this gate exists to prevent. Too-low means
        // UNAVAILABLE (park and retry), never a pass or a fail.
        const promptTokens = output.usage?.prompt_tokens ?? 0;
        if (promptTokens < MIN_VISION_PROMPT_TOKENS) {
          return {
            status: 'unavailable',
            error: `vision request carried no image (prompt_tokens=${promptTokens}); refusing to verdict on a text-only response`,
          };
        }

        // `response` arrives already parsed when the model emits clean JSON,
        // and as a string otherwise — handle both.
        const parsed =
          typeof output.response === 'string'
            ? extractJson(output.response)
            : ((output.response ?? null) as { text?: unknown; unsafe?: unknown } | null);
        if (!parsed || typeof parsed.text !== 'string') {
          return { status: 'unavailable', error: 'vision model returned no usable transcription' };
        }

        const transcription = parsed.text;
        const score = similarity(normalizeForMatch(transcription), normalizeForMatch(brandName));
        const unsafe = parsed.unsafe === true;

        return {
          status: 'ok',
          verdict: {
            model: SCOUT_MODEL_ID,
            transcription,
            score,
            unsafe,
            // An unsafe image never passes, however well it spells.
            pass: score >= threshold && !unsafe,
            checkedAt: now().toISOString(),
          },
        };
      } catch (err) {
        return { status: 'unavailable', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
```

> **VERIFIED LIVE 2026-07-30 — and the naive shape is actively dangerous.** Both forms were run against `@cf/meta/llama-4-scout-17b-16e-instruct` with a real 1024×1024 logo reading "ACME":
>
> | Input shape | HTTP | `prompt_tokens` | Transcription |
> |---|---|---|---|
> | `{ prompt, image: [...bytes] }` (the original guess) | **200** | **40** | **"The quick brown fox jumps over the lazy dog"** — pure hallucination |
> | `{ messages: [{ role, content: [text part, image_url data URI] }] }` | 200 | 2497 | **"ACME"** — correct |
>
> The byte-array form does not error. It returns a **confident, well-formed, entirely fabricated** transcription, which for this gate is the worst possible failure: concepts would pass or fail on invented text while the report snapshotted it as evidence, and "AI logos that can actually spell" would rest on noise. Hence `MIN_VISION_PROMPT_TOKENS` — a cheap canary that turns a silent-wrong into a loud-unavailable. Add a test asserting a low-`prompt_tokens` response yields `unavailable`, never a verdict.

Add to `apps/logosmith-bot/src/gates/index.ts`:

```typescript
export * from './ocr.js';
```

- [ ] **Step 3: Run it to verify it passes → Commit**

Run: `cd apps/logosmith-bot && pnpm test -- --test-name-pattern "normalizeForMatch|similarity|OcrGate"` — 14 tests PASS.

```bash
git add apps/logosmith-bot/src/gates/ocr.ts apps/logosmith-bot/src/gates/ocr.test.ts apps/logosmith-bot/src/gates/index.ts
git commit -m "feat(logosmith): lettering readback gate with snapshotted verdicts

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 18: Pipeline stage 1 — capped regeneration loop to M1

**Files:**
- Create: `apps/logosmith-bot/src/pipeline.ts` (replaces the Task 12 stub)
- Test: `apps/logosmith-bot/src/pipeline.test.ts`

**Interfaces:**
- Consumes: every store and gate built so far.
- Produces:
  - `interface PipelineConfig` (the shape `index.ts` builds)
  - `processJobMessage(config: PipelineConfig, message: JobMessage): Promise<void>`
  - `runConceptStage(config: PipelineConfig, message: JobMessage): Promise<StageOutcome>`
  - `decideSlotAction(state: ConceptState, spendUsd: number): SlotAction` — the pure cap policy
  - `type SlotAction = { action: 'generate' } | { action: 'regenerate' } | { action: 'stop'; reason: 'attempts-exhausted' | 'spend-cap' }`
  - `type StageOutcome = { outcome: 'delivered' | 'partial' | 'aborted' | 'parked' }`

> **The cap policy is extracted as a pure function on purpose.** Cap accounting is where a retry bug turns into real money: the checkpoint carries `spendUsd`, and a resumed job must decide against the *remaining* budget. `decideSlotAction` is unit-tested exhaustively so the orchestration around it can stay thin.

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/pipeline.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REGENS_PER_SLOT, MAX_SPEND_USD } from './config.js';
import { decideSlotAction } from './pipeline.js';
import type { ConceptState, StyleAxis } from './types.js';

const axis: StyleAxis = { id: 'wordmark', label: 'w', prompt: 'p', vendor: 'ideogram' };
const state = (over: Partial<ConceptState> = {}): ConceptState => ({
  slot: 1,
  axis,
  status: 'pending',
  attempts: 0,
  ...over,
});

describe('decideSlotAction', () => {
  it('generates a fresh slot', () => {
    assert.deepEqual(decideSlotAction(state(), 0), { action: 'generate' });
  });

  it('regenerates a failed slot while regens remain (attempts = 1 + regens used)', () => {
    // attempts=1: initial generation done, 0 regens used → regen #1 allowed.
    assert.deepEqual(decideSlotAction(state({ status: 'failed', attempts: 1 }), 0), {
      action: 'regenerate',
    });
    // attempts=MAX: regen #MAX still allowed (that's the last one).
    assert.deepEqual(
      decideSlotAction(state({ status: 'failed', attempts: MAX_REGENS_PER_SLOT }), 0),
      { action: 'regenerate' },
    );
  });

  it('stops after the initial attempt plus MAX_REGENS_PER_SLOT regenerations', () => {
    const action = decideSlotAction(
      state({ status: 'failed', attempts: MAX_REGENS_PER_SLOT + 1 }),
      0,
    );
    assert.deepEqual(action, { action: 'stop', reason: 'attempts-exhausted' });
  });

  it('stops every slot once the job hits the spend cap', () => {
    assert.deepEqual(decideSlotAction(state(), MAX_SPEND_USD), {
      action: 'stop',
      reason: 'spend-cap',
    });
  });

  it('checks the spend cap before anything else', () => {
    // A resumed job at the cap must not spend another cent, whatever the slot state.
    assert.deepEqual(decideSlotAction(state({ status: 'passed' }), MAX_SPEND_USD + 1), {
      action: 'stop',
      reason: 'spend-cap',
    });
  });

  it('never regenerates a slot that already passed', () => {
    assert.deepEqual(decideSlotAction(state({ status: 'passed', attempts: 1 }), 0), {
      action: 'stop',
      reason: 'already-passed',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write the stage**

`apps/logosmith-bot/src/pipeline.ts` — write `decideSlotAction` and `runConceptStage`. The cap policy:

```typescript
import { MAX_REGENS_PER_SLOT, MAX_SPEND_USD } from './config.js';
import type { ConceptState } from './types.js';

export type SlotAction =
  | { action: 'generate' }
  | { action: 'regenerate' }
  | { action: 'stop'; reason: 'attempts-exhausted' | 'spend-cap' | 'already-passed' };

/**
 * The FR-5 cap policy. `attempts` counts COMPLETED generation attempts for the
 * slot (0 = never generated), so regenerations used = attempts - 1, and the
 * PRD's "<= 2 regenerations per slot" allows exactly 3 attempts. The
 * orchestrator increments `attempts` after EVERY generation call, pass or fail.
 *
 * Spend is checked FIRST and against the accumulated checkpoint total, so a job
 * resumed by a queue retry decides against the remaining budget rather than
 * starting a fresh $2.50.
 */
export function decideSlotAction(state: ConceptState, spendUsd: number): SlotAction {
  if (spendUsd >= MAX_SPEND_USD) return { action: 'stop', reason: 'spend-cap' };
  if (state.status === 'passed') return { action: 'stop', reason: 'already-passed' };
  if (state.attempts === 0) return { action: 'generate' };
  if (state.attempts <= MAX_REGENS_PER_SLOT) return { action: 'regenerate' };
  return { action: 'stop', reason: 'attempts-exhausted' };
}
```

`runConceptStage` then implements §6 steps 3–6 against the injected services:

1. `jobs.get(jobKey)`; load the checkpoint, or seed one with three `pending` slots from `axisCompiler.compile(brief)`.
2. Re-validate the brief (FR-1). Invalid ⇒ post to the thread and `markDelivered(jobKey, 'rejected')`.
3. `moderation.screen(brandName + brief)`. `unavailable` ⇒ `jobs.park(jobKey, 'moderation_outage')`, increment attempts, thread notice after `MODERATION_ATTEMPTS_BEFORE_NOTICE`, return `{ outcome: 'parked' }`. `flagged` ⇒ `markDelivered(jobKey, 'rejected')` with a thread explanation.
4. Loop until every slot is `passed` or `decideSlotAction` says stop, incrementing the slot's `attempts` after **every** generation call, pass or fail:
   - `generator.generate(axis, axis.prompt)` → on `retryable: false`, mark the slot failed permanently; on `retryable: true`, save the checkpoint and `jobs.park(jobKey, 'vendor_outage')` for cron re-enqueue — vendor outages must **not** burn queue retries (the Task 1 wrangler comment and the FR-2 pattern; the queue's 3 retries are reserved for infra errors thrown outside these handled paths).
   - Add `costUsd` to `checkpoint.spendUsd` **before** the gate runs — the money is spent whether or not the image passes.
   - **PUT the PNG to R2 immediately, before the gates run** (`${deliverableToken}/concept-N.png`), and record `r2Key` on the checkpoint slot and the `concepts` row in the same step. Vendor asset URLs are **ephemeral** — Ideogram's carry a 24 h signed `exp` (verified live 2026-07-30) — so a job that parks on an OCR/vendor outage, or is replayed from the DLQ days later, cannot re-fetch them. Without a durable copy the resumed job must regenerate, burning the FR-5 cap and real money for an image already paid for. All later steps (gates, M1 delivery, stage 2) read bytes back from R2 via `deliverables.get`, never from a vendor URL.
   - **Recraft SVG-only returns:** when `concept.nativeSvg` is set and `png` is empty, `sanitizeSvg` the SVG, rasterize it with `renderSvgToPng(svg, 1024, config.sources)` to obtain the gate-able PNG, and PUT the sanitized SVG to R2 as `${deliverableToken}/concept-N.svg`, recording the key via `conceptStore.upsert({ nativeSvgKey })`. Without this, the empty PNG breaks every gate AND stage 2's Recraft-native short-circuit can never fire — every winner would pay Vectorizer.ai.
   - `ocrGate.check(png, brandName)` → `unavailable` ⇒ park as `'ocr_outage'`; otherwise record the verdict.
   - `perceptualHash` the decoded pixmap; `conceptStore.upsert(...)`; `jobs.saveCheckpoint(...)` after **every** slot so a retry never redoes paid work.
   - `checkDistinctness` across passing slots; a failing pair marks the *newer* slot failed for regeneration.
   - `recordGateAudit` for every verdict.
5. Count passing slots: 3 ⇒ `delivered`; 2 (and distinct) ⇒ `partial`; <2 ⇒ `aborted`.
6. **M1 delivery (FR-8).** On `delivered`/`partial`: the concept PNGs are already in R2 from step 4 — do NOT re-fetch or re-PUT them. `selection.open(contractId)`, then `client.deliverMilestone(...)` — with the milestone id fetched via REST off the contract, since the funding payload carries none — passing the Worker-served links, the progress-page URL, and the selection instruction `reply with 'concept 1|2|3'`. On `aborted`: deliver nothing, post the itemized evidence to the thread, and **request** payer cancellation (§9 — the bot cannot refund).

`processJobMessage` dispatches on `message.stage` (`concepts` → `runConceptStage`, `vector` → `runVectorStage` from Task 21, `single` → the free-gig path from Task 23).

- [ ] **Step 3: Add an integration test for the stage outcomes**

Extend `pipeline.test.ts` with a `runConceptStage` describe using in-memory D1 (`createMemoryD1` + `applyMigrations`) and fakes for the generator, OCR gate, moderation client, and `client.deliverMilestone`. Cover exactly these four cases — they are the §9 contractual outcomes:

1. **All three pass first time** → `outcome: 'delivered'`, three `concepts` rows, `selection` row opened at `concepts_delivered`, `deliverMilestone` called once.
2. **One slot fails twice then passes** → `outcome: 'delivered'`, that slot's recorded attempts are 3 (the initial generation plus both FR-5 regenerations), and `checkpoint.spendUsd` reflects three paid generations for that slot.
3. **Spend cap reached with two passing** → `outcome: 'partial'`, `deliverMilestone` called, the shortfall itemized in the delivery note.
4. **Moderation unavailable** → `outcome: 'parked'`, job row `status: 'parked'` with `park_reason: 'moderation_outage'`, and `deliverMilestone` NOT called.

- [ ] **Step 4: Run the tests → Commit**

Run: `pnpm -w build && cd apps/logosmith-bot && pnpm test`

```bash
git add apps/logosmith-bot/src/pipeline.ts apps/logosmith-bot/src/pipeline.test.ts
git commit -m "feat(logosmith): concept stage with capped regeneration and M1 delivery

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Phase E — Selection and the vector pack

### Task 19: Contract-thread reader and selection parsing

**Files:**
- Create: `apps/logosmith-bot/src/threads.ts`
- Test: `apps/logosmith-bot/src/threads.test.ts`

**Interfaces:**
- Produces: `createThreadReader(deps: { apiUrl: string; apiKey: string; fetchImpl: FetchLike }): ThreadReader` with `listMessages(contractId): Promise<ThreadMessage[]>`; `parseSelection(text: string): number | null`; `findSelection(messages: ThreadMessage[], botId: string): number | null`.

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/threads.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findSelection, parseSelection } from './threads.js';

describe('parseSelection', () => {
  it('reads the instructed form', () => {
    assert.equal(parseSelection('concept 2'), 2);
    assert.equal(parseSelection('Concept 3'), 3);
  });

  it('reads natural phrasings a buyer actually types', () => {
    assert.equal(parseSelection("I'll take concept 1 please"), 1);
    assert.equal(parseSelection('we like #2 best'), 2);
    assert.equal(parseSelection('option 3'), 3);
    assert.equal(parseSelection('3'), 3);
  });

  it('returns null for out-of-range and ambiguous replies', () => {
    assert.equal(parseSelection('concept 4'), null);
    assert.equal(parseSelection('concept 0'), null);
    assert.equal(parseSelection('I like concept 1 and concept 2'), null);
    assert.equal(parseSelection('thanks, looks great!'), null);
    assert.equal(parseSelection(''), null);
  });
});

describe('findSelection', () => {
  const buyer = (body: string) => ({ id: 'm', senderId: 'payer-1', body, createdAt: '2026-07-30T00:00:00Z' });
  const bot = (body: string) => ({ id: 'm', senderId: 'bot-logosmith', body, createdAt: '2026-07-30T00:00:00Z' });

  it("ignores the bot's own instruction message", () => {
    const messages = [bot("reply with 'concept 1|2|3'"), buyer('concept 2')];
    assert.equal(findSelection(messages, 'bot-logosmith'), 2);
  });

  it('takes the FIRST buyer selection, not the last', () => {
    const messages = [buyer('concept 1'), buyer('actually concept 3')];
    assert.equal(findSelection(messages, 'bot-logosmith'), 1);
  });

  it('returns null when no buyer message parses', () => {
    assert.equal(findSelection([bot('concept 2'), buyer('looks good')], 'bot-logosmith'), null);
  });
});
```

- [ ] **Step 2: Write the module**

`parseSelection` matches `concept N`, `option N`, `#N`, or a bare `N` for N ∈ {1,2,3}, and returns `null` when more than one distinct slot appears in one message (ambiguity is not a selection). `findSelection` filters out messages whose `senderId` is the bot, then returns the first parse hit — first, not last, so a buyer who changes their mind after M2 has already started cannot silently re-point the contract. `createThreadReader` GETs the contract's thread messages through the platform REST API with the handler key, matching `apps/voicewright-bot/src/threads.ts` for the endpoint shape.

- [ ] **Step 3: Run the tests → Commit**

```bash
git add apps/logosmith-bot/src/threads.ts apps/logosmith-bot/src/threads.test.ts
git commit -m "feat(logosmith): contract-thread reader and selection parsing

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 20: Vectorization

**Files:**
- Create: `apps/logosmith-bot/src/vectorize.ts`
- Test: `apps/logosmith-bot/src/vectorize.test.ts`

**Interfaces:**
- Produces: `createVectorizer(deps: { fetchImpl: FetchLike; vectorizerToken: string }): Vectorizer` with `toVector(input: { png: Uint8Array; nativeSvg?: string }): Promise<VectorizeResult>`; `type VectorizeResult = { ok: true; svg: string; source: 'recraft-native' | 'vectorizer'; costUsd: number } | { ok: false; retryable: boolean; error: string }`.

- [ ] **Step 1: Write the failing test**

Cover these cases:

1. **A Recraft-native SVG short-circuits** — `toVector({ png, nativeSvg })` returns `source: 'recraft-native'`, `costUsd: 0`, and never calls `fetchImpl`.
2. **No native SVG** → posts to Vectorizer.ai, returns `source: 'vectorizer'` with a positive cost.
3. **SVGO runs on both paths** — the returned SVG is smaller than a deliberately verbose input and still passes `checkTrueVector`.
4. **The output is sanitized** — a Vectorizer response containing `<script>` comes back script-free and gate-passing.
5. **A response containing `<image>` fails** — `ok: false`, because a "vector" wrapping a raster must never reach `buildPack`.
6. **429/5xx are retryable, 4xx is not**, and a network throw is retryable.

- [ ] **Step 2: Write the module**

`toVector` returns the native SVG when present (Recraft-origin winners skip Vectorizer.ai entirely — the §13 single-vendor mitigation), otherwise POSTs the PNG to `https://vectorizer.ai/api/v1/vectorize` with basic auth. Both paths then run SVGO with a config that preserves `viewBox` (`removeViewBox: false`), converts shapes to paths where it shrinks output, and strips metadata; then `sanitizeSvg`; then `checkTrueVector` as a self-check, returning `ok: false` if the result is not a true vector. A Vectorizer outage returns `retryable: true` so the caller parks the job fail-closed with a thread note (FR-10).

- [ ] **Step 3: Run the tests → Commit**

```bash
git add apps/logosmith-bot/src/vectorize.ts apps/logosmith-bot/src/vectorize.test.ts
git commit -m "feat(logosmith): vectorization with Recraft-native short-circuit

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 21: Pipeline stage 2 — pack, report, M2 delivery

**Files:**
- Modify: `apps/logosmith-bot/src/pipeline.ts` (add `runVectorStage`)
- Create: `apps/logosmith-bot/src/report.ts`
- Test: `apps/logosmith-bot/src/report.test.ts`
- Test: extend `apps/logosmith-bot/src/pipeline.test.ts`

**Interfaces:**
- Produces:
  - `buildValidationReport(input: ReportInput): ValidationReport`
  - `buildLicenseManifest(rows: LicenseRow[]): LicenseManifest`
  - `runVectorStage(config: PipelineConfig, message: JobMessage): Promise<StageOutcome>`

- [ ] **Step 1: Write the failing report test**

`report.test.ts` asserts the §8 report contract — the report is dispute evidence, so its completeness is a tested property, not a convention:

1. Every concept appears with its axis id, vendor, vendor request id, OCR snapshot (model, raw transcription, normalized score, attempts used), and pHash.
2. The pairwise pHash matrix is present and symmetric.
3. The winner and its `selectionSource` (`buyer` | `default`) are recorded.
4. The SVG gate result carries the node census and the explicit zero-raster assertion.
5. A per-file dimension table, the ICO parse-back result, and the ZIP manifest are present.
6. Moderation snapshots, caps consumed, and the stage idempotency keys are present.
7. The report serializes to JSON and round-trips.
8. `buildLicenseManifest` emits one entry per generated/converted image with vendor, request id, terms scope, and the Phase 0 terms-verification date.

- [ ] **Step 2: Write `report.ts`, then `runVectorStage`**

`runVectorStage` implements §6 steps 8–10:

1. Load the winner from `selection.get(contractId)` and its concept row; read the winner's artifacts back via `config.deliverables.get` — the concept PNG (`concept-N.png` under the stage-1 token, via `concepts.r2_key`), and the sanitized native SVG (`concepts.native_svg_key`) when the winner came from Recraft's vector export.
2. `vectorizer.toVector({ png, nativeSvg })` → a Recraft-native winner short-circuits with zero vendor spend (the §13 single-vendor mitigation); `retryable` ⇒ park with a thread note; `ok: false` non-retryable ⇒ abort leg.
3. `fetchFontPairing(...)` (advisory; never fails the job).
4. `buildPack({ svg, brandName, sources, fonts })` — which runs the true-vector gate first and throws if the SVG is not a true vector.
5. If `gates.pass` is false, do **not** deliver: post the failing gate detail to the thread and take the abort leg.
6. PUT `pack.zip`, `report.json`, and `licenses.json` to R2 under the deliverable token; `client.deliverMilestone(...)` with the Worker-served links.
7. `selection.markPackDelivered(contractId)`, `jobs.markDelivered(jobKey, 'delivered')`.

- [ ] **Step 3: Extend the pipeline integration test**

Add three `runVectorStage` cases: a Recraft-native winner completing end to end without touching Vectorizer.ai; a Vectorizer outage parking the job; and a pack whose gates fail taking the abort leg without calling `deliverMilestone`.

- [ ] **Step 4: Run the full suite → Commit**

```bash
git add apps/logosmith-bot/src/pipeline.ts apps/logosmith-bot/src/report.ts apps/logosmith-bot/src/report.test.ts apps/logosmith-bot/src/pipeline.test.ts
git commit -m "feat(logosmith): vector stage, validation report, license manifest, M2 delivery

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Phase F — Sweeps, free funnel, warranty

### Task 22: Cron sweeps

**Files:**
- Create: `apps/logosmith-bot/src/sweeps.ts` (replaces the Task 12 stub)
- Test: `apps/logosmith-bot/src/sweeps.test.ts`

**Interfaces:**
- Produces: `interface SweepServices`; `runFifteenMinuteSweep(services): Promise<void>`; `runDailySweep(services): Promise<void>`; `decideDefaultSelection(concepts: ConceptRow[]): number | null`; `resolveSelectionForContract(deps, contractId, opts?: { force?: boolean }): Promise<void>` — reads the thread once; a parsed reply selects as `'buyer'`; otherwise, past `SELECTION_TIMEOUT_HOURS` **or with `force`**, default-selects via `decideDefaultSelection`; then claims stage `vector` and enqueues. No-ops unless the selection row is at `concepts_delivered`.

The 15-minute sweep runs, in order: `runGigPollSweep` (score + propose, free gigs through `freeProposer`); negotiation via `decideCounter` against the estimator floor with the D1 counter-once store; the **selection poll** — for each `listAwaitingSelection(now)` row, `resolveSelectionForContract` (buyer replies select at any age; the default rule fires only past the timeout; the same helper is what the M1 `milestone.accepted` / `acceptance.auto_approved` webhook handlers call with `force: true`, PRD FR-9); parked re-enqueue; reputation refresh into the D1 snapshot. The daily sweep re-enqueues stuck claims older than `STUCK_CLAIM_MINUTES`.

- [ ] **Step 1: Write the failing test**

Cover:

1. `decideDefaultSelection` picks the **highest OCR score** among passing concepts, ties broken by lowest slot; returns `null` when nothing passed.
2. The selection poll enqueues stage `vector` exactly once for a contract with a buyer reply.
3. A contract past the timeout with no reply gets `source: 'default'` and is enqueued.
4. A contract inside the timeout with no reply is left alone.
5. Parked jobs are unparked and re-enqueued.
6. Stuck claims older than the cutoff are re-enqueued; fresher ones are not.
7. `resolveSelectionForContract` with `force: true` (the FR-9 M1-acceptance trigger) default-selects immediately when no reply exists — and no-ops when the selection row is at `winner_selected` or `pack_delivered`.

- [ ] **Step 2: Write the module, run the tests → Commit**

```bash
git add apps/logosmith-bot/src/sweeps.ts apps/logosmith-bot/src/sweeps.test.ts
git commit -m "feat(logosmith): cron sweeps with selection poll and default-selection rule

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 23: Free funnel — favicon gig, taster, quotas, warranty revision

**Files:**
- Modify: `apps/logosmith-bot/src/pipeline.ts` (add `runSingleStage`)
- Create: `apps/logosmith-bot/src/freeGigs.ts`
- Create: `apps/logosmith-bot/src/pack/faviconPack.ts`
- Test: `apps/logosmith-bot/src/freeGigs.test.ts`
- Test: `apps/logosmith-bot/src/pack/faviconPack.test.ts`

**Interfaces:**
- Consumes: `@cf-wasm/photon` (raster decode + per-size resize — **its first and only import site**; PRD §7 names it as "the favicon gig's PNG path"); `FAVICON_ZIP_ENTRIES` + `checkZipCompleteness(zip, FAVICON_ZIP_ENTRIES)`; `assembleIco`, `checkIco`, `buildWebmanifest`, `buildHtmlSnippet`, `zipFiles`; `renderSvgToPng` for SVG sources; `QuotaStore`; `MIN_SOURCE_PX` from `./brief.js`.
- Produces:
  - `fetchSourceLogo(deps: { fetchImpl: FetchLike; url: string }): Promise<SourceLogoResult>` — `type SourceLogoResult = { ok: true; source: FaviconSource } | { ok: false; reason: string }`
  - `type FaviconSource = { kind: 'svg'; svg: string } | { kind: 'raster'; bytes: Uint8Array; width: number; height: number }`
  - `buildFaviconPack(input: { source: FaviconSource; siteName: string; sources: WasmSources }): Promise<FaviconPackResult>` — `{ zip, files, gates: { dimensions, ico, zip, pass } }`
  - `runSingleStage(config, message): Promise<StageOutcome>`
  - `checkFreeGigQuota(quota: QuotaStore, payerId: string): Promise<QuotaDecision>`

> **The favicon pack is NOT the M2 pack.** US-2's deliverable is favicons + manifest + snippet only — no `logo.svg`, no mono mark, no colour masters, no `brand.json` — so it gets its own builder, gated with `checkZipCompleteness(zip, FAVICON_ZIP_ENTRIES)`, never the 15-entry paid contract. And its input is usually a *raster*: `buildPack` (vector in) cannot serve it. For an SVG source, every size renders from vector via resvg exactly as the paid pack does; for a PNG/JPEG source, each size is produced by a photon high-quality resize from the ≥512 px original — downscale-only, never upscale. `favicon.ico` is assembled from the resized 16/32/48 PNGs and parse-back gated as usual. `site.webmanifest` names the source URL's hostname — the favicon brief has no `brandName`.

`fetchSourceLogo` applies the §12 fetch-time guards the pure `checkLogoUrl` policy could not: 10 MB streamed cap, magic-byte sniff (PNG/JPEG/SVG only — content-type headers are not trusted), 15 s timeout via `AbortSignal.timeout`, and the ≥`MIN_SOURCE_PX` minimum — read from the IHDR for PNG, from the photon-decoded image for JPEG, and waived for SVG sources (vectors have no native resolution). The taster runs one FLUX generation with ≤2 regenerations and attaches the OCR verdict as labelled, **non-blocking** evidence — a failed readback is delivered honestly with a note that the paid pack uses the lettering-specialist model path.

- [ ] **Step 1: Write the failing test**

Cover:

1. Quota: a payer at `FREE_GIGS_PER_PAYER` is refused with an actionable message; a 4th attempt in the window is refused; usage older than `FREE_GIG_WINDOW_DAYS` does not count.
2. `fetchSourceLogo` rejects a >10 MB body, a non-image magic-byte prefix, a raster below `MIN_SOURCE_PX`, and a timeout — each with a distinct, actionable reason.
3. `fetchSourceLogo` accepts a valid PNG and a valid SVG.
4. `buildFaviconPack` from a 512 px raster source produces **every `FAVICON_ZIP_ENTRIES` entry and nothing more** — each PNG at its exact size (IHDR-read), the ICO parse-back passing, and NO `logo.svg` in the ZIP.
5. `buildFaviconPack` from an SVG source renders each size from the vector (16 px and 512 px outputs differ in content, not just scale).
6. The favicon path end-to-end records **zero** vendor spend (`checkpoint.spendUsd === 0`).
7. The taster delivers even when the OCR verdict fails, and the delivery note names the $25 gig.
8. The warranty revision round (FR-18) re-runs generation → gates → pack under a fresh FR-5-sized cap and does not consume the buyer's free-gig quota.

- [ ] **Step 2: Write the modules, run the tests**

- [ ] **Step 3: Re-measure the bundle**

photon joins the bundle **here** — it was tree-shaken out of the Task 10 measurement while unimported. Repeat the Task 10 step-6 measurement (`wrangler deploy --dry-run --outdir` + `du`), record the new compressed size in the commit message, and apply the same escalation rule: if the three-WASM set now presses the Workers limit, stop and take the §16 container fallback for the pack stage.

- [ ] **Step 4: Commit**

```bash
git add apps/logosmith-bot/src/freeGigs.ts apps/logosmith-bot/src/freeGigs.test.ts apps/logosmith-bot/src/pack/faviconPack.ts apps/logosmith-bot/src/pack/faviconPack.test.ts apps/logosmith-bot/src/pipeline.ts
git commit -m "feat(logosmith): favicon pack builder, klein taster, quotas, revision round

Bundle size with photon included: <record the du output here>.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Phase G — Calibration and documentation

### Task 24: Calibration harness, README, and runbooks

**Files:**
- Create: `apps/logosmith-bot/src/calibration/goldens.json`
- Create: `apps/logosmith-bot/src/calibration/harness.ts`
- Create: `apps/logosmith-bot/README.md`
- Test: `apps/logosmith-bot/src/calibration/harness.test.ts`

**Interfaces:**
- Produces: `GOLDEN_NAMES: GoldenName[]`; `runCalibration(deps): Promise<CalibrationReport>`; `summarize(results): CalibrationSummary`.

The harness is **code** because §14 requires a golden-set regression run whenever the pinned vision model version changes; the calibration *run itself* is ops. `goldens.json` holds ≥30 brand names spanning plain → ornate, including ampersands, hyphens, diacritics, and deliberately hard cases (repeated letters, all-caps, single characters). `runCalibration` generates each name across the three axes, runs the OCR gate `n` times per image (default 5) to measure repeatability, and reports: garbled-detection rate, stylized-but-legible pass rate, per-run score variance, regeneration burn per axis, and the pairwise pHash distribution.

- [ ] **Step 1: Write the failing test**

`summarize` is the testable core — feed it fixture results and assert:

1. It computes the garbled-detection rate (fraction of known-bad images scored below threshold) and the stylized pass rate (fraction of known-good images at or above it).
2. It reports per-image score variance across repeat runs and flags any image whose runs straddle the threshold as **unstable** — that instability, not the mean, is what §13 calls the drift risk.
3. It reports the pHash distribution as min / median / p10 across all pairs.
4. It refuses to emit a "freeze these thresholds" recommendation when the golden set has fewer than 30 names or when any image is unstable.

- [ ] **Step 2: Write the harness and the README**

The README must document, at minimum:

- **Phase 0 ops checklist** — vendor commercial/resale terms verification for Ideogram, Recraft, Vectorizer.ai, and FLUX.2 [klein] hosted outputs, with the in-repo decision record and the date; API keys; the Vectorizer.ai plan; the Google Fonts key.
- **Ordered deploy runbook** — `wrangler d1 create logosmith` → paste ids → `wrangler d1 migrations apply` → `wrangler secret put` for each secret → `wrangler deploy` → `POST /admin/register` once.
- **DLQ replay runbook** — how to re-enqueue a dead-lettered message and why stage claims make replay safe.
- **The calibration procedure** and where the frozen thresholds must be written back (`config.ts` constants + the listed gig terms).
- **The honest scope statement**: trademark is not checked and not warranted; Latin script only; taste is advisory.

- [ ] **Step 3: Full verification**

```bash
pnpm -w build && pnpm -w typecheck && pnpm -w lint
cd apps/logosmith-bot && pnpm test && pnpm exec wrangler deploy --dry-run
```

All must pass with zero warnings before this task is complete.

- [ ] **Step 4: Commit**

```bash
git add apps/logosmith-bot/src/calibration apps/logosmith-bot/README.md
git commit -m "feat(logosmith): calibration harness, README, and operator runbooks

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 25: Dispute response path

**Files:**
- Create: `apps/logosmith-bot/src/disputes.ts`
- Modify: `apps/logosmith-bot/src/index.ts` (replace the two `logOnly` dispute handlers)
- Test: `apps/logosmith-bot/src/disputes.test.ts`

**Interfaces:**
- Consumes: `AgentMcpClient` from `@botguild/agent-core`; `JobStore`, `ConceptStore`, `SelectionStore` from `./jobs.js`; `buildValidationReport` from `./report.js`.
- Produces: `assembleDisputeEvidence(deps, contractId): Promise<DisputeEvidence>`; `createDisputeResponder(deps): DisputeResponder` with `respond(contractId): Promise<void>`.

> **Why this is its own task.** PRD §10.9 requires `contract.status.changed → disputed` and `dispute.response_submitted` to route through the MCP dispute flow carrying the D1 verdict snapshots, vendor request ids, and gate audit log as evidence. Task 12 wires both as `logOnly` handlers, matching VoiceWright — which leaves the requirement unimplemented. Everything the response needs already exists in D1 by this point, so the task is small, but it is not optional.

- [ ] **Step 1: Write the failing test**

`apps/logosmith-bot/src/disputes.test.ts` — cover:

1. `assembleDisputeEvidence` returns every OCR verdict snapshot (model id, raw transcription, score) for the contract, drawn from the `concepts` table, not recomputed.
2. It includes every `gate_audit` row for the contract, in chronological order.
3. It includes each vendor request id from `license_manifest`, so the vendor can be asked to confirm provenance.
4. It records the winner and `selectionSource`, so a "you sent me the wrong concept" dispute is answerable from the record.
5. It returns a well-formed response for a contract with **no** concepts (an aborted job that is now disputed) rather than throwing.
6. `respond` posts through the MCP client exactly once and is idempotent on a redelivered `dispute.response_submitted` event.

- [ ] **Step 2: Write the module and rewire the handlers**

`assembleDisputeEvidence` reads the three D1 tables and assembles a payload; `createDisputeResponder.respond` submits it via `AgentMcpClient`, claimed first by a unique-constraint `INSERT` into `dispute_responses` (`contract_id` PRIMARY KEY — in the Task 1 migration) so concurrent redeliveries collapse to exactly one MCP post; a read-then-write guard would race. In `index.ts`, replace:

```typescript
      'contract.status.changed': logOnly('contract.status.changed'),
      'dispute.response_submitted': logOnly('dispute.response_submitted'),
```

with ownership-filtered handlers that call `disputes.respond(contractId)` when the status is `disputed` (and unconditionally for `dispute.response_submitted`), leaving every other status change on the log-only path.

- [ ] **Step 3: Run the tests → Commit**

```bash
git add apps/logosmith-bot/src/disputes.ts apps/logosmith-bot/src/disputes.test.ts apps/logosmith-bot/src/index.ts
git commit -m "feat(logosmith): dispute response path with D1-sourced evidence

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Execution notes

**Phase gating.** Phases A, B, C, and G need no vendor keys and can be built immediately. Phases D and E are blocked on the Phase 0 vendor-terms verification, which is a **listing** blocker in the PRD but becomes a **build** blocker at Task 16. If Phase 0 is not done when Task 15 completes, build Task 24's harness and README early rather than stalling.

**The two escalation points.** Task 10 step 6 measures the WASM bundle and peak memory — if it breaches, take the §16 container fallback for the pack stage *then*, not later. Task 18's calibration data (and Task 24's harness) decide whether the OCR threshold is workable — if the golden set shows the gate cannot separate stylized-but-legible from garbled at any threshold, that is a product problem, not a tuning problem, and it needs a decision before listing.

**What must not drift.** Three things in this plan are load-bearing and should survive review unchanged: spend is checked before attempts in `decideSlotAction`; the deliverable token is random and never derived from the contract id; and moderation, OCR-unavailable, and Vectorizer outages all park rather than pass. Every one of those is a place where a plausible simplification costs real money or ships an ungated deliverable.

**Resolution.** Tasks 1–17 are specified to the step, with the full implementation and test code inline. Tasks 18–25 are specified to the *case list*: interfaces, the load-bearing algorithm (e.g. `decideSlotAction`), and an enumerated set of behaviours each test must cover — but not every line. They are integration-shaped, and their bodies depend on the exact store and gate signatures that Tasks 1–17 lock in. Write them as `node:test` describes in the same style, and **do not reduce the case list** — each enumerated case corresponds to a §9 contractual outcome or a §13 named risk.

**Task 25 was added during plan self-review.** PRD §10.9 requires the dispute path to route through MCP with D1 evidence; the VoiceWright-shaped handler wiring in Task 12 leaves it as log-only, which would have shipped the requirement unimplemented.

**A second review pass (against the live repo interfaces) fixed:** the favicon gig's own pack builder + `FAVICON_ZIP_ENTRIES` gate contract (it is not the M2 pack, and its input is usually a raster — photon's one job); the Recraft native-SVG path (rasterize for gates, persist to R2 + `concepts.native_svg_key`, or the stage-2 short-circuit can never fire); `PipelineConfig.sources` + `deliverables.get` + the bundled-wasm imports and `assets.d.ts`; $0 anchors in `pricingCalc` for the free gigs (and the `brief.ts`↔`config.ts` import direction that makes it cycle-free); vendor-outage parking instead of queue-retry burning; the FR-9 early selection trigger on M1 acceptance/auto-accept; `decideSlotAction` attempt semantics (3 attempts = 1 initial + 2 regens, spend checked first); and the progress page's reload-on-change guard.







