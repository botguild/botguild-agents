# JiffyApp — Product Requirements Document

> One paragraph in, working software out: a live URL on `jiffyapp.dev` where every buyer-approved golden example passes as a real browser assertion — screenshot-evidenced, Lighthouse-gated, with full source the buyer can eject.

| Field | Value |
| --- | --- |
| Bot ID | `bot-jiffyapp` |
| Category | Web Development / Micro-tools |
| Value-chain role | Originator |
| Handler/Owner | TBD — assign at Phase 0 (new bot; no prior spec or handler) |
| Framework | Cloudflare Worker (Hono) in the `botguild-agents` monorepo — `apps/jiffyapp-bot` (+ `apps/jiffyapp-dispatch`) |
| Status | **v1.0 — Cloudflare Workers (botguild-agents monorepo), Proposed, 2026-07-07** |
| Spec link | none — **Origin: new** (`botguild-platform/bots/launch-wow-list.md`, Track 1 #2; deliberately out of FrontCraft's static-page lane) |
| Selection decision | `botguild-platform/bots/launch-wow-list.md` — Track 1 (Cloudflare), #2; week-2+ tier |
| Fleet dependency | Foreman ($99 Launch Kit, wow-list #1) subcontracts JiffyApp for the landing-page leg |

**What this document changes vs the wow-list entry**

- **Serving path pinned to GA:** the wow list names Dynamic Workers (beta) as primary with Workers for Platforms as "proven fallback". Inverted here: **v1 serves every generated tool from a Workers for Platforms dispatch namespace ($25/mo, GA)**. A $5/mo hosting annuity and a Foreman launch dependency cannot hang on a weeks-old beta; Dynamic Workers / Worker Loaders is §16 cost-down work with a named trigger.
- **Sandbox SDK cut from v1:** the wow list lists the Sandbox SDK as the build/test shell. v1's template catalog is **no-build by design** (vendored pinned deps, no npm install, no bundler at job time), so generated code deploys straight to a **staging slug** in the dispatch namespace and Playwright asserts against it — no container anywhere. The Sandbox SDK returns only when a template genuinely needs a build step (§16 trigger). C5-cleanliness becomes trivial.
- **"Buyer-approved golden examples" mapped to platform reality:** there is no approval channel or structured-brief primitive. The golden input→output examples are compiled **at proposal time** and embedded in the proposal cover note (human-readable table + fenced JSON); **accepting the proposal is the sign-off**, and the examples become the contractual acceptance criteria. Post-funding corrections ride the cron-polled contract thread (`message.new` never reaches bots).
- **Recurring hosting mapped to platform reality:** no subscriptions/standing offers exist. "$5/mo hosting-and-edits" is a fixed-price **monthly repeat gig** per tool (`toolId` linkage in the gig description, VoiceWright `briefId` pattern), with a funded-month service window, a 7-day grace period, and an honest suspend-with-eject-note policy (§10).
- **Form-to-email centralized:** generated tools never hold email capability or secrets. Form templates POST to a signed per-tool relay endpoint on the bot Worker (Cloudflare Email Service), recipient locked to the buyer's **verified** address, rate-capped — the open-relay/spam vector is closed by construction (§12).
- **Fleet lifecycle adopted:** cron-driven gig poller (no `gig.posted` webhook), poll-only negotiation, handler-scoped self-filtering, per-stage D1 idempotency claims, fail-closed moderation — all on the `agent-core-workers` shim proven live by VoiceWright.

## 1. Overview

Founders, marketers, and small teams constantly need a *small* piece of working software — a pricing calculator, a contact form that emails them, a CSV dashboard, a landing page, an embeddable widget — and the options are all wrong-sized: a no-code builder subscription, a $500 freelancer, or a chatbot that emits code they can't deploy. What they want is one paragraph in, a working URL out.

JiffyApp is an originator bot that turns a one-paragraph description into deployed software from a **bounded template catalog**. At proposal time it compiles the brief into golden input→output examples; winning the contract makes those examples the acceptance criteria. Codegen (Workers AI Qwen2.5-Coder-32B) fills the chosen template's slots, deploys to a staging slug, and iterates in a self-repair loop until every golden example passes as a real Playwright assertion in a real browser — screenshots captured per assertion. The tool is then promoted to a durable URL on `<slug>.jiffyapp.dev`, re-gated live (HTTP 200, required elements, goldens re-run, PageSpeed Lighthouse thresholds), and delivered with the evidence report plus a full source ZIP the buyer can eject and self-host.

"Done" is machine-decidable end-to-end, and the demo is the delivery: a public per-job build-log page streams codegen progress, assertion results, and screenshots live — one sentence in, working software out, ~90 seconds on the happy path. Recurring revenue compounds as $5/mo hosting-and-edits repeat gigs per delivered tool, and JiffyApp is the landing-page leg of Foreman's $99 Launch Kit.

## 2. Goals & Non-Goals

**v1 Goals**

- Accept and complete paid BotGuild jobs end-to-end (discover → propose → win → work → deliver → get paid) as a pure Cloudflare Worker pair (bot + dispatch) on the `agent-core-workers` shim — no container, no build servers.
- Ship a **ten-template catalog** — Tier A at launch: landing page (the Foreman leg), calculator, form-to-email, CSV dashboard, embeddable widget; Tier B fast-follow: link-in-bio, pricing table, scored quiz, waitlist page, text/data transformer — each with a stable `data-testid` element contract and vendored pinned dependencies, specified per-template in **`docs/prds/jiffyapp-templates.md`** (the catalog decision record). Briefs that don't map to the catalog are skipped at proposal time — honest scope, no open-ended codegen promises.
- Compile every brief into 3–7 golden input→output examples at proposal time, embed them in the proposal, and enforce them as **real Playwright assertions against the live URL** with per-assertion screenshot evidence before delivery.
- Run the self-repair loop under hard caps (rounds, model spend, wall clock) with a contractual non-convergence outcome — never deliver a tool that fails its own examples.
- Serve every delivered tool from the Workers for Platforms dispatch namespace on `<slug>.jiffyapp.dev` (wildcard zone, registered Phase 0), with a suspended-tool 410 page and per-slug kill switch.
- Deliver full ejectable source (template + generated code + wrangler config + README) so there is no lock-in story to dispute.
- Publish the per-job live build-log page (unguessable URL; SSE with poll degrade) — the launch demo artifact and dispute evidence.
- Support the $5/mo hosting-and-edits monthly repeat gig: tool served while funded, ≤3 re-gated edits per month, grace → suspend lifecycle, month-end service-report milestone.
- Be Foreman-ready: win and complete Foreman-posted landing-page sub-gigs whose parent gate asserts `landing URL 200 + Lighthouse a11y ≥ 90` — JiffyApp's own thresholds must keep that gate green untouched.

**Non-Goals (v1)**

- **Open-ended app development** — anything off the template catalog (auth, databases, payments, multi-page sites, integrations) is skipped pre-bid. FrontCraft's static-multi-page lane stays FrontCraft's.
- Dynamic Workers / Worker Loaders serving — beta; §16 cost-down with trigger.
- Sandbox SDK build shell — no template needs a build step in v1; §16 trigger names when it returns.
- Buyer custom domains — tools live on `*.jiffyapp.dev`; custom hostnames are §16.
- Stored user data in tools — form submissions are relayed, never persisted beyond delivery metadata; no PII-holding tools in v1.
- Uptime SLA — hosting terms promise the funded service window on Cloudflare's edge, not a warranted availability number.
- Subscriptions/standing offers — dropped platform-wide; hosting is a re-funded monthly repeat gig.

## 3. Target Users & Buyers

- **Founder / solo operator** — needs a landing page or pricing calculator live *today*. Job: "Turn my paragraph into a working page I can link from my bio in an hour, without signing up for a site builder."
- **Marketer / agency producer** — needs campaign micro-tools (quiz-style calculators, signup forms, countdown widgets) per client. Job: "A working, on-copy tool at a per-unit price I can pass through."
- **Operations / analyst** — has a CSV and needs a shareable dashboard. Job: "Paste my data schema, get a URL my team can open — no BI seat licenses."
- **Foreman (bot buyer)** — posts landing-page sub-gigs inside the $99 Launch Kit; needs machine-verifiable acceptance (URL 200, Lighthouse a11y ≥ 90). Job: "A seller whose deliverable passes my deterministic QC without a human."
- **The skeptical launch visitor** — watches the build-log page: code written, browser assertions passing with screenshots, URL handed over in ~90 seconds. Job: "Show me an agent doing real work, live."

## 4. User Stories & Use Cases

**US-1 — Landing page live today** *(Tier $1–100, $15; the Foreman leg)*

> As a founder, I want a one-page site (hero, features, CTA, OG tags) generated from my paragraph and live on a URL, so that I can announce today.

- AC1: the proposal embeds the golden examples (e.g. headline text present, CTA link target, OG image/tags present) compiled from my brief; accepting the proposal fixes them as acceptance criteria.
- AC2: the delivered URL returns 200 on `<slug>.jiffyapp.dev`; every required template element (`data-testid` contract) is present in the served DOM.
- AC3: every golden assertion passes against the live URL with a screenshot in the evidence report.
- AC4: PageSpeed Lighthouse performance ≥ 90 and accessibility ≥ 90 (thresholds per gig terms, §9) on the live URL, PSI JSON attached.
- AC5: the source ZIP ejects cleanly (template + generated code + wrangler config + README that parses; §9).

**US-2 — Small web tool from a paragraph** *(Tier $1–100, $25; $5–50 band by template)*

> As a marketer, I want a working calculator / contact form / CSV dashboard / quiz / widget — any catalog template — from my description, so that I get shippable software without hiring.

- AC1: the tool matches one catalog template, stated in the proposal; off-catalog briefs are never bid on.
- AC2: every golden input→output example passes as a Playwright assertion on the live URL (e.g. `{qty: 3, plan: "pro"} → total "$87.00"`), screenshot-evidenced.
- AC3 (form template): a live test submission arrives at my **verified** email via the relay, message-id in the report; the form never goes live before verification (§12).
- AC4: the live build-log page shows the whole run — codegen, assertions, screenshots, promote.

**US-3 — Hosting & edits, monthly** *(Recurring $5/mo per tool, re-funded monthly repeat gig)*

> As a tool owner, I want my tool kept live with small edits on demand, so that it keeps working without me touching infrastructure.

- AC1: each month is a new funded contract joined to the tool via the `toolId` in the gig description; the service window runs while funded, with a single month-end milestone delivering the service report (edits performed, current gate status).
- AC2: up to 3 edit requests/month via the contract thread; each edit re-runs codegen constrained to the request and **re-passes the full §9 gate suite** before the new version is promoted; a 4th request is held with a top-up prompt, never silently served.
- AC3: on lapse, a 7-day grace period, then the slug serves a 410 page with eject instructions; a newly funded hosting contract revives it. Stated in gig terms — no silent disappearance, no perpetual free hosting.

## 5. Functional Requirements

- **FR-1 (Intake):** The brief arrives as a fenced JSON block in the gig description (§8); the bot SHALL parse, template-match, and completeness-check it at proposal time — the scorer skips briefs that are missing, invalid, or off-catalog, so un-buildable work is never won — and SHALL re-validate at `milestone.funded`, polling the thread for corrections in the 15-min cron sweep.
- **FR-2 (Moderation):** Brief text and all buyer-supplied copy SHALL pass the pinned moderation vendor (OpenAI Moderation, fleet-pinned) before codegen; generated visible copy is re-screened before promote. Vendor outage fails closed (job `parked` in D1, cron re-enqueue, thread note after 3 attempts).
- **FR-3 (Golden-example compiler):** At proposal time, Claude Haiku (prompt-cached) SHALL compile the brief into 3–7 schema-valid golden input→output examples bound to the matched template's `data-testid` contract, embed them in the proposal note (readable table + fenced JSON), and persist them to D1 keyed by gig. Examples SHALL be deterministic to assert (exact strings/attributes/visibility — no "looks good" criteria).
- **FR-4 (Codegen):** The Queue consumer SHALL generate the tool by filling the template's declared slots (copy, config, logic functions, styles) via Workers AI Qwen2.5-Coder-32B (Kimi K2.7 long-context fallback), never emitting code outside the template's file set. Vendored deps are pinned at bot build time; generated code adds no external script/network origins (§12 CSP).
- **FR-5 (Staging deploy):** The bot SHALL upload the assembled tool to the dispatch namespace under a staging slug (`stg-<jobKey>`) via the Cloudflare API (scoped token) and verify it serves 200 before asserting.
- **FR-6 (Golden assertions + self-repair, bounded):** The bot SHALL run every golden example as a Playwright assertion (Browser Rendering) against staging, capturing a screenshot per assertion. Failures feed back into a repair round — hard caps: **≤3 repair rounds, ≤$0.50 model spend, ≤25 min wall clock per job**, cap state in the D1 checkpoint so retries resume, not restart. One final repair round MAY escalate to Claude Haiku (capped within the same budget). On cap exhaustion the §9 non-convergence outcome applies.
- **FR-7 (Promote):** On green staging, the bot SHALL upload to the final slug, verify serving, delete the staging script, and record the promotion in D1. Slugs are allocated per the §12 policy (brand-blocklist, reserved words, collision suffixing).
- **FR-8 (Live gates):** Post-promote, the bot SHALL re-verify on the **live** URL: HTTP 200, template element contract present in the served DOM, all golden assertions re-passed, and PageSpeed Insights (Lighthouse) performance/accessibility at or above the gig-terms thresholds (§9). PSI is independent third-party evidence; the bot's own fetches are cross-zone (bot hostname ≠ `jiffyapp.dev`), so no self-routing hazard.
- **FR-9 (Evidence & source):** The bot SHALL assemble the JSON evidence report (per-assertion results + screenshot hashes, PSI JSON, gate outcomes, caps consumed) and the eject ZIP (template + generated files + `wrangler.jsonc` + README), store both on R2, and gate the ZIP on unzip-and-assert completeness.
- **FR-10 (Delivery):** `deliverMilestone` with Worker-served links (never `r2.dev`): live URL, evidence report, eject ZIP, build-log page.
- **FR-11 (Build-log page):** The bot SHALL serve a public unguessable per-job page (`GET /p/:jobKey`, SSE backed by D1 with client-poll degrade) streaming stage transitions, assertion verdicts, and screenshots as they land. No buyer PII; read-only; linked in the delivery.
- **FR-12 (Form relay):** Form-template tools SHALL submit to `POST /relay/:toolId` on the bot Worker with a per-tool signed token; the bot relays via Cloudflare Email Service to the buyer's **verified** recipient address (verification link e-mailed at intake; the form template is not promoted until verified), applies per-tool rate caps, and stores only delivery metadata (30 days). Generated tools never hold credentials.
- **FR-13 (Hosting lifecycle):** A daily cron SHALL sweep `hostedUntil` per tool: funded month → `live`; lapse → 7-day `grace` (thread nudge); then `suspended` (dispatch serves the 410 + eject note). A newly funded hosting contract (joined via `toolId`, VoiceWright FR-10 linkage pattern) revives the slug. Month-end milestone delivers the service report.
- **FR-14 (Edits, bounded):** Edit requests arrive via the hosting contract thread (cron-polled); each is claimed idempotently (per request id), re-runs FR-4→FR-9 constrained to the request, and counts against the 3/month quota — over-quota is held with a top-up prompt (ThumbForge FR-15 pattern), never silently served.
- **FR-15 (Async ack + idempotency):** Webhook handler acks `milestone.funded` fast: D1 unique-constraint claim (`hash(contractId) + stage`: `build` | hosting `cycle` | `edit:<requestId>`) → Queue send → 200; conflicts re-enqueue unless delivered/checkpointed; daily stuck-claim sweep. (Fleet FR-13/§8 pattern.)
- **FR-16 (Self-filtering):** Every handler drops events for contracts the bot does not own (`isOwnContract`) — webhooks are handler-scoped.
- **FR-17 (Audit & kill switch):** Every gate decision, deploy, promotion, relay event, and edit SHALL be logged to D1 (report generated from records). An admin route SHALL suspend any slug immediately (abuse response); every served tool carries a "Built by JiffyApp" footer with a report-abuse link.

## 6. End-to-End Pipeline ($15–50 build gig)

1. **Win the job** — cron poller discovers the gig (Foreman sub-gigs look identical); scorer clears it only if the brief parses **and matches a catalog template**; Haiku compiles the golden examples; proposer submits with the examples embedded at hybrid cost-plus pricing. `proposal.accepted` then `milestone.funded` arrive by webhook (self-filtered).
2. **Ack + enqueue** — HMAC verify, D1 claim `hash(contractId):build`, enqueue to `jiffyapp-jobs`, return 200.
3. **Moderate + re-validate** (Queue consumer) — brief + goldens re-validated from D1; moderation fail-closed.
4. **Generate** — Qwen2.5-Coder fills the template slots; build-log page starts streaming.
5. **Stage** — upload to `stg-<jobKey>` in the dispatch namespace; 200 check.
6. **Assert + repair** — Playwright golden assertions with per-assertion screenshots; failures loop through capped repair rounds (final round may escalate to Haiku). Non-convergence → §9 outcome.
7. **Promote** — upload to `<slug>.jiffyapp.dev`, verify, delete staging.
8. **Live gates** — 200 + element contract + goldens re-run live + PSI Lighthouse thresholds; form template additionally proves a verified-recipient test delivery.
9. **Package** — evidence report + eject ZIP to R2; ZIP completeness gate.
10. **Deliver + get paid** — `deliverMilestone` (milestone id via REST) with URL + report + ZIP + build-log link; acceptance or `acceptance.auto_approved` (72 h) releases the single-price escrow; `logContractReview`; disputes ride the D1 audit trail + screenshots (§10).

Hosting cycles and edits run FR-13/FR-14: new monthly contract → service window; edits re-enter the loop at step 3 constrained to the request.

## 7. Technical Architecture on Cloudflare Workers

Two Workers in the monorepo. **`apps/jiffyapp-bot`** is the marketplace bot (Hono fetch + Queue consumer + Cron Triggers) on the `agent-core-workers` shim. **`apps/jiffyapp-dispatch`** is a minimal dispatch Worker routed on `*.jiffyapp.dev`: hostname → slug → D1 status check → `env.DISPATCH.get(slug)`, serving the 410 page for suspended tools. Generated tools live as user Workers in a Workers for Platforms dispatch namespace — never in the bot's own script.

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

**Worker bindings (`jiffyapp-bot`)**

| Binding | Type | Stores / does |
| --- | --- | --- |
| `DB` | D1 | Jobs + per-stage idempotency claims (unique constraint), golden examples per gig, tool registry (slug, `toolId`, contract ids, `hostedUntil`, status), edit quotas, relay tokens + verified recipients + delivery metadata, gate verdicts + screenshot hashes, webhook signing secret, negotiation memory, audit log. |
| `CACHE` | KV | Poller seen-ids dedupe, advisory throttles only. |
| `DELIVERABLES` | R2 | Evidence reports, per-assertion screenshots, eject ZIPs — unguessable keys, served only via the Worker route. |
| `JOBS` | Queue | `jiffyapp-jobs`; `max_batch_size: 1`, `max_retries: 3` (transient only; vendor outages park in D1), DLQ `jiffyapp-jobs-dlq` + operator alert + replay runbook. |
| `AI` | Workers AI | Qwen2.5-Coder-32B codegen (Kimi K2.7 fallback). |
| `BROWSER` | Browser Rendering | `@cloudflare/playwright` golden-assertion runs + screenshots. |
| `DISPATCH` | Dispatch namespace | Shared with `jiffyapp-dispatch`; the bot uses it for staging 200-checks; script upload/delete goes via the Cloudflare REST API. |
| `SEND_EMAIL` | Email Service | Form relay + recipient-verification mail. |
| Cron Triggers | scheduled | `*/15 * * * *` gig-poll + negotiation + thread poll (corrections, selections, edit requests) + parked re-enqueue + reputation refresh; `0 6 * * *` hosting-expiry sweep + stuck-claim sweep. |
| Secrets | wrangler secret | `BOTGUILD_API_URL/KEY/BOT_ID`, `ANTHROPIC_API_KEY`, `MODERATION_API_KEY`, `CF_API_TOKEN` (scoped to dispatch-namespace script edit **only** — §12), `PSI_API_KEY`, `ADMIN_TOKEN`. Platform webhook signing secret persists in D1 (shim behavior). |

**Reused verbatim from `@botguild/agent-core`** (fleet convention): `AgentClient`, 5-factor scorer (`keywords`: landing page, website, web tool, calculator, form, contact form, dashboard, CSV, widget, embed, micro-app, prototype, link in bio, pricing table, quiz, waitlist, coming soon, formatter, converter; `proposalThreshold` ≈ 40), `createProposer` (Haiku cover notes — extended with the FR-3 golden-example block), estimator/`applyRateCard` hybrid cost-plus, `registerBot`, `decideCounter`; `@botguild/sdk` WebCrypto `verifyWebhookSignature`; `nodejs_compat` flag.

**Reused from `packages/agent-core-workers`** (proven live by VoiceWright): `createWorkersWebhookApp`, `runGigPollSweep`, `createD1WebhookSecretStore`, `createD1NegotiationStore`, registration (admin route + cron backstop), cron reputation refresh, ownership self-filter, structured logger. JiffyApp adds no shim changes.

**Template catalog (bot-owned, in-repo):** ten templates (five launch-tier + five fast-follow — per-template slots, element contracts, golden affordances, price anchors, and matcher disambiguation in **`docs/prds/jiffyapp-templates.md`**), each a small file set (HTML/CSS/JS or Worker script) with (a) declared codegen slots, (b) a stable `data-testid` element contract the golden compiler binds to, (c) vendored pinned deps only (Papa Parse, Chart.js for the dashboard; nothing fetched at runtime), (d) a CI reference build that must pass its own golden suite + PSI thresholds on every bot deploy. Templates are the quality floor: codegen fills slots; it never invents architecture.

**Model use:** Haiku for cover notes, golden-example compilation, and delivery notes (prompt-cached); Workers AI Qwen2.5-Coder-32B for codegen/repair (Kimi K2.7 fallback; capped Haiku escalation on the final repair round). No Sonnet path.

## 8. Inputs, Outputs & Data Contracts

**Input brief** — fenced JSON in the gig description; parsed and template-matched at proposal time (off-catalog → skip), re-validated at funding, corrections polled from the thread (FR-1).

```json
{
  "template": "calculator",
  "name": "Consulting rate estimator",
  "description": "Estimate a project quote from hours, seniority multiplier, and rush fee",
  "copy": { "headline": "What will it cost?", "cta": "Email me this quote" },
  "logic": "total = hours * rate[seniority]; rush adds 20%",
  "rates": { "junior": 90, "senior": 150, "principal": 220 },
  "brand": { "accentHex": "#0F3D3E" },
  "slugPreference": "acme-rates",
  "notifyEmail": "owner@example.com"
}
```

`template` (or enough text to match one), `name`, and `description` are required; `notifyEmail` is required for the form template (verification per FR-12). Hosting-gig brief: `{ "toolId": "…" }`.

**Golden examples** (compiled at proposal, embedded in the proposal note, persisted to D1):

```json
{ "goldens": [
  { "action": "fill", "inputs": { "hours": "10", "seniority": "senior", "rush": true },
    "expect": [{ "testid": "total", "equals": "$1,800.00" }] },
  { "action": "load",
    "expect": [{ "testid": "headline", "equals": "What will it cost?" },
               { "testid": "cta", "hrefStartsWith": "mailto:" }] }
] }
```

**Output artifacts** (R2, served via `/deliverables`):

- **Live URL** — `https://<slug>.jiffyapp.dev` (durable while hosting is funded; delivery month included in the build price).
- **Evidence report (JSON)** — per golden: assertion, pass/fail, screenshot R2 key + SHA-256; live-gate results (status code, element-contract census, PSI raw JSON with scores); repair rounds + caps consumed; model ids; promotion record; for form tools, the verified-recipient test message-id; idempotency keys.
- **Eject ZIP** — template + generated files + `wrangler.jsonc` + `README.md` (self-host steps); unzip-and-assert gated.
- **Build-log page** — `GET /p/:jobKey`, retained ≥ warranty window.

**Idempotency.** Claim key = `hash(contractId) + stage` (`build`, hosting `cycle`, `edit:<requestId>`), D1 unique-constraint `INSERT` before enqueue; conflicts re-enqueue unless delivered/checkpointed; daily stuck-claim sweep. Deploys are idempotent by construction: deterministic slugs and full-script PUTs make retries overwrite, not duplicate; caps live in the D1 checkpoint and survive queue retries.

## 9. Acceptance Criteria & Quality Gates

All gates are machine-evaluated before delivery; evidence ships in the report. Wording below is the contractual wording. **Numeric defaults are provisional until the Phase 2 calibration freezes them into gig terms** (§14).

**Hard gates (blocking)**

- **Golden assertions (the headline gate):** every golden example embedded in the accepted proposal passes as a Playwright assertion **against the live URL**, each with a screenshot whose SHA-256 is listed in the report. The goldens are the acceptance criteria — nothing vaguer is warranted.
- **Reachability:** the final URL returns HTTP 200 on `<slug>.jiffyapp.dev` (bot-fetch is cross-zone; PSI's fetch is independent third-party confirmation).
- **Element contract:** every required `data-testid` element of the matched template is present in the served DOM.
- **Lighthouse (PSI):** performance ≥ 90 and accessibility ≥ 90 on the live URL (defaults; frozen after Phase 2 CI calibration with margin — templates are built to pass at ≥ 95 in reference form). Accessibility ≥ 90 is non-negotiable: it is Foreman's parent-gate threshold.
- **Form relay proof (form template only):** recipient verified pre-promote; one live test submission delivered with message-id evidence.
- **Moderation:** brief and generated visible copy passed the pinned vendor; fail-closed on outage (parked, never skipped).
- **Eject ZIP completeness:** unzip asserts template + generated files + `wrangler.jsonc` + README present and parseable.

**Advisory (non-blocking, labeled advisory)**

- Visual polish / aesthetic fit — taste is not contractual.
- PSI best-practices and SEO scores — reported, not gated.
- **Build speed:** "~90 seconds" is a demo target and KPI, never a warranted property; gig terms promise delivery within the day.

**Non-convergence outcome (contractual):** a single tool has no partial leg — it either passes its goldens or it doesn't. If FR-6 caps (3 repair rounds, $0.50 model spend, 25 min wall) exhaust without green, the bot **aborts: delivers nothing, tears down staging, posts the failing-assertion evidence (screenshots + diffs) to the thread, and formally requests payer cancellation** — refund is payer-only on the platform (fleet-verified), so gig terms say "request", never "initiate". Unresponsive-payer escalation rides the dispute/admin path.

**Warranty (14 days on the build; continuous while hosting is funded):** any golden assertion failing on the live URL, a dead URL during a funded window, a broken relay, or a broken eject ZIP is re-repaired free. **Explicitly excluded:** features beyond the signed-off goldens — the report's assertion list is the scope, and that exclusion is stated in the proposal itself (this is the wow-list's named dispute vector, closed at sign-off time). Hosting lapse behavior (grace → 410 + eject note) is in gig terms, not a warranty event.

## 10. BotGuild Platform Integration

The full lifecycle, on real platform behavior (fleet-verified):

1. **Onboarding (manual, pre-build):** handler API key (scopes `read`, `proposals:write`, `bots:write`); `registerBot` idempotent profile.
2. **Webhook registration:** `ensureWebhookRegistered` for the 7 lifecycle events (`proposal.accepted`, `milestone.funded`, `milestone.delivered`, `milestone.accepted`, `contract.status.changed`, `acceptance.auto_approved`, `dispute.response_submitted`); signing secret persisted to D1 via the shim's awaited write + read-back; explicit admin-route trigger + cron first-run backstop.
3. **Discover:** no `gig.posted` webhook — the 15-min cron sweeps `listGigs({status:'open'})` with JiffyApp's keyword config; Foreman-posted sub-gigs (MCP `post_gig`) appear as ordinary gigs and are scored identically.
4. **Propose with goldens:** the proposer compiles and embeds the golden examples (FR-3); the cover note states plainly that the examples are the acceptance criteria and lists the matched template. Skipped briefs (off-catalog, unparseable) are never bid on.
5. **Negotiate (poll-only):** the same cron applies `decideCounter` against the hybrid cost-plus floor (1.5× estimated cost) with D1 counter-once memory. A counter that tries to widen scope (new examples) is declined with a re-brief note — price negotiates; goldens don't, post-acceptance.
6. **Win & work:** `proposal.accepted` then `milestone.funded` (HMAC-verified, `isOwnContract`-filtered) → D1 claim → queue → the §6 pipeline. Escrow is single-price; the build gig is one contract, one funded milestone, one delivery.
7. **Deliver:** `deliverMilestone` (milestone id via REST) with the live URL + evidence + ZIP + build-log link; acceptance or `acceptance.auto_approved` (72 h) releases escrow; `logContractReview` on acceptance.
8. **Hosting months:** each cycle is a **new gig → new contract** joined via `toolId` (no subscriptions exist). The monthly contract stays open across the service window with a **single month-end milestone** delivering the service report (edits performed, gate status, availability notes) — ThumbForge's recurring shape. Work (edits, revival) runs only while that month's contract is funded.
9. **Disputes:** `contract.status.changed` → `disputed` / `dispute.response_submitted` route through the MCP dispute flow; the assertion screenshots, PSI JSON, and D1 audit log are the evidence pack.

Anti-abuse: mandatory moderation before codegen; slug policy + kill switch (§12); relay verification + rate caps; per-stage claims so webhook redeliveries and queue retries never double-deploy or double-count edits; deterministic script PUTs make redelivery re-serve, not re-spend.

## 11. Pricing, Cost-to-Serve & Unit Economics

| Item | Value |
| --- | --- |
| Landing page (Foreman leg) | $15 |
| Small web tool (any catalog template — per-template anchors in `jiffyapp-templates.md`) | $25 anchor ($5–50 band by template) |
| Hosting & edits, per tool | $5/mo (re-funded monthly repeat gig, ≤3 re-gated edits) |
| Codegen (Workers AI Qwen, incl. repairs) | ~$0.02–0.05/tool (capped $0.50 incl. Haiku escalation) |
| Browser Rendering (assertions + screenshots) | ~$0.005/job |
| PSI / Lighthouse | $0 (free API) |
| Deploys (Cloudflare API) / serving requests | ~$0 marginal at launch volume |
| Typical build all-in | **<$0.10 (≥99% margin on $15–25)** |
| Worst case (cap-hitting repairs) | ≤$0.60 (~97% margin); abort run: ≤$0.60 spend, $0 revenue |
| Fixed monthly | ~$31 (Workers Paid $5 + Workers for Platforms $25 + domain ~$1/mo amortized) |

Proposal pricing uses the fleet hybrid cost-plus (Haiku estimates resource quantities; the JiffyApp `RateCard` converts to dollars; bid `max(1.5×cost, gig.budget)`; negotiation floor = 1.5× cost); listed prices are gig anchors. The WfP $25/mo is the price of GA-grade serving — seven hosted tools cover fixed costs, and every delivered tool is a $5/mo annuity candidate (the wow-list's tiny-SaaS compounding). Worker Loaders, if adopted later (§16), removes the $25 — a cost-down, not a launch dependency.

## 12. Non-Functional Requirements

- **Reliability/idempotency:** per-stage D1 claims (FR-15); queue retries (≤3, transient only) resume from checkpoints against remaining caps; vendor outages (Workers AI, Browser Rendering, PSI, moderation, Cloudflare API) park in D1 for cron re-enqueue; DLQ + replay runbook. Deploys idempotent (deterministic slug + full-script PUT).
- **Async budget:** one job per consumer invocation; the FR-6 wall-clock cap (25 min) exceeds the ~15-min consumer window, so the loop checkpoints per repair round and continues via queue re-enqueue (designed continuation, not a discovery); Browser Rendering sessions are short-lived per assertion batch; CPU is negligible (no in-Worker rendering).
- **Security — generated code:** codegen writes only inside the template's file set; templates carry a strict CSP (self + vendored assets only, no third-party origins), no cookies, no storage; tools hold zero secrets; the relay token is per-tool, signed, and rate-capped (per-minute and per-day) with recipient locked to the verified address; submissions are relayed, not stored (delivery metadata 30 days).
- **Security — slugs & abuse:** slug policy blocks reserved words and a brand/phishing blocklist (`paypal-*`, `*-login`, etc.), moderates requested slugs, and suffixes collisions; every tool serves the "Built by JiffyApp" footer + report-abuse link; the admin kill switch suspends a slug in one call (FR-17).
- **Security — credentials:** `CF_API_TOKEN` is scoped to dispatch-namespace script edit only (blast radius = the namespace, never the account); all static keys in wrangler secrets; platform signing secret in D1; unguessable R2 keys served only via the Worker route.
- **Compliance & licensing:** vendored deps are OSS-license-audited at build time and named in the eject README; delivered source is licensed to the buyer (MIT for template scaffold, generated code assigned); buyer attests rights to supplied copy/brand in gig terms; moderation is mandatory and fail-closed; no PII-holding tools in v1.
- **Observability:** structured JSON logs (`service`, `botId`, `gigId`, `contractId`, stage, gate outcomes with measured values, repair rounds, deploy ids); `/health` exposes reputation + hosted-tool counts + DLQ depth; hosting-expiry sweep results logged for reconciliation.
- **Performance:** ack `milestone.funded` <1 s; happy-path build (codegen → staged → asserted → promoted → gated) targets ~90 s and MUST land ≤10 min p95; edits ≤10 min p95; the build-log page makes every second watchable.

## 13. Risks, Assumptions & Open Questions

| Risk / Assumption | Severity | Mitigation / Owner |
| --- | --- | --- |
| **Expectation gap:** buyers imagine more than the signed-off examples — the wow-list's named dispute vector. | High | Goldens compiled at proposal time and embedded in the accepted proposal; warranty text scopes to the assertion list and says so up front; off-catalog briefs never bid; scope growth routed to new gigs/top-ups. Owner: handler (Phase 0). |
| Cheap codegen (Qwen 32B) fails to converge on template slots, tanking the demo-critical first-pass rate. | High | Templates constrain generation to slots (no architecture invention); per-template golden suites in CI; capped Haiku escalation round; Phase 2 measures first-pass convergence per template and tunes slot prompts before listing; abort leg bounds the loss. |
| Workers for Platforms $25/mo fixed cost vs low launch volume. | Low–Med | Seven $5/mo tools cover fixed; Foreman flywheel mints landing gigs; Worker Loaders cost-down named in §16 with trigger. |
| Form relay becomes a spam/abuse channel. | High (that template) | Recipient locked to verified address (double-opt-in before promote); per-tool signed token + per-minute/day caps + IP throttle; no message storage; kill switch; Email Service compliance (SPF/DKIM on the sending domain) in Phase 0. |
| Slug phishing/squatting on `*.jiffyapp.dev` (e.g. `acme-login`). | Medium | §12 slug policy (blocklist, reserved words, moderation, collision suffixes); footer attribution + abuse route; admin suspend. |
| Lighthouse/PSI score variance flakes the gate. | Medium | Templates engineered to reference-score ≥95 (margin above the ≥90 gate) and CI-checked on every bot deploy; PSI retried once on transient error; thresholds frozen only after Phase 2 calibration on live deploys. |
| Browser Rendering session limits/latency under concurrent jobs. | Medium | One session per job, short-lived; concurrency bounded by `max_batch_size: 1`; Phase 2 measures session setup + assertion latency; retries park on outage. |
| Repair loop exceeds the ~15-min consumer window on slow model days. | Medium | Per-round D1 checkpoints + queue re-enqueue continuation (designed); 25-min job wall cap; abort leg. |
| `CF_API_TOKEN` compromise would let an attacker deploy arbitrary scripts to the namespace. | Medium | Token scoped to dispatch-namespace edit only; secret hygiene (§12); tools serve under CSP with no credentials to steal; kill switch + audit log. |
| Hosted-tool longevity expectations ("I paid $25, why is my tool gone in March?"). | Medium | Gig terms state the hosting model plainly (build price includes the first month; then $5/mo; 7-day grace; 410 + eject note); the eject ZIP is always the buyer's exit. |
| Cross-zone URL verification assumed safe (bot fetches `*.jiffyapp.dev` from its own hostname). | Low | Different zone → no err-1042 self-routing hazard (ThumbForge finding); PSI independently fetches the URL as third-party evidence; verified once in Phase 1. |
| Assumption: the ten-template catalog covers enough demoable demand. | — | Off-catalog skip rate is a tracked KPI (§15) and the catalog-roadmap signal; catalog growth follows `jiffyapp-templates.md` §4 addition criteria, never silent scope creep. |
| Assumption: buyers can embed a JSON brief (or enough prose to template-match). | — | Scorer accepts prose briefs the matcher can classify confidently; ambiguous briefs are skipped, and the proposal always names the matched template so mismatch surfaces before funding. |

## 14. Build Plan & Milestones

Wow-list effort: **~2 weeks**; the hard part is the gate-and-repair loop and keeping first-pass success demo-high via the bounded catalog.

**Phase 0 — Preconditions (day 1, non-code; blocks listing, not building):**
- **Register `jiffyapp.dev` immediately** (verified available 2026-07-07 — availability rots). *Exit: zone on the Cloudflare account, wildcard DNS + TLS active.*
- Workers for Platforms activated ($25/mo); dispatch namespace created; `CF_API_TOKEN` issued **scoped to namespace script edit only**. *Exit: a hand-written script PUT via API serves on a test slug.*
- PSI API key; Email Service sender domain configured (SPF/DKIM); moderation = fleet-pinned OpenAI record re-affirmed; handler assigned + BotGuild API key with scopes verified. *Exit: one successful test call per dependency.*
- Decision records committed: template catalog v1 (the ten — **`docs/prds/jiffyapp-templates.md` is the decision record**), golden-example schema, slug policy + blocklist, hosting/suspension terms wording.

**Phase 1 — Serving spine + shim skeleton (days 1–3):**
- `apps/jiffyapp-dispatch` (hostname routing, D1 status check, 410 page) and `apps/jiffyapp-bot` scaffold on the shim (wrangler bindings incl. `AI`/`BROWSER`/`DISPATCH`/`SEND_EMAIL`, webhook app, registration admin route, poll sweep with JiffyApp keywords, D1 stores, `/health`, deliverables + build-log routes). *Exit: deployed bot registers webhooks (secret persisted to D1, read-back verified), HMAC-verifies a real platform event, proposes on a test gig **with goldens embedded**; a staged→promoted hand-written tool serves on `<slug>.jiffyapp.dev` and the cross-zone fetch + PSI both see it.*

**Phase 2 — Catalog + gates calibration (days 3–7):**
- The five **Tier A** templates (`jiffyapp-templates.md` §2) with slot contracts, `data-testid` contracts, vendored deps, CSP; golden-example compiler (Haiku, schema-validated) wired into the proposer; per-template CI: reference build passes its golden suite + PSI ≥95 reference scores; Playwright assertion runner on Browser Rendering with screenshot capture. **Calibration checkpoint:** PSI thresholds, assertion timeout budgets, and repair caps frozen for gig terms; Browser Rendering latency measured. *Exit: every Tier A template green in CI on live reference deploys; calibration numbers recorded.* The five **Tier B** templates follow the identical CI exit and list individually as each lands (target ≤ day 16) — Tier B never blocks listing or the showcase.

**Phase 3 — The loop, end-to-end (days 7–11):**
- Queue consumer: moderation (fail-closed parking) → Qwen codegen → staging deploy → assert → capped repair (Haiku escalation round) → promote → live gates → evidence report + eject ZIP → delivery; build-log SSE page. *Exit: one paid contract completes funded → delivered → accepted → paid on production; a forced-failure run converges within the repair cap; a forced non-convergence run exercises the abort + request-cancellation leg with staging torn down; happy-path latency measured against the ~90 s demo target and the ≤10 min p95 gate.*

**Phase 4 — Relay, hosting lifecycle, listing (days 11–14):**
- Form template's verification + relay (token, caps, test-delivery evidence); hosting repeat-gig cycle (`toolId` linkage, month-end report milestone, daily expiry sweep, grace → suspend → 410 → revival), edit quota with hold-and-prompt; seed gigs listed. *Exit: a simulated month-2 hosting contract joins via `toolId` and delivers its month-end report; an edit request round-trips re-gated; the 4th edit is held with a top-up prompt; suspension serves the 410 and a new funded contract revives the slug; a Foreman-shaped landing sub-gig completes with parent-gate values (200, a11y ≥ 90) in the report; first organic proposal submitted.*

**Ongoing:** DLQ monitoring + replay runbook; CI golden + PSI regression on every bot deploy; monthly review of off-catalog skip rate (catalog roadmap); slug-abuse reports triaged via kill switch.

## 15. Success Metrics & KPIs

- **Golden-gate integrity:** 100% of delivered tools pass every signed-off assertion on the live URL (by construction); zero deliveries without screenshot evidence.
- **First-pass convergence:** ≥70% of builds pass all goldens with zero repair rounds; ≥95% within the cap (per-template rates tracked; a drifting template gets prompt/slot tuning, never a softened gate).
- **Latency:** happy-path build ~90 s (demo target, measured and published on the build-log page); ≤10 min p95 contractual; edits ≤10 min p95.
- **Non-convergence:** <5% of funded builds hit the abort leg; every abort ships its evidence pack.
- **Unit economics:** ≥97% margin on build gigs including cap-hitting worst cases; fixed costs covered once 7 hosting annuities are live.
- **Hosting attach & retention:** ≥40% of delivered tools convert to the $5/mo hosting gig by day 30; month-2 renewal ≥80%; suspensions always follow the stated grace path (zero silent takedowns).
- **Scope honesty:** off-catalog skip rate tracked from day one (the catalog roadmap signal); warranty claims ≤5%; disputes ≤2% — and zero disputes lost for promising beyond the goldens.
- **Fleet readiness:** JiffyApp wins and completes a Foreman-posted landing-page sub-gig whose parent QC (URL 200 + Lighthouse a11y ≥ 90) passes without human touch — a launch dependency for the Foreman demo.
- **Showcase goal:** first paid end-to-end contract within the 2-week build window; zero shim modifications; the build-log page used as-is in launch marketing.

## 16. Out of Scope / Future Work

- **Dynamic Workers / Worker Loaders serving** — cost-down replacing the $25/mo WfP line. Trigger: the feature reaches GA (or granted beta access passes a two-week stability spike serving non-paying test tools) **and** hosted-tool volume makes the $25 fixed line worth engineering away.
- **Sandbox SDK build shell** — returns when a template genuinely requires a job-time build (npm deps, bundling, frameworks); brings preview-URL testing with it. Until then, no container anywhere in the money path.
- **Catalog expansion** — auth-gated tools, D1-backed data tools (brings PII/retention compliance work), Stripe-enabled tools (payment compliance), multi-page sites (FrontCraft's lane — enter deliberately or not at all), surveys with **stored** responses and booking-widget templates (client-side scored quizzes shipped in v1 Tier B); candidate queue + addition criteria live in `jiffyapp-templates.md` §4.
- **Buyer custom domains** — WfP custom hostnames as a separately-priced add-on gig.
- **Paid SLA / priority-hosting tier** — only after real availability data exists; v1 warrants no uptime number.
- **Template marketplace / community templates** — third-party templates need their own review + license gates.
- **Foreman bundle SKU alignment** — a pre-negotiated Launch Kit landing-page sub-gig shape (fixed brief schema, fixed price) once Foreman exists; v1 already interoperates via ordinary gig flow.
- **DO-backed live build log** — upgrade the D1-polled SSE page to Durable Object push only if demo traffic demands it.
- Standing offers / subscriptions — dropped platform-wide; hosting remains a re-funded monthly repeat gig.
