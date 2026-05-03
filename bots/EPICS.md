# BotGuild Agents — Epics & Stories

**Version:** 1.0  
**Date:** 2026-05-03

---

## Epic Overview

| # | Epic | Bots | Outcome |
|---|------|------|---------|
| E1 | Agent Core Foundation | All | Shared library; any bot can discover gigs, propose, deliver, handle webhooks |
| E2 | SentinelBot — Monitoring Agent | SentinelBot | Live monitoring bot accepting gigs and running scheduled watch jobs |
| E3 | FlowBot — Data Transform Agent | FlowBot | Live ETL bot accepting gigs and delivering clean structured data |
| E4 | VerifierBot — QA Agent | VerifierBot | Live QA bot accepting gigs and delivering pass/fail reports |
| E5 | Standing Offers & Subscriptions | All | All three bots publish and service standing offers |
| E6 | Infra, Deployment & Observability | All | All three bots deployed on Fly.io, monitored, secrets managed |

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

### E2-S7 · Standing offer subscription handler

**As SentinelBot**, I need to handle subscription events for my standing offers so that new subscribers get their monitoring jobs set up automatically.

**Acceptance criteria:**
- Handles `subscription.activated` webhook event
- Creates a watch job from the subscription's configured parameters
- Sends a "Subscription started" thread message with job summary
- Handles `subscription.cancelled` → stops and removes the watch job
- Handles `subscription.paused` → pauses the cron job (does not delete config)
- Handles `subscription.resumed` → resumes the cron job

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

## E5 · Standing Offers & Subscriptions

**Goal:** All three bots have published standing offers on BotGuild and can service them — recurring jobs for subscribers.

---

### E5-S1 · SentinelBot standing offer: Daily Site Watch

**Acceptance criteria:**
- Offer published: flat-monthly pricing, 7-day trial, 15-min alert SLO
- Subscription activation sets up a once-daily page diff job for subscriber's configured URLs
- Alert fires within 15 minutes of detected change (event-driven, not scheduled)
- Monthly "no changes detected" summary sent if nothing changed all month

---

### E5-S2 · SentinelBot standing offer: API Health Monitor

**Acceptance criteria:**
- Offer published: flat-monthly pricing, checks every 15 minutes, Slack/Telegram alert on failure
- Subscription activation configures health check cron for subscriber's endpoints
- Downtime alert sent to payer's preferred channel
- Weekly uptime summary report delivered as a thread message

---

### E5-S3 · FlowBot standing offer: Daily Data Sync

**Acceptance criteria:**
- Offer published: flat-monthly pricing, daily schedule, up to 3 data sources per subscription
- Subscription activation configures a daily cron job with subscriber's source + destination config
- On each run: fetches, normalizes, delivers output file to agreed destination (email, upload, or webhook)
- Monthly usage summary sent (rows processed, any errors)

---

### E5-S4 · FlowBot standing offer: Invoice Processing Lane

**Acceptance criteria:**
- Offer published: per-use pricing (price per invoice document)
- Subscriber sends invoice URLs or email attachments (via thread message)
- FlowBot processes each batch within 4 hours, delivers structured CSV
- Monthly invoice with total documents processed and total cost

---

### E5-S5 · VerifierBot standing offer: Nightly Smoke Test

**Acceptance criteria:**
- Offer published: flat-monthly pricing, runs nightly at 2am UTC
- Subscription activation configures check suite for subscriber's endpoints/URLs
- Nightly report delivered via thread message: pass/fail per check, any regressions vs. prior night
- Immediate alert on critical failure (< 15 min from run completion)

---

### E5-S6 · VerifierBot standing offer: Acceptance Review Pack

**Acceptance criteria:**
- Offer published: per-use pricing (price per deliverable reviewed)
- Subscriber submits deliverable + criteria via thread message
- VerifierBot runs full check suite and delivers report within 4 hours
- Report delivered to thread, not as a formal contract milestone (single-shot, lightweight)

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
