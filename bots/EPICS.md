# BotGuild Agents — Epics & Stories

**Version:** 1.2  
**Date:** 2026-05-06  
**Change (v1.2):** E7–E9 added — CI hardening, local dev DX, and deploy hardening — driven by gaps surfaced during the PR #1 review pass and Fly.io setup walkthrough.  
**Change (v1.1):** E5 redesigned — subscription/flat-monthly pricing removed; all standing offers use upfront multi-milestone fixed contracts (blockchain escrow does not support recurring billing). E2-S7 replaced accordingly.

---

## Epic Overview

| # | Epic | Bots | Outcome |
|---|------|------|---------|
| E1 | Agent Core Foundation | All | Shared library; any bot can discover gigs, propose, deliver, handle webhooks |
| E2 | SentinelBot — Monitoring Agent | SentinelBot | Live monitoring bot accepting gigs and running scheduled watch jobs |
| E3 | FlowBot — Data Transform Agent | FlowBot | Live ETL bot accepting gigs and delivering clean structured data |
| E4 | VerifierBot — QA Agent | VerifierBot | Live QA bot accepting gigs and delivering pass/fail reports |
| E5 | Standing Offers (multi-milestone packages) | All | All three bots publish standing offer templates; each hire is an upfront fixed-price gig with weekly milestones |
| E6 | Infra, Deployment & Observability | All | All three bots deployed on Fly.io, monitored, secrets managed |
| E7 | CI Hardening | All | Every push runs typecheck + tests + Docker build; main is protected; bad code can't merge |
| E8 | Local Dev Experience | All | One command brings up a hot-reload dev stack with public webhook URL; new contributors are productive in under 15 minutes |
| E9 | Deploy Hardening | All | Path-filtered, gated deploys with post-deploy health verification; deploy of one bot can't accidentally redeploy others |

---

## E1 · Agent Core Foundation

**Goal:** A shared `agent-core` package that any bot can import to get: BotGuild client, webhook server, gig poller, scorer, proposer, and standing offer sync. No bot should implement these from scratch.

---

### E1-S1 · Repo scaffold and workspace setup

**As a developer**, I need the `botguild-agents` monorepo initialized with pnpm workspaces and Turborepo so that I can add packages and apps without manual dependency wiring.

**Acceptance criteria:**
- `pnpm install` succeeds from repo root
- `pnpm build` builds `agent-core` and all three bot apps in dependency order
- `pnpm typecheck` passes clean
- `turbo.json` defines `build`, `dev`, and `typecheck` pipelines
- Each app has its own `tsconfig.json` extending a shared base

**Notes:** Mirror the structure used in `botguild-platform` (Turborepo + pnpm workspaces). No tests required in this story — test scaffolding is a separate story.

---

### E1-S2 · BotGuild API client wrapper

**As a bot**, I need a typed client wrapper around `BotGuildREST` that handles retries, logs requests, and injects my `botId` automatically so that I don't repeat that logic in every bot.

**Acceptance criteria:**
- `AgentClient` class wraps all `BotGuildREST` methods used by bots
- Automatically retries on 429 (respects `Retry-After`) and 5xx (3 attempts, exponential backoff)
- Logs each request (method, path, status, latency) via `pino`
- Throws a typed `AgentError` on non-retryable failures with original status + message
- `botId` is injected into proposal, message, and standing offer calls

**Notes:** Do not wrap every `BotGuildREST` method — only those used by the three bots: `listGigs`, `submitProposal`, `listContracts`, `getContract`, `deliverMilestone`, `sendMessage`, `registerWebhook`, `listWebhooks`, `deleteWebhook`, `createStandingOffer`, `updateStandingOffer`, `listStandingOffers`.

---

### E1-S3 · Webhook server factory

**As a bot**, I need a webhook server that verifies BotGuild HMAC signatures and dispatches typed events so that I can register handlers for specific events without writing HTTP boilerplate.

**Acceptance criteria:**
- Built on Hono; exposes `POST /webhook` and `GET /health`
- Rejects requests with invalid or missing `X-Webhook-Signature` with 401
- Dispatches to registered handlers by event type using `server.on(eventType, handler)`
- Unhandled event types are logged and return 200 (no-op acknowledgement)
- Handler errors are caught, logged with full context, and return 500 (triggers BotGuild retry)
- `GET /health` returns `{ status: 'ok', botId, uptime }` — used as Fly.io HTTP health check

---

### E1-S4 · Gig poller

**As a bot**, I need a polling loop that fetches new open gigs on a configurable interval and calls my handler for each new unseen gig so that I can discover work without managing HTTP calls myself.

**Acceptance criteria:**
- Polls `GET /gigs?status=open&category=<category>` on a configurable interval (default: 10 min)
- Maintains an in-memory seen-set keyed by gig ID
- Calls `onGig(gig)` callback for each unseen gig exactly once per poll cycle
- If `listGigs` fails, logs the error and skips the cycle (does not crash)
- Poller can be started and stopped cleanly

---

### E1-S5 · Gig scorer

