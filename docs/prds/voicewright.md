# VoiceWright — Product Requirements Document

> On-brand ad copy from headline to call-to-action — grapheme-validated against Meta length limits, screened by a pinned moderation vendor plus a versioned ad-policy checklist, delivered as a CSV built on Meta's official Ads Manager bulk-import template.

| Field | Value |
| --- | --- |
| Bot ID | `bot-voicewright` |
| Category | Content Creation / Copywriting |
| Value-chain role | Transformer |
| Handler/Owner | Diego Fernández |
| Framework | Cloudflare Worker (Hono) in the `botguild-agents` monorepo — `apps/voicewright-bot` |
| Status | **v2.0 — retargeted for Cloudflare Workers (botguild-agents monorepo), Proposed, 2026-07-06** |
| Supersedes | `botguild-platform/bots/prd/voicewright.md` (v1.0, local-eve) |
| Spec link | `botguild-platform/docs/gtm/bot-specs/voicewright.md` |
| Selection decision | `botguild-platform/bots/showcase-selection.md` |

**What changed since v1.0**

- **Runtime:** local `eve dev` → a pure Cloudflare Worker (`apps/voicewright-bot`, Hono fetch handler + Queues + Cron Triggers + KV/D1/R2). No container, no tunnel, no host scheduler.
- **Delivery model:** the v1.0 synchronous single-request channel was a local-eve artifact. v2.0 acks `milestone.funded` fast and runs generate→validate→moderate→export **asynchronously** via a Cloudflare Queue consumer, then delivers through `deliverMilestone` with evidence links served from the bot's own Worker route.
- **CSV deliverable rebuilt** on Meta's official Ads Manager bulk-import template (campaign/ad-set/ad columns, exact headers, UTF-8, 2 MB cap); the brief now collects campaign scaffolding + creative refs. v1.0's variant-only rows do not import.
- **Gates hardened:** grapheme-aware length counting (`Intl.Segmenter`) with an emoji/CJK margin; a deterministic angle-diversity floor (n-gram overlap cap, threshold calibrated in Phase 2); hard retry/cost caps on the regeneration loop with a contractual non-convergence outcome (abort = *request* payer cancellation — bot-side refund does not exist on the platform); moderation vendor pinned (OpenAI Moderation, sole v1 vendor, fail-closed — Azure Content Safety is a future swap, not automatic failover) with per-variant verdict snapshots; all "100% clean import" and "pixel limit" warranty language dropped.
- **Platform reality reflected:** gig discovery is a cron-driven poller (there is no `gig.posted` webhook); webhooks are handler-scoped and self-filtered; the one-time webhook signing secret persists in D1; negotiation is poll-only; escrow is single-price with milestone checkpoints.
- **Scope tightened:** SERP context provider defaulted OFF; Meta Marketing API draft upload strictly out of v1 (removed from the build plan entirely, not just deferred to a phase).

## 1. Overview

Performance marketers and agencies running paid social on Meta burn hours producing varied, policy-safe ad copy that imports cleanly into Ads Manager. They need many angles fast, every line must fit platform character limits, and every line must survive ad-policy review — a single rejected variant can stall a campaign launch.

VoiceWright is a transformer bot: it ingests a brand voice guide, an offer, and campaign scaffolding, and produces on-brand copy from headline to CTA. Every line is validated against Meta character limits (grapheme-aware) and screened by a pinned moderation vendor plus a versioned local ad-policy checklist. The core seed gig delivers 10 Facebook/Instagram ad variations across ≥3 distinct angles, assembled into a CSV that conforms to Meta's validated bulk-import template, plus a JSON validation report evidencing every gate.

"Done" for a buyer means receiving a CSV in which every headline ≤40 graphemes, every primary text ≤125 graphemes, ≥3 deterministically-verified distinct angles are represented, every variant carries a logged moderation verdict from the pinned vendor plus a checklist pass, and the file conforms to the import template golden-file-tested against a real ad account — with no copywriter hours and no manual cleanup.

## 2. Goals & Non-Goals

**v1 Goals**

- Accept and complete paid BotGuild jobs end-to-end (discover → propose → win → work → deliver → get paid) as a Cloudflare Worker with no container dependency.
- Generate N ad variants across ≥3 distinct angles in a learned brand voice from a single brief, asynchronously after the `milestone.funded` ack.
- Enforce a hard, grapheme-aware fit gate (headline ≤40, primary text ≤125 graphemes via `Intl.Segmenter`, conservative margin for emoji/CJK) that regenerates over-limit lines under hard retry/cost caps — never truncates.
- Enforce a hard policy gate: every variant passes the pinned moderation vendor (OpenAI Moderation) plus local ad-policy checklist vX before delivery; verdicts snapshotted per variant at delivery time.
- Ship a CSV built on Meta's official bulk-import template, golden-file-tested against a real, existing stakeholder ad account before the gig is listed.
- Ship the FREE readability-score + plain-language rewrite gig (pinned JS Flesch-Kincaid lib, lib name reported with the score).
- Support the recurring monthly fresh-creative refresh ($50/mo, re-funded monthly gig) via a stored brief in D1 and a Workers Cron Trigger, with a deterministic differs-from-prior-cycle check.
- Build the shared agent-core-on-Workers shim once, for reuse by ThumbForge and every future Workers bot.

**Non-Goals (v1)**

- **Meta Marketing API draft upload — strictly out of scope.** Business verification + `ads_management` App Review (weeks–months) + per-client system-user tokens would invert the friction profile; it stays out of the showcase narrative and demo entirely.
- Pixel/rendered-width validation of any kind — v1 validates grapheme counts only, and no warranty language references pixels.
- SERP/DataForSEO context enrichment on by default — the provider ships defaulted OFF (FR-3 degrade path is the default path).
- Long-form landing pages at scale (seed gig is short-form ad copy on Haiku).
- Google Ads CSV/API export.
- A hosted standing-offer table — the platform dropped standing offers/subscriptions; the refresh is a re-funded monthly gig.

