# JiffyApp (`@botguild/jiffyapp-bot`)

JiffyApp turns a one-paragraph brief into deployed software from a bounded ten-template catalog — landing page, calculator, form-to-email, CSV dashboard, embeddable widget, link-in-bio, pricing table, scored quiz, waitlist page, and text/data transformer — compiling the brief into golden input→output examples at proposal time that become the binding acceptance criteria the instant the proposal is accepted. Codegen (Workers AI Qwen2.5-Coder-32B) fills the matched template's declared slots, deploys to a staging slug in a Workers for Platforms dispatch namespace, and iterates through a capped self-repair loop until every golden example passes as a real Playwright/Browser Rendering assertion — screenshot-evidenced — before promotion to a durable `<slug>.jiffyapp.dev` URL that is live-gated again (HTTP 200, element contract, goldens re-run, PageSpeed/Lighthouse thresholds) and delivered with an evidence report, a public build-log page, and a full ejectable source ZIP. Recurring revenue compounds as a $5/mo hosting-and-edits repeat gig per delivered tool, and JiffyApp doubles as the landing-page leg of Foreman's $99 Launch Kit.

Full product spec: [`docs/prds/jiffyapp.md`](../../docs/prds/jiffyapp.md). Template catalog decision record (the ten templates, slots, element contracts, disambiguation rules): [`docs/prds/jiffyapp-templates.md`](../../docs/prds/jiffyapp-templates.md).

## Architecture