**As a bot**, I need a scoring function that evaluates a gig against my profile and returns a 0–100 score so that I can decide whether to propose without hard-coding heuristics in every bot.

**Acceptance criteria:**
- Implements the 5-factor scoring model (category 40, budget 20, warranty 15, clarity 15, timeline 10)
- Category mismatch → score 0 regardless of other factors
- Each factor score is individually exported for testability
- Score < configurable threshold → `shouldPropose` returns false
- Written with unit tests covering: perfect match, category miss, budget miss, no acceptance criteria

---

### E1-S6 · Proposal generator (Claude integration)

**As a bot**, I need a function that takes a gig + my profile and returns a ready-to-submit proposal so that I don't have to write Claude prompting logic in each bot.

**Acceptance criteria:**
- Uses `claude-haiku-4-5` with prompt caching on the system prompt
- System prompt (bot identity, working style, warranty, capability list) is a static prefix ≥ 1024 tokens to qualify for caching
- Computes price using a provided `pricingCalc(gig)` function — Claude does not set prices
- Returns a typed `ProposalDraft` with: `price`, `timeline`, `milestones[]`, `warrantyOffer`, `coverNote`
- Falls back to a template `coverNote` if Claude fails (no crash)
- `coverNote` generation is ≤ 200 tokens output

---

### E1-S7 · Standing offer sync

**As a bot**, I need a startup routine that compares my locally defined standing offers against what's registered on BotGuild and creates or updates them so that my offers stay current without manual dashboard work.

**Acceptance criteria:**
- On startup: fetches existing offers for my `botId`
- Creates offers present locally but not on platform
- Updates (PATCH) offers where local definition differs from remote (title, price, description, slaTerms)
- Does not touch offers on the platform that have no local counterpart
- Logs: created N, updated N, unchanged N

---

### E1-S8 · Bot profile registration

**As a bot**, I need a startup routine that registers or updates my bot profile on BotGuild so that I don't have to manually create it via the dashboard and it stays current with my config.

**Acceptance criteria:**
- On startup: searches for existing bot by `handlerId + name`
- If found: PATCH with current config values (idempotent)
- If not found: POST to create
- Fails loudly (halts startup) if registration fails — a bot cannot operate without a valid `botId`
- Returns the registered `botId` which is stored in memory for the session

---

### E1-S9 · Webhook registration on startup

**As a bot**, I need to register my webhook endpoint with BotGuild on startup and clean up stale registrations so that I receive events reliably without accumulating duplicate webhooks.

**Acceptance criteria:**
- On startup: calls `GET /webhooks` to list existing registrations
- If my endpoint URL is already registered: no action
- If my endpoint URL is not registered: call `POST /webhooks` and persist the returned secret
- If multiple registrations exist for my endpoint: delete duplicates, keep newest
- If stored secret doesn't match expected value: re-register
- Webhook URL is configurable via `WEBHOOK_BASE_URL` env var + `/webhook` path

---

## E2 · SentinelBot — Monitoring Agent

**Goal:** A live bot that discovers monitoring gigs, proposes on them, configures watch jobs, delivers reports on schedule or on-event, and services standing offer subscriptions.

---

### E2-S1 · Bot config and profile

**As the SentinelBot operator**, I need the bot's BotGuild profile defined in code so that its marketplace identity is consistent and version-controlled.

**Acceptance criteria:**
- `config.ts` defines: name, category (`Ops & Automation`), workingStyle (`glass-box`), valueChainPosition (`verifier`), pricingModel (`fixed`), toolchain, warrantyTerms, bio
- Config includes pricing rules: base rates per watch type, complexity multipliers, budget min/max
- Config includes gig score threshold and adjacent categories for scoring
- Standing offers defined: at minimum "Daily Site Watch" (flat-monthly) and "API Health Monitor" (flat-monthly)

---

### E2-S2 · Gig parser — extract watch job config from gig

**As SentinelBot**, when I accept a gig I need to parse the gig description and deliverables into a structured watch job config so that I know exactly what to monitor and how to deliver.

**Acceptance criteria:**
- Uses Claude (Haiku) to extract from unstructured gig text: `targets[]` (URLs/APIs), `watchType` (uptime/change/price/scheduled), `schedule` (cron or event-driven), `deliveryChannelHint` (Slack/Telegram/report), `reportFormat` (summary/diff/raw)
- Output is a typed `WatchJobConfig`
- If extraction confidence is low (Claude flags uncertainty), sends a `clarification_request` message to the payer thread
- Extraction failure logs and pauses the contract (does not silently fail)

---

### E2-S3 · Uptime / HTTP health check runner

**As SentinelBot**, I need to check whether a URL or API endpoint is responding correctly so that I can detect downtime and report it.

**Acceptance criteria:**
- Fetches target with configurable timeout (default: 10s)
- Records: status code, response time, error (if any)
- Considers failure: non-2xx status, timeout, DNS failure, connection refused
- Stores last-known state (up/down + timestamp) in jobs.json
- On state change (up→down or down→up): triggers immediate milestone delivery
- On no change: no delivery (just updates last-checked timestamp)

---

### E2-S4 · Page change / content diff runner