## 3. Target Users & Buyers

- **Performance marketer (in-house growth)** — runs Meta campaigns and needs fresh, policy-safe angles fast. Job: "Give me 10 import-ready ad variants in my brand voice so I can launch a test today without writing copy."
- **Agency creative lead** — manages many client ad accounts with distinct voice guides and policy constraints (e.g. a fitness app forbidding weight-loss/body-transformation claims). Job: "Produce on-brand, compliant variants per client at scale, on a monthly cadence."
- **Founder / solo operator** — needs taglines and ad copy without hiring a copywriter. Job: "Turn my offer and a rough voice description into usable, validated ad copy cheaply."
- **Prospect evaluating the bot (FREE gig)** — pastes one paragraph for a readability score and plain-language rewrite. Job: "Show me the quality bar before I pay."

## 4. User Stories & Use Cases

**Story A — 10 ad variants across 3 angles** *(Tier $1–100, $15, recurring $50/mo)*

> As a performance marketer, I want 10 Facebook/Instagram ad copy variations across ≥3 distinct angles in my brand voice, so that I can launch policy-safe A/B tests without writing copy.

- Acceptance: the CSV contains 10 ad rows on the Meta bulk-import template, each with campaign/ad-set/ad columns populated from the brief plus Body (primary text), Title (headline), and Link Description.
- Acceptance: ≥3 distinct angles verified by the deterministic diversity floor (§9), with angle tags as labels.
- Acceptance: every headline ≤40 graphemes and every primary text ≤125 graphemes (`Intl.Segmenter` count; emoji/CJK margin per §9).
- Acceptance: every variant carries a pass verdict from the pinned moderation vendor + ad-policy checklist vX, snapshotted in the delivered JSON report.
- Acceptance: the CSV conforms to the validated import template (golden-file tested; test date stamped in the delivery report).

**Story B — FREE readability score + plain-language rewrite** *(Tier free, $0)*

> As a prospect, I want a readability score plus a plain-language rewrite of one paragraph, so that I can judge VoiceWright's quality before paying.

- Acceptance: returns a Flesch-Kincaid grade computed by the pinned lib (`text-readability`), with the lib name and version reported alongside the score.
- Acceptance: returns one rewritten paragraph at a grade ≤ the input's grade; if the input is already at the floor (FK grade ≤ 5), the delivery states "already at plain-language floor" and the rewrite must merely not raise the grade.
- Acceptance: the rewrite passes the moderation gate before it is returned; a vendor outage fails closed (no delivery, retry later).

**Story C — Monthly fresh-creative refresh** *(Recurring $50/mo, re-funded monthly gig)*

> As an agency creative lead, I want a monthly batch of fresh variants from my stored brand brief, so that I keep creative fatigue down without re-briefing every cycle.

- Acceptance: a Workers Cron Trigger detects the due cycle from the D1-stored brief; each cycle is a new gig/contract joined to the stored brief via the `briefId` in the refresh-gig description (FR-10); work runs only after that cycle's gig is funded (`milestone.funded`) — never unpaid.
- Acceptance: each cycle carries a distinct idempotency key (its own `contractId`, D1 unique constraint), so a retry never double-delivers.
- Acceptance: the new batch passes all v1 gates AND the deterministic differs-from-prior-cycle check (same n-gram mechanism as the angle floor, computed against the prior cycle's delivered variants stored in D1).

## 5. Functional Requirements

- **FR-1 (Intake):** The brief arrives as a fenced JSON block embedded in the gig description (§8) — there is no structured-brief channel and `message.new` is in-app-only. The bot SHALL parse and completeness-check the brief **at proposal time** (the scorer skips gigs with missing/invalid briefs, so incomplete briefs are never won) and SHALL re-validate at `milestone.funded`. If post-funding validation still fails, the bot SHALL post a specific field-level error to the contract thread requesting a corrected brief, and SHALL poll the contract thread (REST, in the 15-min cron sweep) for the buyer's corrected JSON — the job stays parked in D1, never silently stalled.
- **FR-2 (Brief moderation):** The bot SHALL screen the inbound brief through the pinned moderation vendor before generation; a failing brief is rejected, not processed. Vendor 429/outage SHALL fail closed: the job is marked `parked` in D1 and re-enqueued by the 15-min cron sweep (queue retries are reserved for genuine transient errors, not outages — see §12); after 3 failed moderation attempts the bot SHALL post a status message to the contract thread. Never skipped, never delivered unscreened.
- **FR-3 (Context, default OFF):** SERP context (DataForSEO/SerpApi) SHALL ship disabled (`SERP_ENABLED=false`). When later enabled, a context-call failure SHALL degrade gracefully (generate without context) rather than block. The degraded path is the v1 default path.
- **FR-4 (Generation):** The bot SHALL generate the requested variants across ≥3 distinct angles via Claude (Haiku for short-form ad copy), each with primary text + headline + description in the learned voice, from within the Queue consumer.
- **FR-5 (Fit gate, bounded):** The bot SHALL validate every line grapheme-aware (`Intl.Segmenter`) against §9 limits and SHALL regenerate over-limit lines rather than truncating — subject to hard caps: max 3 regeneration attempts per variant, max 2 batch top-up rounds, max $1.50 Claude spend per batch. Cap accounting lives in the consumer's in-memory state and is persisted in the D1 job checkpoint, so retried messages resume against the remaining budget (KV counters are advisory throttles only — see §12). On cap exhaustion, the non-convergence outcome of §9 applies.
- **FR-6 (Readability, advisory):** The bot SHALL compute a Flesch-Kincaid grade per variant via the pinned `text-readability` lib as an advisory signal only, reported with lib name + version.
- **FR-7 (Policy gate):** The bot SHALL screen every variant through the pinned moderation vendor plus ad-policy checklist vX (versioned, in-repo), SHALL rewrite failing variants within FR-5's caps, and SHALL snapshot each variant's full vendor verdict JSON + checklist result in D1 at delivery time.
- **FR-8 (Export):** The bot SHALL assemble the CSV on Meta's official bulk-import template (exact headers, UTF-8, ≤2 MB) from variants that cleared all gates, and validate it against the golden-file-tested template schema before delivery.
- **FR-9 (Delivery):** The bot SHALL upload the CSV + JSON validation report to R2 and call `deliverMilestone` with evidence links served from the bot's own Worker route (`/deliverables/...`) — never an `r2.dev` URL.
- **FR-10 (Recurring):** Each monthly cycle is a **new gig → new contract** (escrow is single-price). Linkage: at first delivery the bot issues a `briefId` and instructs the buyer (delivery note + thread message) to include it in the refresh gig description; the poller/proposer recognizes the `briefId` and joins the funded contract to the D1-stored brief and cycle number. The bot SHALL re-run the stored brief only when the daily Cron marks the cycle due AND that cycle's gig reaches `milestone.funded`, with the standard per-contract idempotency key (each cycle's contractId is distinct) and the differs-from-prior-cycle gate.
- **FR-11 (Audit):** The bot SHALL log every moderation/policy/gate decision to D1 (and structured logs) for warranty and dispute evidence; the JSON report delivered to the buyer is generated from these records.
- **FR-12 (Self-filtering):** The bot SHALL ignore webhook events for contracts it does not own (`isOwnContract` check) — webhooks are handler-scoped and sibling bots' events will arrive.
- **FR-13 (Async ack):** The webhook handler SHALL ack `milestone.funded` within the platform delivery timeout by enqueuing the job (D1 idempotency claim + Queue send) and returning 200; all pipeline work runs in the Queue consumer. Note: the `milestone.funded` payload carries no `milestoneId` (verified: `{contractId, handlerId, payerId, milestoneTitle, gigTitle}`), so the claim key is `hash(contractId)` — sufficient because the seed gig is one contract, one funded milestone — and the consumer fetches the milestone id via REST before delivery.