Two Workers. `jiffyapp-bot` is the marketplace bot (Hono fetch + Queue consumer + Cron Triggers); `jiffyapp-dispatch` (this repo's other new app — see its own README) is the thin `*.jiffyapp.dev` router. Generated tools run as user Workers inside a Workers for Platforms dispatch namespace — never inside the bot's own script.

```
                 BotGuild platform                Buyers' browsers
   webhooks (HMAC) │      ▲ REST/MCP                    │
                   ▼      │                             ▼
 ┌───────────────────────────────────┐   ┌──────────────────────────────┐
 │ jiffyapp-bot Worker               │   │ jiffyapp-dispatch Worker     │
 │  fetch: /webhook /health          │   │  *.jiffyapp.dev → D1 status  │
 │   /deliverables/:k/:f  /p/:jobKey │   │  → DISPATCH.get(slug)        │
 │   /relay/:toolId (signed, capped) │   │  suspended → 410 + eject note│
 │  scheduled: */15 poll·negotiate·  │   └──────┬───────────────────────┘
 │   threads·parked · daily expiry   │          │ dispatch namespace
 │  queue: jiffyapp-jobs consumer    │          ▼
 │   moderate→codegen→stage→assert→ │   [ user Workers: one per tool,
 │   repair→promote→live gates→pack │     staging + final slugs ]
 └──┬────┬────┬────┬────┬────┬──────┘          ▲
    ▼    ▼    ▼    ▼    ▼    ▼                 │ scripts PUT via
   D1   KV   R2  Workers Browser  Cloudflare API (scoped token)
 (state)(dedupe)(evidence) AI  Rendering   + PSI API · Email Service
                        (Qwen) (Playwright)  · Anthropic (Haiku) · OpenAI Mod.
```

The marketplace loop (client, scorer, proposer, negotiation, registration) is reused verbatim from [`@botguild/agent-core`](../../packages/agent-core); the Workers adapters (webhook app, cron poll sweep, D1-backed secret/negotiation stores, ownership self-filter) come from [`@botguild/agent-core-workers`](../../packages/agent-core-workers), proven live by VoiceWright. This app owns the ten-template catalog, the golden-example compiler, the build/repair/promote pipeline, the form relay, the hosting lifecycle, and the D1 schema.

## Local development

```bash
# from the repo root
pnpm install
pnpm --filter @botguild/jiffyapp-bot build       # tsc
pnpm --filter @botguild/jiffyapp-bot typecheck   # tsc --noEmit
pnpm --filter @botguild/jiffyapp-bot test        # node:test via tsx — no live API calls
pnpm --filter @botguild/jiffyapp-bot lint        # eslint --max-warnings=0

# verify the Worker bundle builds (bindings + config are deploy-shaped)
cd apps/jiffyapp-bot && pnpm exec wrangler deploy --dry-run --outdir=/tmp/jiffyapp-bundle

cp .dev.vars.example .dev.vars   # then fill in the values
pnpm --filter @botguild/jiffyapp-bot dev          # wrangler dev
```

`src/playwrightDriver.ts` is deliberately excluded from local unit tests (nothing in `pnpm test` exercises it) — see the calibration section below for why that file needs a different kind of net.

## Phase 0 — preconditions checklist (ops; blocks *listing*, not building)

None of this blocks writing code — the bot builds and its tests pass with none of it done. It blocks going live: winning a real gig, staging a real tool, and sending a real email. Each item's exit criterion is **one successful test call against the real dependency**, never a mocked check.

- [ ] **Register `jiffyapp.dev`** — the zone must exist on the Cloudflare account with wildcard DNS + TLS active for `*.jiffyapp.dev` before `jiffyapp-dispatch` can route anything. Availability rots; do this first.
- [ ] **Activate Workers for Platforms** ($25/mo) and create the dispatch namespace: `wrangler dispatch-namespace create jiffyapp-tools`. Exit: a hand-written script `PUT` via the Cloudflare API serves on a test slug.
- [ ] **Issue `CF_API_TOKEN`** scoped to **dispatch-namespace Workers Scripts edit ONLY** — never account-wide. Blast-radius note: a leaked token can only deploy/delete scripts inside the `jiffyapp-tools` namespace, not touch any other Worker, zone, or account resource (PRD §12).
- [ ] **Issue a second token, `CF_EMAIL_API_TOKEN`**, scoped to **Email Routing destination addresses ONLY**. This is load-bearing, not optional: the relay (`src/relay.ts`'s `createEmailRoutingClient`) registers each buyer's `notifyEmail` as a Cloudflare destination address at runtime via `ensureDestination`, and Cloudflare then sends **its own** verification email to that address — the `send_email` binding physically cannot deliver to an unverified destination. A form-template tool is never promoted until **both** confirmations exist: JiffyApp's own opt-in link (`GET /relay/verify/:verifyToken`, built in `buildVerificationEmail`) *and* Cloudflare's destination-address verification (`isDestinationVerified`).
- [ ] **PSI API key** (PageSpeed Insights / Lighthouse). Exit: one PSI call against any public URL returns performance + accessibility scores.
- [ ] **Email Service sender domain** — configure SPF/DKIM for the domain behind `RELAY_FROM_ADDRESS` (`relay@jiffyapp.dev` is the wrangler.jsonc placeholder — replace it) so outbound relay mail doesn't land in spam.
- [ ] **End-to-end relay rehearsal in staging** before the first form-template gig is bid on: register a test recipient, confirm **both** verification emails arrive (JiffyApp's opt-in link and Cloudflare's destination verification), then drive one test submission through `/relay/:toolId` and confirm it delivers with a `message-id`.
- [ ] **BotGuild handler API key** with scopes `read`, `proposals:write`, `bots:write` (CLAUDE.md convention) — verify by one `listGigs` call.
- [ ] **Verify `CODEGEN_MODEL_ID`** (`@cf/qwen/qwen2.5-coder-32b-instruct`, `src/config.ts`) is present in the account's *live* Workers AI model catalog with one real inference call, and decide whether to populate `CODEGEN_FALLBACK_MODEL_ID`. It ships as `''`, which means **Qwen-only** — the fallback-engagement branch in `src/codegen.ts` is already live code, just dark until a real fallback model id is set here.

## Deploy runbook (order matters)

1. **Create D1:** `wrangler d1 create jiffyapp` → paste the returned `database_id` into **both** `apps/jiffyapp-bot/wrangler.jsonc` and `apps/jiffyapp-dispatch/wrangler.jsonc` (same database; the dispatcher only reads `tools.status`).
2. **Create the other bindings:**
   ```bash
   cd apps/jiffyapp-bot
   wrangler kv namespace create CACHE                   # → paste id into wrangler.jsonc
   wrangler r2 bucket create jiffyapp-deliverables
   wrangler queues create jiffyapp-jobs
   wrangler queues create jiffyapp-jobs-dlq
   ```
3. **Apply the schema:** `wrangler d1 migrations apply jiffyapp --remote` (applies `migrations/0001_init.sql` — jobs, `gig_briefs`, `tools`, `hosting_cycles`, `edit_requests`, `usage_counters`, `relay`, `relay_events`, `build_log`, `gate_audit`, `abuse_reports`, `dlq_events`, `reputation_snapshot`, plus the shim's own `webhook_secret`/`negotiation_countered` tables).
4. **Deploy `jiffyapp-dispatch` FIRST:** `cd apps/jiffyapp-dispatch && wrangler deploy`. The wildcard route (`*.jiffyapp.dev/*`) has to exist before the bot's first staged tool tries to serve.
5. **Set secrets on `jiffyapp-bot`** (see `.dev.vars.example` for the full list) via `wrangler secret put <NAME>`, one call per name:
   ```bash
   cd apps/jiffyapp-bot
   wrangler secret put BOTGUILD_API_URL
   wrangler secret put BOTGUILD_API_KEY
   wrangler secret put BOTGUILD_BOT_ID
   wrangler secret put ANTHROPIC_API_KEY
   wrangler secret put MODERATION_API_KEY
   wrangler secret put CF_API_TOKEN        # dispatch-namespace script edit ONLY
   wrangler secret put CF_EMAIL_API_TOKEN  # Email Routing addresses ONLY
   wrangler secret put PSI_API_KEY
   wrangler secret put ADMIN_TOKEN
   ```
   Before deploying, also fill in the `⚠️ REPLACE` plain `vars` in `wrangler.jsonc`: `WEBHOOK_BASE_URL`, `CF_ACCOUNT_ID`, `RELAY_FROM_ADDRESS`.
6. **Deploy `jiffyapp-bot`:** `wrangler deploy`.
7. **Register:**
   ```bash
   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<WEBHOOK_BASE_URL>/admin/register
   ```
   This registers the bot profile + the 7 lifecycle webhooks and persists the platform-issued signing secret to D1 with a read-back check. **Note:** the platform webhook signing secret is *never* a `wrangler secret` — a Worker cannot write its own deploy-time secrets — it's runtime-captured from the registration response and stored in the `webhook_secret` D1 table (the `*/15` cron also runs a first-run registration backstop if it's still missing).
8. **Verify:**
   ```bash
   curl https://<WEBHOOK_BASE_URL>/health          # → { status: 'ok', botId, tools, dlqDepth, ... }
   ```
   and confirm one real HMAC'd platform webhook reaches `POST /botguild/webhook` and passes signature verification (e.g. by observing the next real `proposal.accepted`/`milestone.funded` event, or replaying a captured one).

## Phase 2 — calibration loop

Once both Workers are deployed and secrets are set, run the live reference check for every template before any gig is listed:

```bash
for t in landing calculator form csv-dashboard widget link-in-bio pricing-table quiz waitlist transformer; do
  curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<WEBHOOK_BASE_URL>/admin/reference/$t
done
```

Each call (`runReferenceCheck` in `src/adminReference.ts`) renders that template's reference slots, stages it to a fixed `stg-ref-<templateId>` slug, runs its full golden suite against the *real* Browser Rendering binding, fetches PSI on the clean staging URL, tears the staging script down, and returns the full JSON: per-assertion outcomes, PSI performance/accessibility scores, and per-phase timings (`renderMs`, `deployMs`, `assertMs`, `psiMs`).

- **Record** the PSI scores, assertion latencies, and Browser Rendering timings for all ten templates.
- **Freeze** `PSI_PERFORMANCE_MIN` / `PSI_ACCESSIBILITY_MIN` and `ASSERTION_TIMEOUT_MS` (`src/config.ts` — currently the provisional defaults of 90/90 and 5,000 ms) into both `config.ts` and the gig terms once real numbers are in hand.
- **Templates scoring below the 95/95 reference bar** (the margin PRD §9 wants above the ≥90 contractual gate) get **fixed** — prompt/slot tuning on the template — **never a softened gate**.
- **Relay-family templates run a reduced golden set.** `form`, `waitlist`, and `quiz` POST their `?jiffytest=1` reference submission to `/relay/ref-<templateId>`, which 404s (there is no real relay row for a reference tool) — so the success-submission goldens can never legitimately pass and are filtered out before the run. The response's `goldensFiltered` count records how many were dropped; the load-only golden (`success-msg` stays hidden) and the client-side error-path golden are kept and must still pass.

**Critical warning:** `tsc` provides **ZERO type safety** inside `src/playwrightDriver.ts` — the entire `@cloudflare/playwright` surface resolves to `any` under this workspace's `NodeNext` module resolution (its `.d.ts` files use extension-less relative specifiers `tsc` can't follow). This file is not exercised by `pnpm test`. **The live reference checks above are the only net that file has** — run them after any change to `playwrightDriver.ts`, not just at Phase 2.

## DLQ runbook

Jobs on the `jiffyapp-jobs` queue that exhaust `max_retries: 3` land on `jiffyapp-jobs-dlq` (see `wrangler.jsonc`). The queue consumer's `-dlq` branch (`src/index.ts`) logs an operator alert (`DEAD-LETTERED JOB — operator action required`) and calls `recordDlqEvent`, which inserts a row into the `dlq_events` D1 table (`queue`, `body_json`, `created_at`); the aggregate count surfaces as `dlqDepth` on `GET /health`.

**Messages never auto-replay.**

1. Inspect the arrivals:
   ```bash
   wrangler d1 execute jiffyapp --remote --command "SELECT id, queue, body_json, created_at FROM dlq_events ORDER BY id DESC LIMIT 20"
   ```
2. Re-send the JSON body to `jiffyapp-jobs`, either with `wrangler queues producer send jiffyapp-jobs '<body_json>'` or a curl to a future admin route.
3. Replay is safe because of the claims + checkpoints already in place: every job carries its D1 idempotency claim (`job_key = sha256(contractId) + ':' + stage`) plus a `checkpoint_json`/`spent_usd`/`repair_rounds` checkpoint (the banked-round and staged short-circuits). A resumed job skips whatever it already finished — an already-staged build, already-passed goldens — and never re-spends past its caps or double-delivers.

## Vendored & pinned dependencies

| Package | Version | License | Where |
| --- | --- | --- | --- |
| papaparse | `5.5.3` (exact) | MIT | `src/templates/vendor/papaparse.ts` — vendored as a generated string export, served from a tool's own `/vendor/papaparse.js` under `script-src 'self'`. No runtime fetch, no CDN. |
| chart.js | `4.5.1` (exact) | MIT | `src/templates/vendor/chartjs.ts` — same vendoring pattern, served as `/vendor/chart.js`. |
| `@cloudflare/playwright` | `1.3.0` (exact) | Apache-2.0 | Real (non-vendored) devDependency; browser-automation surface for `src/playwrightDriver.ts` and the Phase-2 reference checks. |

Both `csvDashboard.ts` slots import `PAPAPARSE_JS`/`CHARTJS_JS` directly from the vendor modules — there is no npm install or bundler step at job time (PRD §7's no-build-by-design decision); the strings are baked into the bot's own build.

**Why exact-pinned, not a caret range:** papaparse/chart.js are embedded byte-for-byte, so a floating range would silently change what ships to every future tool without a corresponding template re-certification. `@cloudflare/playwright` is exact-pinned per the fleet's playwright-pairing lesson — a minor/patch bump can silently change locator/selector semantics against the live Browser Rendering binding, and `tsc` can't catch a regression here (see the calibration section above). Bumping any of the three is a deliberate act, never an automatic one.

**Regenerating `papaparse.ts` / `chartjs.ts` after a version bump:**

```bash
# 1. bump the pinned version
pnpm add -D -E papaparse@<version> chart.js@<version>

# 2. regenerate the vendor string module (repeat per package)
node -e "
const fs = require('fs');
const version = require('papaparse/package.json').version;
const src = fs.readFileSync(require.resolve('papaparse/papaparse.min.js'), 'utf8');
fs.writeFileSync('apps/jiffyapp-bot/src/templates/vendor/papaparse.ts',
  '// Papa Parse v' + version + ' — MIT License (c) Matt Holt. Vendored, pinned, license-audited (PRD §12).\n' +
  '// Regenerate: see apps/jiffyapp-bot README vendored-deps section (Task 24).\n' +
  'export const PAPAPARSE_VERSION = ' + JSON.stringify(version) + ';\n' +
  'export const PAPAPARSE_JS: string = ' + JSON.stringify(src) + ';\n');
"

node -e "
const fs = require('fs');
const version = require('chart.js/package.json').version;
const src = fs.readFileSync(require.resolve('chart.js/dist/chart.umd.min.js'), 'utf8');
fs.writeFileSync('apps/jiffyapp-bot/src/templates/vendor/chartjs.ts',
  '// Chart.js v' + version + ' — MIT License (c) Chart.js Contributors. Vendored, pinned, license-audited (PRD §12).\n' +
  '// Regenerate: see apps/jiffyapp-bot README vendored-deps section (Task 24).\n' +
  'export const CHARTJS_VERSION = ' + JSON.stringify(version) + ';\n' +
  'export const CHARTJS_JS: string = ' + JSON.stringify(src) + ';\n');
"
```

Re-run the CSV-dashboard template's tests and its Phase-2 reference check after regenerating either file — the vendored source is part of that template's element contract.

## Ops policies

**Slug abuse (kill switch).** `POST /admin/suspend/:slug` (Bearer `$ADMIN_TOKEN`) flips a tool to `killed` immediately — no deploy action needed, since `jiffyapp-dispatch` reads `tools.status` on every request and serves the 410 page the instant the flip lands. `POST /admin/unsuspend/:slug` reverses it, but only from `killed` (a `409` otherwise, so it can never resurrect a `grace`/`suspended` tool and bypass the normal hosting lifecycle). Both are logged to `gate_audit` under `gate: 'kill-switch'`.

**Hosting terms wording.** The build price includes the tool's first 30 days of hosting. After that, hosting is a $5/mo **re-funded monthly repeat gig** — a new gig/contract each cycle, joined to the existing tool via a `toolId: <id>` line in the gig description (there are no subscriptions on the platform). On lapse, a 7-day grace period keeps the tool serving (with an in-thread nudge); after grace with no re-fund, the tool is `suspended` and the dispatcher serves the 410 + eject-note page. A newly funded hosting contract — even against a `suspended` tool — revives it back to `live`.

**Edit-request convention.** Buyers request changes by posting a thread message starting with `edit:` (case-insensitive, e.g. `edit: change the CTA text to "Book a call"`; parsed by `parseEditInstruction` in `src/edits.ts`). Up to 3 edits are included per funded hosting cycle (`EDITS_PER_CYCLE`), and the quota is keyed to the *funded cycle's contract id*, never a calendar month — a 30-day window straddling a month boundary never grants a second batch. A 4th request in the same cycle is **held**, never silently served, with a single reply prompting a top-up gig or a wait for the next cycle.

**Seed-gig listing.** Gigs are posted through the platform dashboard or the MCP `post_gig` tool, not through this bot. The gig description embeds a fenced ```` ```json ```` brief per PRD §8's schema (`template`, `name`, `description`, `copy`, `logic`, etc. for a build gig; `{"toolId": "…"}` for a hosting-cycle renewal) — the scorer and proposer parse that fence at discovery time.

**KPI queries.**

- *Off-catalog skip rate* — every gig the scorer would have bid on (`shouldPropose`) but that got skipped as off-catalog, brief-less, or incomplete is recorded to `gate_audit` (`src/sweeps.ts`'s `maybePropose`):
  ```sql
  SELECT result, COUNT(*) AS n
  FROM gate_audit
  WHERE gate = 'off-catalog-skip'
  GROUP BY result;
  ```
  (`result` is one of `off-catalog`, `no-brief`, or an `incomplete-brief*` reason; an explicitly-wrong `brief.template` value is buyer error, not catalog demand, and is deliberately never counted here.)
- *First-pass convergence* — the distribution of repair rounds needed on delivered builds:
  ```sql
  SELECT repair_rounds, COUNT(*) AS n
  FROM jobs
  WHERE outcome = 'delivered'
  GROUP BY repair_rounds;
  ```
  (`repair_rounds = 0` is a first-pass pass; PRD §15 targets ≥70% at zero rounds and ≥95% within the 3-round cap, per template.)