**As SentinelBot**, I need to fetch a web page, compare its content to the previous version, and report what changed so that I can detect meaningful changes (price, copy, structure).

**Acceptance criteria:**
- Fetches page HTML via Playwright (headless, no JS by default; JS enabled if `requiresJs: true`)
- Extracts configured selector(s) or full text content
- Compares current to previous snapshot (stored in jobs.json as hash + excerpt)
- If changed: generates diff summary via Claude (Haiku), notes what section changed and what the new content is
- If unchanged: logs no-op, does not deliver
- Screenshot stored and uploaded if `screenshot: true` in config

---

### E2-S5 · Scheduled report delivery

**As SentinelBot**, I need to run a watch job on a cron schedule and deliver a milestone when the schedule fires so that recurring report gigs are serviced reliably.

**Acceptance criteria:**
- Cron jobs use `node-cron` with expressions parsed from `WatchJobConfig.schedule`
- On cron fire: run the configured check, generate report via Claude, deliver milestone via `AgentClient.deliver()`
- Delivery includes: inline summary (progress update), report file uploaded to BotGuild R2, download link in milestone note
- If delivery fails: retry once after 60 seconds, then log fatal and pause the job

---

### E2-S6 · Contract thread communication

**As SentinelBot**, I need to send progress updates at meaningful steps so that payers can see work happening in glass-box style.

**Acceptance criteria:**
- On gig acceptance: sends "Setup confirmed" message with job config summary (targets, schedule, watch type)
- On first successful check run: sends "First check complete" with result summary
- On state change detection: sends "Change detected" before delivering milestone
- On standing offer subscription: sends "Subscription active" with schedule confirmation
- All messages use `contentType: progress_update` and `senderType: bot`

---

### E2-S7 · Standing offer gig handler

**As SentinelBot**, I need to handle a gig opened from one of my standing offer templates so that the payer gets a pre-configured multi-milestone watch package without me re-parsing the brief from scratch.

**Acceptance criteria:**
- Detects that an accepted gig originated from a standing offer template (via a `standingOfferId` field on the gig or a known title prefix)
- Looks up the matching local standing offer config to determine: watch type, default schedule, milestone count (4 weekly), and default price breakdown
- Creates the watch job config and 4 milestones automatically without sending a clarification request (config is pre-defined by the template)
- Sends "Package started" thread message with: watch targets, schedule, milestone delivery dates
- Milestone titles follow the pattern "Week N — [watch type] report"

---

## E3 · FlowBot — Data Transform Agent

**Goal:** A live bot that discovers data transformation gigs, proposes on them, executes multi-milestone ETL jobs, and delivers clean structured output.

---

### E3-S1 · Bot config and profile

**As the FlowBot operator**, I need the bot's BotGuild profile defined in code.

**Acceptance criteria:**
- `config.ts` defines: name, category (`Ops & Automation`), workingStyle (`checkpoints`), valueChainPosition (`transformer`), pricingModel (`milestone`), toolchain, warrantyTerms, bio
- Pricing rules: base rates per input type (CSV $75, PDF $90, API $120, multi-source $150), complexity multipliers for row count and schema complexity
- Standing offers defined: "Daily Data Sync" (flat-monthly), "Invoice Processing Lane" (per-use)

---

### E3-S2 · Gig parser — extract transform job config

**As FlowBot**, when I accept a gig I need to parse the gig into a structured transform job config so that I know the input source, target schema, and transformation rules.

**Acceptance criteria:**
- Uses Claude (Haiku) to extract: `inputType` (csv/pdf/api/sheet), `inputSource` (URL or attachment), `targetSchema` (column names + types), `transformRules` (dedup key, date format, required fields), `outputFormat` (csv/json/airtable)
- Returns typed `TransformJobConfig`
- On ambiguity: sends `clarification_request` message to payer thread with specific questions
- Milestone plan is generated: always 3 milestones (fetch+validate → transform → deliver)

---

### E3-S3 · CSV extractor

**As FlowBot**, I need to read and parse CSV files from URLs or uploaded attachments so that I can process tabular data.

**Acceptance criteria:**
- Downloads file from provided URL (handles redirects, auth headers if provided)
- Parses with `papaparse`: auto-detects delimiter, handles BOM, trims whitespace
- Reports: row count, column names, sample (first 3 rows), detected types per column
- Handles malformed rows: logs them, excludes from output, reports count in summary
- Sends `progress_update` with parse summary after milestone 1

---

### E3-S4 · PDF extractor

**As FlowBot**, I need to extract structured data from PDF documents (invoices, receipts, reports) so that I can transform unstructured documents into tabular output.

**Acceptance criteria:**
- Downloads PDF from URL
- Extracts raw text with `pdf-parse`
- Sends extracted text + target schema to Claude (Sonnet — better structured extraction) with instruction to return JSON matching schema
- If confidence < threshold (Claude flags uncertainty): marks rows as `needs_review` in output, reports count
- Handles multi-page PDFs: processes all pages, deduplicates across pages if needed
- Output matches target schema with typed fields

---

### E3-S5 · API extractor with pagination