## 6. End-to-End Pipeline

1. **Win the job** — cron poller discovers the gig, scorer clears it, proposer submits; `proposal.accepted` then `milestone.funded` arrive by webhook (self-filtered).
2. **Ack + enqueue** — the fetch handler verifies HMAC, claims the idempotency key (`hash(contractId)` — the event payload has no `milestoneId`; the consumer fetches it via REST) via D1 `INSERT` (unique constraint), enqueues `{contractId, jobKey}` to the `voicewright-jobs` Queue, returns 200. On unique-constraint conflict (redelivery), the handler reads the job row's status and **re-enqueues unless it is already delivered or checkpointed in progress** — claim and send are not atomic, so a claimed-but-never-enqueued job must not 200 into a permanent stall.
3. **Brief intake + moderation** (Queue consumer) — re-validate the brief parsed from the gig description at proposal time (FR-1); screen it through the pinned moderation vendor; fail closed on vendor outage (D1 `parked` state + cron re-enqueue per FR-2).
4. **Generate** — Claude (Haiku) writes variants across ≥3 angles, each with primary text + headline + description in the learned voice. (SERP context step skipped — provider defaulted OFF.)
5. **Fit gate** — grapheme-aware length validation; regenerate over-limit lines within FR-5 caps; attach advisory readability scores.
6. **Policy gate** — moderation vendor + checklist vX per variant; rewrite failures within caps; snapshot verdicts to D1.
7. **Diversity gate** — deterministic n-gram floor across angle groups (and vs prior cycle for recurring).
8. **Export** — assemble + schema-validate the Meta bulk-import CSV; write CSV + JSON validation report to R2.
9. **Deliver** — `deliverMilestone` (milestone id fetched via REST) with the delivery note + Worker-served evidence links; on `milestone.accepted`, log the payer review. Non-convergence at any gate follows the §9 contractual outcome (partial delivery, or abort + **request** payer-initiated cancellation — the bot cannot refund escrow itself, see §9).

## 7. Technical Architecture on Cloudflare Workers

VoiceWright is a single Cloudflare Worker at **`apps/voicewright-bot`** in the `botguild-agents` monorepo — pure API orchestration (Hono fetch handler + Queue consumer + Cron Triggers), every primitive already in production in the platform's `apps/api`. No container, no headless browser, no native binary.

```
                 BotGuild platform
   webhooks (HMAC) │        ▲ REST (AgentClient) / MCP (disputes)
                   ▼        │
 ┌───────────────────────────────────────────────┐
 │ voicewright-bot Worker                        │
 │  fetch: POST /webhook  (verify→D1 claim→enq)  │
 │         GET /health, GET /deliverables/:k/:f ─┼──▶ R2 (csv, report)
 │  scheduled: poll gigs (15m) · refresh (daily) │
 │  queue: voicewright-jobs consumer             │
 │   brief→moderate→generate→fit→policy→        │
 │   diversity→export→deliver                    │
 └───┬─────────┬─────────┬──────────────┬────────┘
     ▼         ▼         ▼              ▼
    D1        KV     Anthropic     OpenAI Moderation
 (state)  (dedupe)   (Haiku)      (pinned v1; fail-closed)
```

**Worker bindings**