**As FlowBot**, I need to fetch data from a paginated REST API and collect all pages so that I don't miss records when the dataset spans multiple pages.

**Acceptance criteria:**
- Supports three pagination styles: offset (`?page=N&limit=M`), cursor (`?after=TOKEN`), Link header
- Fetches up to a configurable max-records limit (default: 10,000) to prevent runaway fetches
- Supports configurable auth: Bearer token, API key header, basic auth
- Sends `progress_update` after each page batch (every 5 pages or 1000 records, whichever first)
- Returns records as typed array matching target schema

---

### E3-S6 · Data normalizer and deduplicator

**As FlowBot**, I need to normalize extracted data and remove duplicates so that the delivered output is clean and ready to use.

**Acceptance criteria:**
- Normalizes dates to ISO 8601 (handles common formats: MM/DD/YY, DD-MM-YYYY, Unix timestamp)
- Normalizes phone numbers to E.164 if present (best-effort, flags failures)
- Trims whitespace from all string fields
- Strips empty rows (all fields null/empty)
- Deduplicates on configured `dedupKey` (keeps last-seen record on conflict)
- Reports: original count, after-dedup count, normalized count, skipped/invalid count

---

### E3-S7 · Output delivery

**As FlowBot**, I need to deliver the transformed output file and a summary to the payer so that the milestone is complete and payout is triggered.

**Acceptance criteria:**
- Serializes output to configured format (CSV via `papaparse.unparse`, JSON via `JSON.stringify`)
- Uploads file to BotGuild via `POST /uploads`
- Delivers milestone with: inline summary (row count, schema, key stats), download link, and "what we did" note
- Summary generated by Claude (Haiku) from transform stats — 3–4 sentences, plain language
- If output is 0 rows: does not deliver — sends clarification request to payer first

---

## E4 · VerifierBot — QA Agent

**Goal:** A live bot that discovers QA and acceptance-checking gigs, proposes, runs structured checks, and delivers pass/fail reports with evidence.

---

### E4-S1 · Bot config and profile

**As the VerifierBot operator**, I need the bot's BotGuild profile defined in code.

**Acceptance criteria:**
- `config.ts` defines: name, category (`Testing & QA`), workingStyle (`glass-box`), valueChainPosition (`verifier`), pricingModel (`fixed`), toolchain, warrantyTerms, bio
- Pricing rules: base rates per check type (smoke $100, data quality $80, API contract $90, acceptance audit $60)
- Standing offers defined: "Nightly Smoke Test" (flat-monthly), "Acceptance Review Pack" (per-use)

---

### E4-S2 · Gig parser — extract check plan from gig

**As VerifierBot**, when I accept a gig I need to parse the gig into a structured check plan so that I know what to test and what the pass/fail criteria are.

**Acceptance criteria:**
- Uses Claude (Sonnet — needs accurate reasoning for criteria interpretation) to extract: `checkType`, `targets[]` (URLs, files, or prior deliverable references), `criteriaList[]` (each criterion with expected outcome), `evidenceRequired` (screenshot, response log, sample rows)
- Returns typed `CheckPlan` with milestone plan: always 2 milestones (run checks → deliver report)
- If acceptance criteria are ambiguous: sends clarification request before starting checks

---

### E4-S3 · HTTP / API check runner

**As VerifierBot**, I need to verify that an API endpoint responds correctly according to stated criteria so that I can check API contracts and uptime as part of a QA report.

**Acceptance criteria:**
- Checks: status code, response time (vs. threshold), response body schema (via AJV), required headers
- Records: pass/fail per check, actual vs. expected value, latency
- Supports authenticated endpoints (Bearer, API key, basic auth from gig config)
- Runs each check up to 3 times (flakiness guard); marks as fail only if all 3 fail

---

### E4-S4 · DOM / UI check runner with screenshots

**As VerifierBot**, I need to load a web page in a browser and verify UI elements so that I can check that a front-end meets its acceptance criteria.

**Acceptance criteria:**
- Uses Playwright (headless Chromium)
- Checks: element presence (CSS selector), text content match, element visibility, form submit response
- Takes a full-page screenshot after each check group
- Screenshots uploaded to BotGuild R2 via `/uploads`
- Returns screenshot URLs for inclusion in the report

---

### E4-S5 · Data quality check runner

**As VerifierBot**, I need to analyze a data file or API response and report on its quality so that I can verify FlowBot deliverables or any other data artifact.

**Acceptance criteria:**
- Inputs: CSV URL, JSON URL, or inline JSON sample
- Checks per column/field: null rate, type correctness, uniqueness rate, value range (for numerics), pattern match (for strings with stated format)
- Reports: per-column stats table + pass/fail per stated threshold (e.g., "null rate < 1%")
- Flags outliers (values > 3σ from mean for numerics) as warnings, not failures

---

### E4-S6 · Acceptance criteria audit (Claude-powered)

**As VerifierBot**, I need to evaluate whether a deliverable meets stated acceptance criteria when the criteria are qualitative or require judgment so that I can verify work that can't be checked programmatically.

**Acceptance criteria:**
- Accepts: criteria list + deliverable content (file, URL, or text excerpt)
- Sends to Claude (Sonnet) with instruction to score each criterion pass/fail/partial with one-sentence reasoning
- Claude output is structured JSON: `[{ criterion, verdict, reasoning, confidence }]`
- Low-confidence verdicts (< 0.7) are flagged as "needs human review" in report
- This check type is always the last check run (after programmatic checks)

---

### E4-S7 · Report generator and delivery

**As VerifierBot**, I need to compile all check results into a structured pass/fail report and deliver it as a milestone so that the payer receives clear, actionable output.

**Acceptance criteria:**
- Report format: markdown with sections: Verdict (PASS/FAIL/PARTIAL), Summary, Per-criterion Table, Evidence, Recommendations
- Overall verdict: PASS if all checks pass, FAIL if any critical check fails, PARTIAL if warnings only
- Report generated by Claude (Haiku) from structured check results — not free-form prose
- Report uploaded to BotGuild R2 and delivered as milestone attachment
- Inline milestone note includes: verdict, pass/fail counts, critical failures highlighted
- If FAIL: recommendations section includes specific remediation steps

---

## E5 · Standing Offers (multi-milestone packages)

**Goal:** All three bots publish standing offer templates on BotGuild. Each hire creates an upfront fixed-price gig with escrow covering the full package; the bot delivers one milestone per period (weekly or per-batch). No subscription billing — each contract is discrete.

**Design principle:** A standing offer is a well-defined, pre-priced service template. Payers open a gig from the template with minimal configuration; the bot auto-configures milestones from the template definition rather than parsing a free-form brief.

---

### E5-S1 · SentinelBot standing offer: Site Watch Package

**As a payer**, I want to hire SentinelBot for a 4-week site monitoring package so that I get weekly diff reports and immediate alerts without writing a custom gig brief.

**Acceptance criteria:**
- Standing offer template published: fixed price (4-week package), deliverable = 4 weekly milestone reports + immediate thread alert on change detection
- Template defines default config: once-daily page diff, full-page screenshot on change, summary diff via Claude
- On hire: bot auto-creates 4 milestones ("Week 1 — Site Watch Report" … "Week 4"), no clarification request needed unless targets are missing
- Each weekly milestone includes: change count, diff summary, screenshots if any changes, "no changes detected" note if clean week
- Alert on change: thread message within 15 minutes of detection (does not wait for weekly milestone)

---

### E5-S2 · SentinelBot standing offer: API Health Monitor Package

**As a payer**, I want to hire SentinelBot for a 4-week API monitoring package so that I receive weekly uptime summaries and immediate downtime alerts.

**Acceptance criteria:**
- Standing offer template published: fixed price (4-week package), deliverable = 4 weekly uptime summary milestones
- Template defines default config: health check every 15 minutes, records status code + latency
- On hire: bot auto-creates 4 weekly milestones, begins polling immediately
- Each weekly milestone includes: uptime percentage, total checks, downtime incidents with timestamps and durations
- Downtime alert: thread message within 15 minutes of first failure detection

---

### E5-S3 · FlowBot standing offer: Data Sync Package

**As a payer**, I want to hire FlowBot for a recurring data sync package so that my data source is fetched, normalized, and delivered on a fixed schedule.

**Acceptance criteria:**
- Standing offer template published: fixed price, deliverable = N milestone deliveries (payer chooses 4-weekly or 8-biweekly at hire time via gig description)
- Template defines default config: up to 3 input sources, CSV or JSON output
- On hire: bot auto-creates milestones based on chosen cadence; each milestone = one sync run delivery
- Each milestone includes: output file upload, row count, error count, any schema drift detected vs. prior run
- If a sync run produces 0 rows: delivers milestone with explanation rather than silently skipping

---

### E5-S4 · FlowBot standing offer: Invoice Processing Batch

**As a payer**, I want to hire FlowBot to process a batch of invoices so that I receive a structured CSV without writing a custom ETL brief.

**Acceptance criteria:**
- Standing offer template published: fixed price per batch (single-milestone gig)
- Payer pastes invoice URLs or attaches files in the gig description or opening thread message
- Bot processes all documents in the batch as a single milestone: PDF extraction → normalize → deliver CSV
- Milestone includes: document count, row count, any `needs_review` flags, download link
- Turnaround: milestone delivered within 4 hours of contract acceptance

---

### E5-S5 · VerifierBot standing offer: Nightly Smoke Test Package

**As a payer**, I want to hire VerifierBot for a 4-week nightly smoke test package so that I receive weekly regression summaries and immediate critical failure alerts.

**Acceptance criteria:**
- Standing offer template published: fixed price (4-week package), deliverable = 4 weekly summary milestones
- Template defines default config: nightly run at 2am UTC, HTTP + DOM checks
- On hire: bot auto-creates 4 weekly milestones; each covers 7 nightly runs
- Each milestone includes: pass/fail per check, regression count vs. prior week, nightly trend table
- Critical failure alert: thread message within 15 minutes of a nightly run that has any `FAIL` verdict

---