| Binding | Type | Stores / does |
| --- | --- | --- |
| `DB` | D1 | Jobs + idempotency claims (unique constraint on `job_key`), stored recurring briefs, prior-cycle variants, moderation verdict snapshots, gate audit log, webhook signing secret + webhook id, negotiation memory. |
| `CACHE` | KV | Gig-poller seen-ids dedupe, advisory cross-contract rate throttles. Nothing correctness-critical (KV is eventually consistent — the FR-5 spend caps live in the D1 job checkpoint, not here). |
| `DELIVERABLES` | R2 | CSV + JSON validation report per job, keyed by unguessable job key; served only via the Worker's `/deliverables` route. |
| `JOBS` | Queue (producer+consumer) | `voicewright-jobs` — the async work pipeline. Consumer pinned `max_batch_size: 1` (one funded job per invocation — never multiple pipelines in one 15-min wall-clock window). Max 3 retries for **transient** errors (Claude 5xx, D1 hiccups), then DLQ `voicewright-jobs-dlq` alerting the operator; vendor outages park in D1 instead of burning retries (FR-2/§12). |
| Cron Triggers | scheduled | `*/15 * * * *` gig-poll sweep + negotiation sweep + parked-job re-enqueue + reputation refresh; `0 6 * * *` daily refresh-due check against D1 briefs + stuck-claim sweep. |
| Secrets | wrangler secret | `BOTGUILD_API_KEY`, `ANTHROPIC_API_KEY`, `MODERATION_API_KEY`. (The webhook signing secret is platform-issued **at runtime** from the `POST /webhooks` response — a Worker cannot write its own deploy-time secrets from inside an invocation, so it persists to D1; both stores survive redeploys.) |
| `compatibility_flags` | wrangler config | `["nodejs_compat"]` — required by `agent-core`'s `Buffer` uses (`client.ts` data:-URL attachments); mirrors the platform's own `apps/api/wrangler.json`. (Webhook HMAC uses `@botguild/sdk`'s WebCrypto `verifyWebhookSignature`, not `node:crypto` — see below.) |

**Reused verbatim from `@botguild/agent-core`** (all portable, fetch-based): `AgentClient` (typed REST client via `@botguild/sdk`), `scoreGig`/`shouldPropose` (5-factor scorer), `createProposer` (Haiku cover note, deterministic `pricingCalc`), the estimator/`applyRateCard` hybrid cost-plus pricing, `registerBot`, and the pure `decideCounter` negotiation policy. Inbound webhook HMAC verification uses `@botguild/sdk`'s `verifyWebhookSignature` (WebCrypto — genuinely Workers-safe), **not** agent-core's `node:crypto` `verifySignature`/`processWebhookRequest`. Keeping scorer/proposer/pricing as shared package code (not re-implemented) is deliberate — it prevents drift against the Fly reference bots. Bundling: `agent-core` is a single-entry ESM package whose graph imports `@hono/node-server`, pino, and `node:fs`; the Worker build relies on esbuild tree-shaking to drop those (verified at Phase 1 deploy), or agent-core grows subpath exports if shaking proves insufficient.

**Replaced by a new shared shim package, `packages/agent-core-workers`** (built during VoiceWright, inherited by ThumbForge):

| Node-specific piece | Workers replacement in the shim |
| --- | --- |
| `createWebhookServer` (`@hono/node-server`, port bind) | `createWorkersWebhookApp` — Hono app returned as the Worker `fetch` handler, verifying HMAC via `@botguild/sdk`'s `verifyWebhookSignature` (WebCrypto — Workers-safe); `/health` + `/webhook` routes. |
| `createGigPoller` (`setInterval` loop) | `runGigPollSweep` — one poll/score/propose sweep per Cron Trigger invocation, KV-backed seen-ids dedupe. |
| Flat-file `webhook-secret.json` store | `createD1WebhookSecretStore` — `loadWebhookSecret`/`saveWebhookSecret` against D1. **Not** wired through the sync `onSecretCaptured` callback (a fire-and-forget async write Workers may cancel); the secret is persisted from `ensureWebhookRegistered`'s **return value** with an awaited D1 write + read-back check (§10.2). |
| Flat-file `negotiation.json` memory | `createD1NegotiationStore` — **not a 1:1 port**: `NegotiationMemory` is synchronous (`hasCountered`/`markCountered` return void inline) and D1 is async-only, so the shim hydrates the countered-set from D1 into an in-memory `Set` at sweep start, runs `handleCounterOffers` against it, and awaits the D1 write-back before the scheduled handler returns. Poll-only sweep runs in the same cron. |
| `createReputationMonitor.start()` (`setInterval` timer) | No timer survives between invocations — the 15-min cron sweep calls the exported, awaitable `monitor.refresh()` and caches the snapshot in D1 for `/health` to read. |
| pino logger | Structured `console` JSON logger (Workers Logs-compatible), same field contract (`service`, `botId`, `gigId`, `contractId`). |
| `node-cron` schedules | Workers Cron Triggers (`scheduled` handler dispatching by cron expression). |

**Model use:** Haiku for cover notes and all short-form ad-copy generation/rewrites (prompt-cached system prompt); no Sonnet path in v1.

## 8. Inputs, Outputs & Data Contracts

**Input brief** — a fenced JSON block **embedded in the gig description** (the platform has no structured-brief channel; `message.new` is in-app-only; gig discovery is a poller over listings). The poller parses it at proposal time, the scorer treats a missing/incomplete brief as a skip (so the bot never wins a job it can't intake), and the queue consumer re-validates it at `milestone.funded`. Post-funding corrections arrive as buyer thread posts, polled via REST in the 15-min cron sweep (FR-1). Extends v1.0 with the campaign scaffolding an importable ad row requires:

```json
{
  "brandVoiceGuide": "markdown: tone, vocabulary, do/don't, optional example copy",
  "offer": "the product/promotion being advertised",
  "campaign": {
    "campaignName": "Q3-Launch-Test",
    "objective": "OUTCOME_TRAFFIC",
    "adSetName": "Prospecting-Broad-US"
  },
  "creative": {
    "landingUrl": "https://example.com/offer",
    "pageId": "1234567890",
    "imageRef": "image filename or Meta image hash the buyer already has"
  },
  "platform": "facebook-instagram-feed",
  "variantCount": 10,
  "angleCount": 3,
  "policyConstraints": ["no weight-loss or body-transformation claims"]
}
```

A brief missing `campaign`/`creative` fields is skipped at proposal time and rejected at intake (FR-1) — a copy-only CSV cannot import as ads and would rightly be rejected by the buyer. v1 requires full scaffolding, full stop: the earlier "copy columns merged into your existing template" framing is **cut from v1 gig text** (it would sell a deliverable the §9 hard gates and golden-file template can't describe — the un-importable-CSV dispute vector). A copy-columns-only variant is future work (§16) requiring its own intake rule, output definition, and gate wording.

**Output artifacts** (R2, served via the Worker's `/deliverables` route):

- **CSV on Meta's official bulk-import template** — exact headers per the golden-file (campaign, ad-set, and ad columns incl. `Campaign Name`, `Ad Set Name`, `Ad Name`, `Title`, `Body`, `Link Description`, `Display Link`, `Link`, creative ref, `Status`), UTF-8, ≤2 MB, one ad row per variant.
- **JSON validation report** — per variant: grapheme counts, angle tag, pairwise diversity scores, moderation vendor verdict snapshot (vendor name + model/version + full response), checklist vX results, advisory readability score (lib + version), regeneration attempts used; plus batch-level: template version + golden-file test date, caps consumed, idempotency key.

**Idempotency.** Job key = `hash(contractId)` — the `milestone.funded` payload carries no `milestoneId` (FR-13), and every recurring cycle is a new contract, so `contractId` alone is sufficient and unique. Claimed via D1 `INSERT` with a unique constraint before enqueue. Because claim and Queue send are **not atomic**, a unique-constraint conflict does not blindly 200: the handler reads the job row and re-enqueues unless the job is delivered or has checkpoint progress (§6 step 2); the daily cron additionally sweeps for `claimed` jobs older than 30 minutes with no checkpoint and re-enqueues them. Webhook redeliveries and queue retries therefore re-attach to the existing job and re-deliver the same artifacts; nothing double-bills, and nothing stalls claimed-but-unenqueued.

## 9. Acceptance Criteria & Quality Gates

All gates are machine-evaluated by the bot before delivery, and their evidence ships in the JSON report. Wording below is the contractual wording used in gig terms.

**Hard gates (blocking — the CSV ships only when all four pass):**

- **Length (grapheme-aware):** every headline ≤40 graphemes and every primary text ≤125 graphemes, counted with `Intl.Segmenter('grapheme')`; when a line contains emoji or non-Latin (e.g. CJK) graphemes, a conservative 10% margin applies (≤36 / ≤112). Over-limit lines are regenerated, never truncated. *No pixel-width or rendered-width property is measured or warranted.*
- **Angle diversity (deterministic floor):** ≥3 angle groups where every cross-group variant pair has word-bigram Jaccard similarity ≤ 0.5 (computed on normalized text: lowercased, punctuation stripped). **The 0.5 threshold is provisional** until calibrated against real Haiku batches in Phase 2 (§14); the number is finalized per gig-terms version at Phase 3 listing and fixed thereafter. Model-assigned angle tags are labels only and never satisfy the gate by themselves. The recurring tier's "differs from prior cycle" criterion uses the same mechanism and the same threshold value against the prior cycle's delivered variants (D1).
- **Moderation/policy:** every variant *passes OpenAI Moderation (pinned v1 vendor) + published ad-policy checklist vX, verdicts logged and delivered*. **v1 fails closed on an OpenAI outage — there is no automatic failover.** Azure Content Safety is a named *future vendor swap*, requiring a checklist review and a gig-terms version bump before it can produce a contractual verdict. Every per-variant snapshot records the vendor + model/version that produced it. Explicitly NOT promised: Meta ad approval — no moderation API checks Meta ad policy; the local checklist plus the 21-day warranty carry that risk. Vendor verdicts are snapshotted at delivery time (moderation models drift; a dispute re-check may differ — the snapshot is the record of what passed).
- **CSV template conformance:** the CSV *conforms to the validated Meta bulk-import template (golden-file tested; test date stamped in the delivery report)* — exact headers, UTF-8, ≤2 MB. Never worded as "100% clean import guaranteed" or "imports first try": Meta can change the undocumented template without notice, so conformance is re-validated on a monthly schedule (§14).

**Advisory (non-blocking, labeled advisory in the report):**

- **Readability:** Flesch-Kincaid grade per variant via `text-readability` (lib + version named with every score). Different JS libs' syllable heuristics disagree, so the score is meaningful only with the lib pinned.

**Non-convergence outcome (contractual):** if FR-5's caps (3 regens/variant, 2 batch rounds, $1.50 Claude spend) exhaust before all variants pass: with **≥80% of `variantCount`** passing AND the passing subset itself satisfying every batch-level hard gate (the ≥3-angle diversity floor; for recurring cycles, the differs-from-prior check), the bot delivers the passing set with the shortfall itemized in the delivery note and report (buyer may accept or dispute; the warranty covers completing the shortfall). Otherwise the bot **aborts: it delivers nothing, posts the explanation + itemized shortfall evidence to the contract thread, and formally requests that the payer cancel the contract** — cancellation/refund is payer-only on the platform (verified: REST `POST /contracts/:id/refund` and MCP `cancel_contract` both require the caller to be the payer; there is no bot-initiable refund), and payer-side cancellation refunds escrow in one click. If the payer disputes instead, the dispute path (`contract.status.changed` → `disputed`, `dispute.response_submitted`) applies with the D1 audit log as evidence; if the payer is unresponsive, escalation is via the dispute/admin-refund path. A stubborn brief always has a contractual outcome, never a stall — but the abort leg depends on payer or admin action (§13).

**Warranty (21 days):** delivered copy that exceeds the grapheme limits above, fails the delivered checklist vX, or is rejected by Meta review is revised free. Warranty text references graphemes and the checklist version — never pixels, never "Meta approval guaranteed".

## 10. BotGuild Platform Integration

The full lifecycle, on real platform behavior (verified against `apps/api`):

1. **Onboarding (manual, before build week 1):** the handler obtains the API key from the dashboard (early-access manual step) with scopes `read`, `proposals:write`, `bots:write`. `registerBot` idempotently creates/updates the marketplace profile.
2. **Webhook registration (one-time secret):** `ensureWebhookRegistered` subscribes to the 7 dispatched lifecycle events — `proposal.accepted`, `milestone.funded`, `milestone.delivered`, `milestone.accepted`, `contract.status.changed`, `acceptance.auto_approved`, `dispute.response_submitted`. Workers have no boot sequence, so registration runs from an **explicit trigger: a protected admin route invoked once at deploy, with a first-run branch of the cron sweep as backstop**. The signing secret is issued **once** at registration; it is persisted from `ensureWebhookRegistered`'s **return value** (`WebhookRegistration.secret` on fresh create) via an **awaited** D1 write, and the row is read back before registration is treated as complete — never via the sync `onSecretCaptured` callback, whose fire-and-forget write Workers may cancel at invocation end (and whose errors are swallowed) *after* `deleteAllExcept` has already removed the prior registrations. Losing the secret silently stops event delivery. It lives in D1 because it is platform-issued at runtime and a Worker can't write its own deploy-time secrets (redeploy durability is a property of both stores).
3. **Discover:** there is **no `gig.posted` webhook** — the 15-minute Cron Trigger runs `runGigPollSweep` (`listGigs({status:'open'})`, KV dedupe), scores each new gig (5-factor scorer), and submits proposals via `createProposer` + deterministic `pricingCalc`.
4. **Negotiate (poll-only):** payer counter-offers emit no webhook; the same cron sweeps pending proposals and applies `decideCounter` against the pricing floor, with D1 negotiation memory ("counter once" survives redeploys).
5. **Win:** `proposal.accepted` arrives by webhook. Every inbound event is HMAC-verified and **self-filtered** (`isOwnContract`) — webhooks are handler-scoped, so sibling bots' contract events arrive at this endpoint too.
6. **Work:** `milestone.funded` → D1 idempotency claim → enqueue → 200 (FR-13). The pipeline runs in the Queue consumer. Escrow is **single-price** (one `Contract.totalAmount`; milestones are checkpoints without amounts), so the seed gig is one contract, one funded milestone, one delivery.
7. **Deliver:** `deliverMilestone(contractId, milestoneId, { note, attachments })` with Worker-served evidence links (CSV + JSON report). Buyer accepts, or `acceptance.auto_approved` fires after 72h.
8. **Paid + reputation:** on `milestone.accepted`, `logContractReview` reads the payer review; reputation (via `createReputationMonitor`'s awaitable `refresh()`, called from the 15-min cron — its `setInterval` timer doesn't survive Workers invocations) is cached in D1 and surfaced on `/health`. Disputes (`contract.status.changed` → `disputed`, `dispute.response_submitted`) route through `AgentMcpClient`/`handleDisputedContract`, with the D1 gate-audit log and verdict snapshots as evidence.
9. **Recurring:** buyer thread messages are in-app-only (`message.new` is not delivered to bots), so refresh coordination happens via `sendMessage` posts from the bot and re-funded monthly gigs, driven by the daily refresh cron against D1-stored briefs.

Anti-abuse: the moderation gate is mandatory on the inbound brief and every outbound variant — unmoderated copy is never delivered. The contractual FR-5 spend caps are enforced in-invocation and persisted in the D1 job checkpoint; per-contract KV counters are only advisory cross-contract rate throttles (KV is eventually consistent and cannot enforce a hard cap).

## 11. Pricing, Cost-to-Serve & Unit Economics

| Item | Value |
| --- | --- |
| Seed gig — 10 variants / 3 angles | $15 |
| Recurring refresh (re-funded monthly gig) | $50/mo |
| FREE gig — readability + rewrite | $0 |
| Claude (Haiku) per batch incl. regens (capped) | ~$0.02–0.10 typical (hard cap $1.50) |
| Moderation (OpenAI) | ~$0 to cents — **to be confirmed in Phase 0** (pricing/ToS re-verification is an exit criterion) |
| SERP context | $0 in v1 (defaulted OFF) |
| Cloudflare (Queues/D1/R2/KV at showcase volume) | ~$0 marginal on Workers Paid |
| All-in cost per batch (typical case) | **~$0.05–0.15** (≈99% margin) |
| Worst cases | Cap-hitting batch: up to $1.50 (90% margin on $15); abort+refund run: up to ~$1.50 spend, $0 revenue |

Margin figures above are typical-case; FR-5's caps bound the worst case rather than the average. Margin comes from generating ten angle-validated variants in one capped pass with no copywriter hours; the Worker idles at ~$0. Proposal pricing uses agent-core's hybrid cost-plus (Claude estimates resource quantities; the deterministic `RateCard` converts to dollars; bid `max(1.5×cost, gig.budget)`); the $15/$50 seed prices are the gig-listing anchors.

## 12. Non-Functional Requirements

- **Reliability/idempotency:** every job is claimed via D1 unique-constraint `INSERT` before enqueue; on conflict the handler re-enqueues unless the job is delivered/in progress, and the daily cron re-enqueues `claimed` jobs with no checkpoint (§8) — the naive INSERT-or-200 version stalls a paid job forever. Queue retries (≤3, transient errors only, then DLQ + operator alert) re-attach to the same job and artifacts. **DLQ runbook (operational requirement):** DLQ messages do not auto-replay; the operator re-enqueues them to `voicewright-jobs`, where the idempotency claim + checkpoints make replay safe.
- **Async budget discipline:** queue-consumer invocations are capped at ~15 min wall-clock and 30 s CPU by default (raiseable via `limits.cpu_ms`); the consumer is pinned `max_batch_size: 1` so one invocation runs exactly one pipeline. The ~40 sequential Haiku + moderation calls at p95 latency leave little headroom, so D1 checkpoints are **per-variant**, and the designed continuation for a wall-clock overrun is checkpoint + queue retry (resume, don't restart Claude spend). Phase 2 measures actual duration/CPU/subrequest counts (§14); the named fallback if one invocation can't fit a batch is splitting into per-stage queue messages resuming from D1 checkpoints — a planned pivot, not a discovery. Subrequests (1000/invocation on paid) are not a constraint.
- **Rate limiting & outage parking:** advisory per-contract KV throttles on generation/moderation call volume; backoff on provider 429s; moderation 429/outage fails closed — the job is marked `parked` in D1 and re-enqueued by the 15-min cron (outage-scale parking; queue retries are not burned on outages), with a buyer thread message after 3 failed attempts. Never open.
- **Security & secret handling:** API keys in wrangler secrets; the platform-issued webhook signing secret in D1; deliverable R2 keys are unguessable and served only through the Worker route; no secrets ever appear in deliverables, logs shipped to buyers, or contract messages.
- **Compliance:** mandatory moderation on inbound brief and outbound variants; checklist vX enforces client-specified prohibitions; verdict snapshots retained in D1 for the warranty window + dispute evidence.
- **Observability:** structured JSON logs (Workers Logs) with `service`/`botId`/`gigId`/`contractId`; `/health` exposes reputation snapshot; DLQ depth alerts via Telegram (`createAlerter` equivalent in the shim).
- **Performance:** ack `milestone.funded` in <1s; target end-to-end batch delivery in minutes (Haiku short-form latency dominates), with checkpoint-resume as the overflow path rather than a tighter-than-physics single-invocation promise.

## 13. Risks, Assumptions & Open Questions

| Risk / Assumption | Severity | Mitigation / Owner |
| --- | --- | --- |
| Meta's bulk-import template is undocumented-as-API, unversioned, and can change silently — template drift breaks the conformance gate. | Medium | Golden-file test before listing (Phase 1); monthly re-validation import; gate worded as "conforms to the validated import template (golden-file tested <stamped date>)", never "100% clean import". Owner: Diego Fernández. |
| Fresh Meta advertiser accounts get auto-restricted, blocking the golden-file test. | Medium | Use a real, **existing stakeholder ad account** — never a cold signup; secure access before build starts (Phase 1 gate). Owner: Diego Fernández. |
| No moderation API checks Meta ad policy — the "ad-policy" half of the gate rests entirely on the homegrown checklist. | Medium | Vendor pinned with eyes open (OpenAI Moderation, sole v1 vendor; Azure Content Safety and the platform's own moderation service as named *future swap candidates*, each requiring a checklist review + gig-terms version bump — not automatic failover); marketing/gig text never claims Meta-policy compliance; checklist vX + 21-day warranty carry Meta-rejection disputes; verdicts snapshotted with vendor + model/version at delivery. |
| Moderation vendor outage/429 on the money path. | Medium | Fail closed: job parked in D1 and re-enqueued by the 15-min cron (not burned against the 3 queue retries); buyer notified via contract thread after 3 failed attempts; DLQ + runbook for poison messages; never deliver unscreened copy. |
| Regeneration loop fails to converge on a stubborn brief (heavy policy constraints + tight voice). | Low | FR-5 hard caps + §9 contractual outcome (partial delivery ≥80% with batch gates intact, else abort + request payer cancellation). |
| **Abort path depends on payer or admin action** — cancellation/refund is payer-only (verified: REST `/contracts/:id/refund` and MCP `cancel_contract` both require the payer); the bot cannot refund escrow itself. | Medium | §9 wording promises only what the bot can do (deliver nothing, post evidence, *request* cancellation); unresponsive-payer escalation via the dispute/admin-refund path; gig terms say "will request cancellation and support a full refund", never "initiates". Owner: Diego Fernández. |
| Brief intake rides the gig description (no structured-brief channel); buyers may malform the embedded JSON or post corrections the bot must poll for. | Medium | Scorer skips unparseable/incomplete briefs pre-bid (never win un-intakeable work); post-funding corrections polled from the contract thread in the 15-min cron; Phase 2 exit proves a real buyer-posted brief round-trips into the queue consumer. |
| Grapheme counting still diverges from Meta's on-device "See more" truncation behavior below 125 chars. | Low | Warranty is scoped to grapheme limits + checklist only; truncation-display behavior is explicitly not warranted (no pixel language anywhere). |
| Shim drift vs the Fly reference bots (double-maintained lifecycle logic). | Low | Verify webhook HMAC via `@botguild/sdk`'s `verifyWebhookSignature` (shared with the platform SDK) and keep scorer/proposer/pricing as shared `agent-core` code; the shim holds transport/storage adapters plus the documented sync→async accommodations (negotiation memory hydrate/flush, secret-persist-from-return-value, cron-driven reputation refresh — §7). |
| Assumption: brand voice can be learned adequately from a supplied guide. | — | Brief accepts optional example copy; regeneration prompts feed gate failures back as constraints. |
| Assumption: buyers can supply campaign scaffolding + creative refs at intake. | — | Scorer skips incomplete briefs pre-bid; intake rejects with actionable errors. The "copy columns for your existing template" fallback framing is cut from v1 gig text (no gate wording exists for it — §8/§16); buyers who can't supply scaffolding are not v1 buyers. |
| Recurring tier depends on manual re-funding each cycle (platform has no subscriptions). | Low | Daily cron + thread-message nudges make re-funding one click; conversion tracked as a KPI, not assumed. |

## 14. Build Plan & Milestones

**Phase 0 — Preconditions (non-code, starts day 1, blocks listing not building):**
- Handler API key issued from the dashboard (manual early-access step). *Exit: key with `read`, `proposals:write`, `bots:write` scopes works against production API.*
- Access confirmed to an existing stakeholder Meta ad account for import testing. *Exit: a team member can run a bulk import in that account's Ads Manager.*
- Moderation vendor pinned by decision record: OpenAI Moderation sole v1 vendor (Azure Content Safety as the named future swap candidate). *Exit: decision recorded in-repo; test call succeeds with the production key; current OpenAI Moderation ToS, pricing, and rate limits re-verified and captured in the decision record (pre-cutoff "free tier" assumption not carried forward unchecked), with Azure Content Safety fallback quota noted.*

**Phase 1 — Shim + golden file (days 1–3):**
- Build `packages/agent-core-workers` (D1 secret/negotiation stores with the §7 sync→async accommodations, `createWorkersWebhookApp`, `runGigPollSweep`, Workers logger) + `apps/voicewright-bot` skeleton (wrangler config incl. `nodejs_compat` + queue consumer settings, bindings, health). *Exit: the deployed Worker (agent-core bundling verified — Node-only imports tree-shaken out) registers the bot via the admin route, persists the signing secret to D1 with an awaited write + read-back, receives and HMAC-verifies a real platform webhook, and a cron sweep scores a test gig (with embedded JSON brief parsed) and submits a proposal.*
- **Golden-file validation (non-code):** hand-build one CSV on Meta's bulk-import template and import it into the stakeholder ad account. *Exit: import succeeds; the exact header set + template file are committed as the golden file with the test date; gig gate wording finalized from it.*
- Draft ad-policy checklist v1 and gig terms using §9's hardened wording. *Exit: checklist committed and versioned; gig terms reviewed against §9 (no pixel, no 100%-import, no Meta-approval language; abort wording says "request cancellation", never "initiates" — bot-side refund verified nonexistent; diversity threshold marked provisional pending Phase 2 calibration).*

**Phase 2 — Pipeline (days 3–6):**
- Queue consumer: brief intake/validation, brief moderation (fail-closed with D1 parking), Haiku generation, grapheme fit gate + capped regeneration, policy gate + verdict snapshots, deterministic diversity gate, CSV assembly + template schema validation, R2 upload, `deliverMilestone` with Worker-served links. *Exit criteria:* (1) a funded test contract on production goes end-to-end with all four hard gates evidenced in the JSON report, **starting from a real buyer-posted gig whose embedded brief round-trips into the queue consumer**; (2) one forced non-convergence run exercising the partial path *and* the abort leg — explanation posted, cancellation requested, payer-side cancel executed, escrow refund observed; (3) diversity threshold calibrated on ≥5 real generated batches (pass rate + regen burn measured) and the final number recorded for gig terms; (4) consumer wall-clock/CPU/subrequest counts measured on the end-to-end run including the forced worst-case regen run, confirming fit within limits or triggering the §12 fallback topology.

**Phase 3 — Funnel + recurring (days 6–7):**
- FREE readability gig (pinned `text-readability`, floor case handled) and the recurring tier (D1 brief store, `briefId` linkage in refresh-gig descriptions, daily refresh cron, per-contract idempotency, differs-from-prior-cycle gate). *Exit: free gig delivers score+rewrite with lib name/version; a simulated month-2 cycle joins a new funded contract to the stored brief via `briefId` and passes the prior-cycle diversity check.*
- List the seed gig publicly. *Exit: gig live with golden-file-dated gate wording and the Phase-2-calibrated diversity threshold finalized in gig terms; first organic proposal submitted.*

**Ongoing (operational):** monthly template re-validation import into the stakeholder account; checklist version bumps as Meta policy learnings accrue; DLQ monitoring + the §12 replay runbook.

*(Removed from the plan entirely vs v1.0: the Meta Marketing API upload phase — out of scope, see §2/§16.)*

## 15. Success Metrics & KPIs

- **Quality-gate pass rate:** ≥95% of batches clear all four hard gates within FR-5 caps (no manual intervention).
- **Template conformance:** 100% of delivered CSVs pass the golden-file template schema check; monthly re-validation import stays green (this replaces v1.0's "100% clean import first try" claim, which schema validation cannot guarantee against silent template drift).
- **Angle coverage:** 100% of batches pass the deterministic diversity floor.
- **Delivery latency:** `milestone.funded` ack <1s; batch delivered in <10 minutes p95 (leaves headroom inside the ~15-min consumer wall-clock cap; a checkpoint-resume continuation is measured, not a KPI breach).
- **Non-convergence rate:** <5% of batches hit the partial-delivery path; ~0 hit the abort/request-cancellation leg.
- **Gross margin:** ≥97% fleet-average on the $15 gig (a single cap-hitting batch bottoms at ~90% and does not breach the KPI).
- **Warranty-claim rate:** <2% of deliveries trigger a free revision within the 21-day window.
- **Recurring conversion:** a measurable share of $15 buyers re-fund the $50/mo refresh; each cycle passes the differs-from-prior gate.
- **Showcase goal:** first paid end-to-end contract (discover→paid) within 2 weeks of build start; shim reused by ThumbForge without modification.

## 16. Out of Scope / Future Work

- **Meta Marketing API draft upload** — out of v1 and out of the showcase narrative entirely (Business verification + `ads_management` App Review + per-client system-user tokens). Revisit only as a separately-priced add-on after the showcase.
- SERP/DataForSEO context enrichment — shipped dark (`SERP_ENABLED=false`); enable later as an enrichment, noting SERP-scraping ToS risk sits with the provider.
- Pixel/rendered-width validation of any kind.
- **Copy-columns-only gig variant** ("merge into your existing template") — cut from v1 gig text (§8); would need its own intake rule (campaign/creative optional), output definition (Body/Title/Link Description columns only), and gate wording excluding the template-conformance warranty.
- Google Ads export and Google-specific length rules.
- Long-form landing-page production (Sonnet path).
- Subscriptions/standing offers — dropped platform-wide; recurring remains a re-funded monthly gig.
- A brand-voice retainer companion that codifies a voice guide once and produces taglines/ad sets on cadence.
- The eve/CF-container execution path — VoiceWright is permanently Workers-native; ThumbForge and APICheck carry the container story.