### E5-S6 · VerifierBot standing offer: Acceptance Review

**As a payer**, I want to hire VerifierBot to review a single deliverable against stated criteria so that I get a structured pass/fail report quickly.

**Acceptance criteria:**
- Standing offer template published: fixed price per review (single-milestone gig)
- Payer provides deliverable URL/content and criteria list in gig description
- Bot runs full check suite (HTTP, DOM if applicable, Claude criteria audit) as a single milestone
- Milestone delivers the standard VerifierBot report: Verdict, per-criterion table, evidence, recommendations
- Turnaround: milestone delivered within 4 hours of contract acceptance

---

## E6 · Infrastructure, Deployment & Observability

**Goal:** All three bots are deployed on Fly.io, secrets are managed, health is monitored, and logs are searchable.

---

### E6-S1 · Dockerfiles for all three bots

**Acceptance criteria:**
- Each bot has a `Dockerfile` with multi-stage build: `deps` → `build` → `runner`
- `runner` stage is `node:22-slim` (SentinelBot and VerifierBot use Playwright base image for Chromium)
- Image builds pass `docker build` with no warnings
- Images are < 500MB (excluding Playwright base)

---

### E6-S2 · Fly.io app configuration and deployment

**Acceptance criteria:**
- Each bot has a `fly.toml` configured: app name, region (`iad`), HTTP service on correct port, `min_machines_running = 1`
- `fly secrets set` documented in `README.md` for all required env vars
- `fly deploy` succeeds for all three bots from CI
- Persistent volume mounted for SentinelBot's `jobs.json`

---

### E6-S3 · GitHub Actions deployment pipeline

**Acceptance criteria:**
- `.github/workflows/deploy-agents.yml` deploys all three bots on push to `main`
- Uses `superfly/flyctl-actions` action
- Requires: `FLY_API_TOKEN` secret in GitHub
- Deploys in parallel (not sequential)
- Fails fast: if one bot deployment fails, others continue but pipeline is marked failed

---

### E6-S4 · Structured logging with pino

**Acceptance criteria:**
- All bots use `pino` with JSON output
- Log levels: `debug` (suppressed in prod), `info` (normal operations), `warn` (retries, fallbacks), `error` (failures), `fatal` (halt conditions)
- Every log line includes: `service` (bot name), `botId`, `gigId` or `contractId` when in context, `durationMs` for timed operations
- Log shipping configured: Fly.io log drain → Axiom (or Logtail as alternative)

---

### E6-S5 · Local development with docker-compose

**Acceptance criteria:**
- `docker-compose.yml` at repo root starts all three bots
- Reads from `.env` file (`.env.example` committed with placeholder values)
- Each bot connects to `BOTGUILD_API_URL=http://host.docker.internal:8787` for local BotGuild dev
- `WEBHOOK_BASE_URL` can be set to an ngrok URL for local webhook testing
- `docker-compose up` starts cleanly without errors on a fresh checkout

---

### E6-S6 · Health monitoring and alerting

**Acceptance criteria:**
- Fly.io HTTP health check configured for `GET /health` on each bot (interval: 30s, timeout: 5s, passing threshold: 2, failing threshold: 3)
- On machine restart (Fly.io event): sends a Telegram message to handler with bot name, restart time, and last error log line
- Fly.io metrics dashboard link documented in `README.md`

---

## E7 · CI Hardening

**Goal:** Every push (not just PRs) verifies typecheck, tests, and a Docker build so regressions surface before they reach `develop` (or `main` on release). The biggest gap surfaced during PR #1 review was that 35 review comments — including a blocking `tsconfig` issue and a CI-breaking lockfile — could only be caught by a human reviewer because the existing CI ran nothing beyond a single typecheck. Branch protection isn't available on this GitHub plan, so the safety net is "fast green CI + gitflow conventions" rather than enforced rules.

---

### E7-S1 · Run unit tests on every push

**As a maintainer**, I need `pnpm test` to run automatically on every push and PR so that test regressions can't slip into `main` unnoticed.

**Acceptance criteria:**
- `.github/workflows/typecheck.yml` (or a renamed `ci.yml`) runs `pnpm test` after typecheck succeeds
- Triggers on `push` to any branch *and* `pull_request` to `main`
- Test job fails the workflow when any test fails
- Job uses the same pnpm/Node versions as typecheck (single setup step or shared composite action)
- Cache `~/.pnpm-store` and `~/.cache/playwright` across runs to keep CI under 3 minutes

---

### E7-S2 · Verify Docker builds in CI

**As a maintainer**, I need each bot's Docker image to build successfully in CI before merge so that a broken Dockerfile never reaches `flyctl deploy`.

**Acceptance criteria:**
- New CI job `docker-build` runs `docker buildx build` for all three bots in parallel
- Uses BuildKit cache (e.g. GitHub Actions cache backend) so unchanged dependencies don't re-download
- Build job runs on every push and PR
- Job fails when any bot's Dockerfile fails to build or produces warnings
- Total docker-build job time under 5 minutes on cache-warm runs

---

### E7-S3 · Configure linting (ESLint + format check)

**As a maintainer**, I want `pnpm lint` to actually do something so the existing turbo `lint` task isn't a lie.

**Acceptance criteria:**
- ESLint configured at the repo root with TypeScript support (`@typescript-eslint`)
- Each workspace package has a `lint` script (`eslint . --max-warnings=0`)
- Prettier installed for format-checking; `format:check` script added at root
- CI runs `pnpm lint` and `pnpm format:check`
- Existing source passes lint cleanly (or violations are fixed in this story; no `--fix` needed at runtime)

---

### E7-S4 · Adopt gitflow with `develop` as default branch

**As a maintainer**, I want a clear gitflow so that day-to-day work integrates on `develop` and only release-ready commits land on `main`. The repo isn't on a GitHub plan with branch protection, so the discipline lives in convention plus CI rather than enforced rules.

**Acceptance criteria:**
- `develop` branch created from `main` and pushed to origin
- GitHub default branch changed to `develop` (so PRs and clones default to it)
- Deploy workflow continues to trigger only on push to `main` (releases)
- CI runs on push to any branch *and* on PR targeting either `develop` or `main`
- `docs/cicd/gitflow.md` documents the model: epic/feature branches branch off `develop` and target `develop`; releases merge `develop → main`
- Pull-request template at `.github/pull_request_template.md` reminds contributors that the default base is `develop`
- README updated to reference the gitflow doc

---

### E7-S5 · Consolidate workflow into `ci.yml` with aggregate status

**As a contributor**, I want a single `ci.yml` workflow with a final aggregate status job so PR pages show one green ✓ when everything passed and the file is named after what it actually does.

**Acceptance criteria:**
- Workflow file renamed from `typecheck.yml` to `ci.yml` (the workflow's `name:` is already "CI")
- All existing jobs (lint, typecheck, test, docker-build matrix) live in `ci.yml`
- Final `ci-success` job runs `if: always()` and depends on all others — passes only when none of the upstream jobs failed; useful as the single thing reviewers check on a PR
- Workflow continues to run on push (any branch) and PRs to `develop` and `main`
- No other workflow file references `typecheck.yml`

---

## E8 · Local Dev Experience

**Goal:** A new contributor goes from `git clone` to a working hot-reload dev stack — including public webhook URL — in under 15 minutes. Today they get a production docker-compose that requires a full rebuild on every code change.

---

### E8-S1 · Hot-reload dev compose profile

**As a contributor**, I want `docker compose --profile dev up` to launch all three bots in `tsx watch` mode with bind-mounted source so editing TypeScript reloads the running bot in seconds, not minutes.

**Acceptance criteria:**
- `docker-compose.dev.yml` (overlay) defines `*-dev` services for each bot using a smaller dev base image
- Bind-mounts `./apps/<bot>/src`, `./packages/agent-core/src`, and the corresponding workspace `package.json` files
- Runs `pnpm --filter @botguild/<bot> dev` (which already invokes `tsx watch`)
- Healthchecks honor `start_period` long enough for the watcher's first compile
- Documented at the top of `README.md` as the recommended dev workflow

---

### E8-S2 · Run a single bot easily

**As a contributor**, I want to bring up just one bot without the others (e.g. when iterating on FlowBot only) so dev resource use stays low.

**Acceptance criteria:**
- Compose profiles or named services let you run `docker compose up flow-bot-dev`
- Per-bot npm script at root: `pnpm dev:flow`, `pnpm dev:sentinel`, `pnpm dev:verifier`
- Each script tears down only its own service on Ctrl-C
- Documented in `README.md` and `docs/local-dev/quickstart.md`

---

### E8-S3 · Cloudflared tunnel sidecar for webhooks

**As a contributor**, I want a public URL pointing at my local bot so the BotGuild platform can deliver `proposal.accepted` webhooks during development without me running `ngrok` separately.

**Acceptance criteria:**
- Optional `cloudflared` (or `ngrok` — pick one and document why) sidecar service in `docker-compose.dev.yml`, gated by a profile or `--profile tunnel`
- On startup, sidecar prints the public URL to stdout in a parseable format
- Helper script `scripts/tunnel-url.sh` extracts that URL and exports `WEBHOOK_BASE_URL` to the bot containers
- Tunnel survives bot restarts (URL stays stable for the session)
- Cleanup on `docker compose down` removes the tunnel cleanly

---

### E8-S4 · Per-bot env files

**As a contributor**, I want per-bot `.env` files so I can give each bot a different `BOTGUILD_BOT_ID` / `WEBHOOK_BASE_URL` without juggling one shared `.env`.

**Acceptance criteria:**
- Compose `env_file` directive points each service at `apps/<bot>/.env.local`
- A root `.env.shared` (or unchanged `.env`) holds keys all three bots share (`ANTHROPIC_API_KEY`, etc.)
- `.env.example` files updated for both root-shared and per-bot overrides
- All `.env.local` files added to `.gitignore`
- Compose `env_file` order documented so per-bot values override shared

---

### E8-S5 · Mock BotGuild platform fixture

**As a contributor**, I want a stub BotGuild API server so I can run the bots end-to-end offline (no real `BOTGUILD_API_KEY`, no live network).

**Acceptance criteria:**
- New package `packages/mock-botguild` exposes a Hono server with stubs for `GET /gigs`, `POST /gigs/:id/proposals`, `POST /contracts/:id/milestones/:id/deliver`, `GET /webhooks`, `POST /webhooks`, `GET /standing-offers`, `POST /standing-offers`
- Fixture data lives in `packages/mock-botguild/fixtures/*.json` (sample gigs, contracts) so deterministic test gigs can be replayed
- Compose service `mock-platform` exposes port 8787 — already the default `BOTGUILD_API_URL` in compose
- README documents the offline dev path
- Mock signs outbound webhook deliveries with the bot's `BOTGUILD_WEBHOOK_SECRET`

---

### E8-S6 · Makefile or unified npm scripts at root

**As a contributor**, I want a discoverable list of common dev commands so I don't have to read every Dockerfile or compose override to figure out how to run things.

**Acceptance criteria:**
- Either a `Makefile` with targets (`make dev`, `make dev-flow`, `make tunnel`, `make mock`, `make test`, `make lint`) **or** equivalent root-level npm scripts (`pnpm dev`, `pnpm dev:flow`, etc.)
- `make help` (or `pnpm run` with description comments) lists every command with one-line descriptions
- Every command in `docs/local-dev/quickstart.md` corresponds to one of these targets
- No command requires the contributor to `cd` into a subdirectory

---

## E9 · Deploy Hardening

**Goal:** Deploys to Fly.io are scoped, gated, and verified. Touching `flow-bot` shouldn't redeploy `verifier-bot`; a deploy that brings up a broken `/health` should fail the workflow loudly.

---

### E9-S1 · Path-filtered deploy jobs

**As a maintainer**, I want each bot's deploy job to run only when *its* code (or `agent-core`) actually changed so unrelated PRs don't churn unrelated bots.

**Acceptance criteria:**
- `deploy-agents.yml` uses `dorny/paths-filter` (or equivalent) to compute per-bot change flags
- Each per-bot deploy job is gated by `if: needs.changes.outputs.<bot> == 'true'`
- A change to `packages/agent-core/**` triggers all three bot deploys (it's a shared dep)
- A change to `apps/flow-bot/**` triggers only `deploy-flow`
- Workflow run shows skipped jobs explicitly so it's obvious which bots were redeployed

---

### E9-S2 · Post-deploy `/health` smoke test

**As a maintainer**, I want each deploy job to verify `GET /health` returns 200 after `flyctl deploy` so a deploy that "succeeds" but immediately crash-loops fails the workflow loudly.

**Acceptance criteria:**
- After `flyctl deploy`, the job polls `https://<app>.fly.dev/health` for up to 90 s with 5 s spacing
- Health check expects HTTP 200 and JSON body `{ "status": "ok", ... }`
- On failure, job marks the deploy failed and emits the last 50 log lines from `flyctl logs` for triage
- On success, job emits a one-line summary: app name, version, response time

---

### E9-S3 · Production environment gate

**As a maintainer**, I want a GitHub `production` environment protecting deploy jobs so secrets are scoped and a maintainer can require manual approval before a deploy ships.

**Acceptance criteria:**
- GitHub environment `production` created with `FLY_API_TOKEN` scoped to it
- Each deploy job has `environment: production`
- Required reviewer list configured for the environment (one or more maintainers)
- Documented in `docs/cicd/deploy.md` how to add reviewers and how rollback works
- Direct `flyctl deploy` from a developer laptop still works (manual override path documented)

---

### E9-S4 · Shared base Dockerfile

**As a maintainer**, I want one shared base Dockerfile so per-bot files only declare what's actually different (entrypoint, port, whether Playwright is needed) and hardening (non-root user, HEALTHCHECK, Node patch pin) lives in one place.

**Acceptance criteria:**
- New `Dockerfile.base` defines `deps` and `build` stages parameterized by `BOT_NAME` build arg
- Each bot has a thin `apps/<bot>/Dockerfile` that `FROM`s the shared image and only sets `EXPOSE`, `CMD`, and runner base (`node:22-slim` vs Playwright)
- Runner stage runs as a non-root user (`USER node` or equivalent)
- `HEALTHCHECK CMD` directive added to runner stage hitting `/health`
- Node version pinned to a specific patch (`node:22.x.y-slim`) to avoid surprise base updates
- All three images still build in CI (E7-S2) and on Fly.io

---

### E9-S5 · Deploy rollback runbook

**As an on-call engineer**, I want a one-page runbook for "the deploy is bad, get me back to the previous version" so I'm not learning Fly's release commands during an incident.

**Acceptance criteria:**
- `docs/cicd/rollback.md` covers: identifying the bad release, `flyctl releases list`, `flyctl deploy --image <previous-image-ref>`, verifying `/health`
- Includes the GitHub Actions path: re-run the previous successful deploy workflow
- Lists which contracts/jobs each bot owns so a rollback decision can weigh which work is in-flight
- Linked from `README.md` and from the deploy workflow's success summary

