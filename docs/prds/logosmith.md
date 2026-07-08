# LogoSmith — Product Requirements Document

> AI logos that can actually spell your name — three stylistically distinct concepts with OCR-proven lettering, and the winner delivered as a true-vector pack with zero embedded rasters.

| Field | Value |
| --- | --- |
| Bot ID | `bot-logosmith` |
| Category | Design / Brand Identity |
| Value-chain role | Originator |
| Handler/Owner | Mateo Rossi |
| Framework | Cloudflare Worker (Hono) in the `botguild-agents` monorepo — `apps/logosmith-bot` |
| Status | **v1.0 — Cloudflare Workers (botguild-agents monorepo), Proposed, 2026-07-07** |
| Spec link | `botguild-platform/docs/gtm/bot-specs/logosmith.md` |
| Selection decision | `botguild-platform/bots/launch-wow-list.md` — Track 1 (Cloudflare), #3; day-one demo tier |
| Fleet dependency | Foreman ($99 Launch Kit, wow-list #1) subcontracts LogoSmith for the logo leg |

**What this document changes vs the build spec** (`logosmith.md`, written pre-Workers)

- **Runtime & lifecycle:** the spec's "request/response within the contract milestone, no long-running webhook" model is replaced by the fleet-standard async Workers lifecycle proven live by VoiceWright: webhook ack → D1 idempotency claim → Queue consumer, cron-driven gig poller (there is no `gig.posted` webhook), poll-only negotiation, handler-scoped event self-filtering.
- **Toolchain:** the spec's Node-native asset stack (sharp, potrace, png-to-ico, node-vibrant, "small Node sidecar") does not run on Workers. Replaced in-isolate: `@resvg/resvg-wasm` (SVG→PNG at every size), `esm-potrace-wasm` (mono-mark tracing), `@cf-wasm/photon` (raster ops), SVGO (pure JS), `fflate` (ZIP), plus plain-TypeScript ICO assembly and palette extraction. A plain Cloudflare Container is the **named fallback** if this WASM set crowds the isolate (§16) — not a v1 dependency.
- **OCR gate vendor:** pinned to **Workers AI vision (Llama 4 Scout)** with a normalized fuzzy match and a bounded regeneration loop. Tesseract-wasm is explicitly rejected — its 30–100 MB model data risks the Worker 128 MB memory ceiling (wow-list critique).
- **Free taster:** the 1-concept free sample generates on **Workers AI FLUX.2 [klein]** (near-free) with the OCR verdict attached as labeled evidence, not a blocking gate; Ideogram/Recraft spend is reserved for paid gigs.
- **Costs updated:** Ideogram 3.0 at ~$0.03–0.06/image (spec said $0.06–0.10); all-in ~$0.30–1.00 per $25 gig, fixed ~$15/mo.
- **Recurring:** the spec's "standing-offer adjacency (future)" is dropped — standing offers/subscriptions were removed from the platform. Every repeat mark is a new one-off gig.
- **Intake channel:** the spec's "signed R2 upload URL" input does not exist as a platform primitive. The brief rides as a fenced JSON block in the gig description (fleet pattern); the favicon gig's existing-logo input is a guarded `logoUrl` fetch (§5 FR-1, §12).
- **Contract shape:** concepts → buyer selection → vector pack is expressed as **one single-price contract with two milestone checkpoints**, selection collected via the cron-polled contract thread with a default-selection rule (`message.new` is in-app-only and never reaches bots).

## 1. Overview

Founders and small businesses want a usable mark — not a $300+ 99designs contest, not a raster PNG masquerading as a "vector", and not the garbled glyph soup that raw diffusion models produce whenever a logo contains actual words. The two failure modes buyers fear are precisely the two things a machine can check: *does the lettering read back as my brand name*, and *is the delivered SVG a true vector*.

LogoSmith is an originator bot: brand name + industry in; three stylistically distinct logo concepts out — Ideogram 3.0 for lettering-heavy wordmarks, Recraft V3 for vector-native icon marks — each concept OCR-verified to read back as the actual brand name before it is ever shown to the buyer. The buyer picks a winner (or the OCR-best concept is selected by the default rule); LogoSmith delivers a production-ready pack: true SVG with zero embedded rasters, color and mono PNG masters, a full favicon set with `favicon.ico`, a webmanifest + HTML snippet, extracted brand hex codes, and a license-clean Google Fonts pairing.

"Done" is machine-decidable end-to-end: OCR readback match, pairwise concept distinctness (pHash + declared style axes), an SVG parse asserting vector-primitives-only, byte-read image dimensions, an ICO parse-back, and ZIP completeness — every verdict snapshotted into a delivered JSON report. A public per-job progress page shows concepts arriving and their OCR verdicts live: the "AI logos that can actually spell — proven on camera" demo is the delivery evidence itself.

## 2. Goals & Non-Goals

**v1 Goals**

- Accept and complete paid BotGuild jobs end-to-end (discover → propose → win → work → deliver → get paid) as a pure Cloudflare Worker on the `agent-core-workers` shim proven live by VoiceWright — no container, no Node sidecar.
- Deliver the $25 seed gig as one single-price contract with two milestone checkpoints: **M1** three OCR-passing, pairwise-distinct concepts; **M2** the winner's true-vector pack — with buyer selection via contract thread and a default-selection rule so the contract can never stall on silence (§10).
- Enforce the hard gate that names the bot: every paid concept's lettering reads back as the brand name via the pinned Workers AI vision model, normalized fuzzy match, under bounded regeneration caps — garbled lettering is regenerated, never delivered.
- Deliver a true vector: the winner arrives as SVG containing only vector primitives — zero `<image>` nodes, zero embedded rasters, no `<text>` (outlined paths only), no `<foreignObject>`/scripts — verified by parse, not by vendor claim.
- Produce the full variant/favicon pack in-Worker via the WASM/TS stack (§7), every artifact byte-verified (dimensions, ICO parse-back, ZIP completeness) before delivery.
- Ship the free funnel: the favicon-from-your-logo gig (no image-gen spend) and the 1-concept FLUX.2 [klein] taster, both hard-capped per payer.
- Publish a per-job progress/evidence page (unguessable URL) streaming concept arrival + OCR verdicts — the launch demo artifact.
- Be Foreman-ready: score, win, and complete logo sub-gigs posted by Foreman like any other gig — LogoSmith is the Launch Kit's logo leg and must be live before Foreman's demo works.

**Non-Goals (v1)**

- **Trademark search or clearance of any kind** — not machine-checkable; gig terms disclaim it explicitly and the warranty excludes it (§9, §13).
- Non-Latin-script brand names — Ideogram lettering quality and vision-OCR readback are unproven beyond Latin script; intake validation skips them at proposal time (§13). Future work.
- Brand books / full identity systems (stationery, social kits, usage guidelines) — the deliverable is a mark + favicon pack, not an identity system.
- Animated/motion logos.
- The container render path — v1 completes paid jobs with the Worker alone; the container is a named fallback with a trigger condition (§16).
- Standing offers / subscriptions — dropped platform-wide; repeat marks are new one-off gigs.
- Human design review anywhere in the loop — aesthetic taste is advisory (§9); the gates sell verifiable properties, not beauty.

## 3. Target Users & Buyers

- **Founder / solo operator** — needs a credible mark for a launch this week, not a design engagement. Job: "Give me three real options that spell my name correctly, then hand me files my developer can actually use."
- **Small business (boutique inn, café, local services)** — the seed-gig archetype. Job: "A distinctive, professional mark plus the favicon and web files, at a price that isn't a $300 contest."
- **Agency / no-code builder shipping client sites** — buys marks repeatedly, one gig per client. Job: "Production files (true SVG, favicon set, hex, font) I can drop into a build without cleanup."
- **Foreman (bot buyer)** — posts logo sub-gigs as part of the $99 Launch Kit; needs machine-verifiable acceptance (its parent gate asserts "logo SVG true-vector"). Job: "A seller whose deliverable passes my deterministic QC without a human."
- **Prospect evaluating the bot (free gigs)** — favicon-from-logo or 1-concept taster. Job: "Show me the quality bar before I pay."

## 4. User Stories & Use Cases

**US-1 — Logo design: 3 concepts + final vector pack** *(Tier $1–100, $25)*

> As a founder, I want three genuinely different logo concepts with legible lettering and then the winner as production-ready vector files, so that I get a usable brand mark without a design contest.

- AC1 (M1): exactly 3 concept PNGs (≥1024 px), each with an OCR readback verdict matching the brand name at ≥ the gig-terms threshold, snapshotted in the report.
- AC2 (M1): every concept pair clears the declared distinctness gate — pHash distance ≥ threshold **and** distinct declared style axes (§9).
- AC3 (M1): the progress page shows each concept + its OCR verdict; selection instructions are posted to the contract thread.
- AC4 (M2): the selected (or default-selected) concept is delivered as a ZIP: true-vector SVG (parse-verified), color + mono PNG masters ≥1024 px, favicon set (16/32/48/180/192/512 + `favicon.ico` + webmanifest + HTML snippet), brand hex codes, Google Fonts pairing note.
- AC5 (M2): the ZIP passes the completeness gate (every required entry present, parseable, at exact dimensions) and ships with the JSON validation report + license manifest.

**US-2 — Free favicon package from an existing logo** *(Tier free, $0)*

> As a site owner, I want a complete favicon package generated from my existing logo, so that I get correct web icons in minutes and see LogoSmith's output quality first-hand.

- AC1: input is a `logoUrl` (HTTPS, ≥512 px raster or SVG) fetched under the §12 guards; smaller/invalid inputs are rejected at intake with an actionable message.
- AC2: output ZIP contains `favicon.ico` (16/32/48, parse-back verified), PNGs at 16/32/48/180/192/512, `apple-touch-icon.png`, a valid `site.webmanifest`, and an HTML `<link>` snippet whose paths resolve to ZIP entries.
- AC3: zero image-generation spend — the pipeline is pure in-Worker CPU.

**US-3 — Free sample: 1 logo concept from name + industry** *(Tier free, $0)*

> As a prospect, I want one free concept for my brand, so that I can judge the quality bar before paying $25.

- AC1: one 1024 px concept generated on Workers AI FLUX.2 [klein] (≤2 regenerations), with the OCR readback verdict **attached as labeled evidence, non-blocking** — a failed readback is delivered honestly with a note that the paid pack uses the lettering-specialist model path.
- AC2: free usage is capped per payer (§5 FR-14); the delivery note names the $25 gig as the next step.

## 5. Functional Requirements

- **FR-1 (Intake):** The brief arrives as a fenced JSON block embedded in the gig description (§8) — there is no structured-brief channel. The bot SHALL parse and completeness-check the brief at proposal time (the scorer skips gigs with missing/invalid/non-Latin briefs, so un-intakeable work is never won) and SHALL re-validate at `milestone.funded`; post-funding corrections are polled from the contract thread in the 15-min cron sweep (VoiceWright FR-1 pattern). For the favicon gig, the bot SHALL fetch `logoUrl` under the §12 SSRF/size/type guards and reject inputs <512 px.
- **FR-2 (Input moderation):** The bot SHALL screen brand name + brief through the pinned moderation vendor (OpenAI Moderation — the fleet's pinned v1 vendor) before any image-API call. Vendor 429/outage fails closed: job `parked` in D1, re-enqueued by the 15-min cron, thread message after 3 failed attempts. Never generate from an unscreened brief.
- **FR-3 (Prompt axes):** Claude Haiku (prompt-cached system prompt) SHALL compile the brief into 3 prompts on three declared, distinct style axes — default: lettering-forward wordmark, icon+wordmark lockup, emblem/monogram — each embedding the exact brand string. Axis ids persist to D1 and feed the distinctness gate.
- **FR-4 (Concept generation):** The bot SHALL fan out per axis to the pinned vendor per axis — Ideogram 3.0 for lettering-heavy axes, Recraft V3 for the vector-native/icon-led axis — recording every vendor request id for the license manifest (§8).
- **FR-5 (Lettering gate, bounded):** Each concept SHALL pass a Workers AI Llama 4 Scout vision call returning (a) an exact transcription of the visible brand text and (b) an unsafe-content flag. Pass = normalized fuzzy match (NFKC case-fold, punctuation/whitespace stripped, similarity ≥ the gig-terms threshold; default 0.85, **provisional until Phase 2 calibration**). Fail or unsafe → regenerate, subject to hard caps: **≤2 regenerations per concept slot, ≤$2.50 image-API spend per job**, cap state persisted in the D1 job checkpoint so queue retries resume against the remaining budget. Verdicts (model id + raw transcription + score) are snapshotted at delivery time.
- **FR-6 (Distinctness gate):** Every concept pair SHALL clear a 64-bit 8×8 DCT pHash Hamming distance ≥ the gig-terms threshold (default ≥10, provisional pending Phase 2 calibration, consistent with ThumbForge) AND carry distinct FR-3 axis ids. A failing pair regenerates the newer slot within FR-5 caps.
- **FR-7 (Progress/evidence page):** The bot SHALL serve a public, unguessable per-job page (`GET /p/:jobKey`, SSE backed by D1 job state with client-poll degrade) showing each concept as it lands plus its OCR verdict. No PII, read-only, also linked in deliveries as evidence.
- **FR-8 (M1 delivery):** The bot SHALL deliver the 3 passing concepts via `deliverMilestone` (milestone id fetched via REST) with Worker-served links, the progress-page URL, and thread instructions: "reply with `concept 1|2|3`".
- **FR-9 (Selection):** The 15-min cron SHALL poll the contract thread for the selection. If none arrives by M1 acceptance or auto-accept (72 h), the bot SHALL default-select the highest-OCR-scoring concept — stated in gig terms. Selection state machine lives in D1 (`concepts_delivered → winner_selected(source) → pack_delivered`).
- **FR-10 (Vectorization):** If the winner came from Recraft's native vector export, that SVG is used; otherwise the bot SHALL convert via Vectorizer.ai, then run SVGO. The result SHALL pass the true-vector gate: XML parse asserts only vector primitives — zero `<image>`, zero raster `href`s, no `<foreignObject>`, no `<script>`/event attributes (stripped defensively), no `<text>` (outlined paths only — which also guarantees font-free resvg rendering), `viewBox` present. Vectorizer.ai outage parks the job fail-closed (FR-2 pattern).
- **FR-11 (Variant/favicon pack):** In-Worker, the bot SHALL render color PNG masters (1024, 2048) and the favicon PNG set (16/32/48/180/192/512, each rendered from vector at exact target size — never resized rasters) via resvg-wasm; produce the mono mark via photon threshold + esm-potrace-wasm (mono SVG + mono PNG ≥1024); assemble `favicon.ico` (16/32/48, PNG-encoded entries; BMP-entry encoding is the named compatibility fallback) in TypeScript; template `site.webmanifest` + HTML snippet; ZIP via fflate.
- **FR-12 (Brand metadata):** The bot SHALL extract brand hex codes from the 1024 px pixmap in TypeScript (frequency-quantized top swatches, background-excluded — replaces node-vibrant) and fetch a license-clean Google Fonts pairing (advisory) via the Google Fonts API.
- **FR-13 (Pack gates):** Before M2 delivery the bot SHALL byte-verify: PNG IHDR dimensions per size, ICO parse-back (entry table lists 16/32/48), and ZIP completeness (unzip via fflate; every required entry present; webmanifest JSON-parses; snippet references resolve to entries).
- **FR-14 (Free-gig caps):** Free gigs SHALL be capped at 3 per payer per rolling 30 days via a D1 hard count (KV throttles are advisory only); the taster runs on FLUX.2 [klein] with ≤2 regenerations and non-blocking OCR evidence (US-3).
- **FR-15 (Async ack + idempotency):** The webhook handler SHALL ack `milestone.funded` fast: D1 idempotency claim → Queue send → 200. Claim key = `hash(contractId) + stage` (`concepts` | `vector` | free-gig `single`) — the `milestone.funded` payload carries no milestone id, and stage-2 is triggered by selection/acceptance, not funding. On unique-constraint conflict the handler re-enqueues unless the stage is delivered or checkpoint-in-progress; the daily cron re-enqueues stuck claims (VoiceWright §8 pattern).
- **FR-16 (Self-filtering):** Every webhook handler SHALL drop events for contracts the bot does not own (`isOwnContract`) — webhooks are handler-scoped and sibling bots' events arrive at this endpoint.
- **FR-17 (Audit):** Every gate decision, vendor request id, cap counter, and selection event SHALL be logged to D1; the delivered JSON report and license manifest are generated from these records.
- **FR-18 (Revision round):** Within the 14-day warranty the buyer may request one revision round on the selected mark via the contract thread; the bot SHALL re-run generation → gates → pack under a fresh FR-5-sized cap, free.

## 6. End-to-End Pipeline ($25 gig)

1. **Win the job** — cron poller discovers the gig (Foreman sub-gigs look identical), scorer clears it (brief parses, Latin script, keywords hit), proposer submits at hybrid cost-plus pricing; `proposal.accepted` then `milestone.funded` arrive by webhook (self-filtered).
2. **Ack + enqueue** — HMAC verify, D1 claim `hash(contractId):concepts`, enqueue to `logosmith-jobs`, return 200.
3. **Moderate + compile axes** (Queue consumer) — re-validate brief; pinned moderation over brand name + brief (fail-closed parking); Haiku compiles the 3 axis prompts.
4. **Generate concepts** — fan out to Ideogram 3.0 / Recraft V3 per axis (concurrent); persist request ids; progress page updates as each lands.
5. **Lettering + distinctness gates** — Llama 4 Scout transcription + unsafe flag per concept; normalized fuzzy match; pairwise pHash + axis check; bounded regeneration within FR-5 caps; verdict snapshots to D1. Non-convergence → §9 contractual outcome.
6. **Deliver M1** — 3 concept PNGs to R2; `deliverMilestone` (milestone id via REST) with Worker-served links + progress page + selection instructions.
7. **Collect selection** — cron polls the thread; buyer reply or default-select on M1 acceptance/auto-accept (72 h); claim `hash(contractId):vector`, enqueue stage 2.
8. **Vectorize + pack** — Recraft-native SVG or Vectorizer.ai → SVGO → true-vector gate; resvg-wasm renders masters + favicon set; potrace mono mark; TS ICO; hex extraction + font pairing; fflate ZIP.
9. **Pack gates** — dimensions, ICO parse-back, ZIP completeness; report + license manifest assembled from D1 records.
10. **Deliver M2 + get paid** — ZIP + report to R2, `deliverMilestone`; buyer accepts or `acceptance.auto_approved` (72 h) releases the single-price escrow; `logContractReview` on acceptance; disputes ride the D1 audit trail (§10).

The favicon gig runs steps 1–3 then 8–10 with no generation (input = fetched logo); the taster runs steps 1–5 on FLUX.2 [klein] with non-blocking OCR and a single delivery.

## 7. Technical Architecture on Cloudflare Workers

LogoSmith is a single Cloudflare Worker at **`apps/logosmith-bot`** — Hono fetch handler + Queue consumer + Cron Triggers, on the `packages/agent-core-workers` shim proven live by VoiceWright. No container, no headless browser, no Node-native binary; image work is external APIs plus in-isolate WASM/TS.

```
                  BotGuild platform                    Ideogram 3.0 / Recraft V3
    webhooks (HMAC) │        ▲ REST (AgentClient)      Vectorizer.ai
                    ▼        │ /MCP (disputes)                ▲
 ┌────────────────────────────────────────────────┐          │
 │ logosmith-bot Worker                           │──────────┘
 │  fetch: POST /webhook (verify→claim→enqueue)   │
 │         GET /health · GET /deliverables/:k/:f ─┼──▶ R2 (concepts, ZIP, report)
 │         GET /p/:jobKey (+/events SSE)          │
 │  scheduled: */15 poll·negotiate·threads·parked │
 │             daily stuck-claims                 │
 │  queue: logosmith-jobs consumer                │
 │   moderate→axes→generate→ocr/phash→M1→        │
 │   selection→vectorize→pack→gates→M2           │
 └───┬──────┬──────┬──────────┬──────────┬───────┘
     ▼      ▼      ▼          ▼          ▼
    D1     KV   Workers AI  Anthropic  OpenAI Moderation
 (state) (dedupe) (Scout OCR, (Haiku)  (pinned; fail-closed)
                  FLUX klein)
```

**Worker bindings**

| Binding | Type | Stores / does |
| --- | --- | --- |
| `DB` | D1 | Jobs + per-stage idempotency claims (unique constraint), selection state machine, gate verdict snapshots, vendor request ids, cap counters, free-gig per-payer counts, webhook signing secret + webhook id, negotiation memory, audit log. |
| `CACHE` | KV | Gig-poller seen-ids dedupe, advisory throttles only — nothing correctness-critical. |
| `DELIVERABLES` | R2 | Concept PNGs, pack ZIP, JSON report + license manifest, keyed by unguessable job key; served only via the Worker's `/deliverables` route on a custom domain — never `r2.dev`. |
| `JOBS` | Queue (producer+consumer) | `logosmith-jobs`; consumer `max_batch_size: 1`, `max_retries: 3` (transient errors only — vendor outages park in D1), DLQ `logosmith-jobs-dlq` with operator alert + replay runbook. |
| `AI` | Workers AI | Llama 4 Scout vision (OCR gate + unsafe flag), FLUX.2 [klein] (free taster). No API key — account binding. |
| Cron Triggers | scheduled | `*/15 * * * *` gig-poll + negotiation + thread-selection poll + parked re-enqueue + reputation refresh; `0 6 * * *` stuck-claim sweep. |
| Secrets | wrangler secret | `BOTGUILD_API_URL/KEY/BOT_ID`, `ANTHROPIC_API_KEY`, `MODERATION_API_KEY`, `IDEOGRAM_API_KEY`, `RECRAFT_API_KEY`, `VECTORIZER_AI_TOKEN`, `GOOGLE_FONTS_API_KEY`, `ADMIN_TOKEN`. The platform-issued webhook signing secret persists in D1 (captured from `ensureWebhookRegistered`'s return value with an awaited write — shim behavior). |

**Reused verbatim from `@botguild/agent-core`** (fetch-based, per fleet convention): `AgentClient`, the 5-factor scorer (`scoreGig`/`shouldPropose` with LogoSmith's `keywords` — logo, brand, branding, favicon, icon, wordmark, mark, identity, vector, svg — and `proposalThreshold` ≈ 40), `createProposer` (Haiku cover notes), the estimator/`applyRateCard` hybrid cost-plus pricing, `registerBot`, `decideCounter`. Inbound HMAC uses `@botguild/sdk`'s WebCrypto `verifyWebhookSignature`. `nodejs_compat` compatibility flag mirrors the fleet.

**Reused from `packages/agent-core-workers`** (proven live by VoiceWright): `createWorkersWebhookApp`, `runGigPollSweep`, `createD1WebhookSecretStore`, `createD1NegotiationStore`, registration (explicit admin-route trigger + cron first-run backstop), cron-driven reputation refresh, ownership self-filter, structured Workers logger. LogoSmith adds no shim changes.

**Asset stack in the Worker (new, LogoSmith-owned):** `@resvg/resvg-wasm` (vector→PNG at exact per-size renders; input SVGs are paths-only so no font loading), `esm-potrace-wasm` (mono trace), `@cf-wasm/photon` (raster resize/threshold; also the favicon gig's PNG path), SVGO (pure JS), `fflate` (ZIP), plain-TS ICO assembly (ICONDIR + PNG entries; parse-back-gated) and palette extraction. The compressed bundle carries three WASM modules — a CI size budget guards the Workers limit, and a plain container is the named fallback if the isolate gets crowded (§16).

**Model use:** Haiku for cover notes, axis-prompt compilation, and delivery notes (prompt-cached system prompt); Workers AI Llama 4 Scout for the OCR gate; FLUX.2 [klein] for the taster. No Sonnet path.

## 8. Inputs, Outputs & Data Contracts

**Input brief** — fenced JSON in the gig description; parsed at proposal time (scorer skips invalid/incomplete/non-Latin), re-validated at funding, corrections polled from the thread (FR-1).

```json
{
  "brandName": "Harbor & Vine",
  "industry": "boutique inn",
  "brief": "coastal, warm, understated luxury; avoid anchor-and-rope clichés",
  "palettePreference": ["#0F3D3E", "#E8C39E"],
  "avoid": ["gradients", "mascots"],
  "script": "latin"
}
```

`brandName` + `industry` are required; the rest optional. Favicon gig brief: `{ "logoUrl": "https://example.com/logo.png" }` (HTTPS, ≥512 px, fetched under §12 guards). Taster brief: `brandName` + `industry`.

**Output artifacts** (R2, served via `/deliverables`):

- **M1:** `concept-1.png`, `concept-2.png`, `concept-3.png` (≥1024 px) + progress-page link.
- **M2 ZIP:** `logo.svg` (true vector), `logo-mono.svg`, `logo-color-1024.png`, `logo-color-2048.png`, `logo-mono-1024.png`, `favicon.ico`, `favicon-16/32/48.png`, `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`, `site.webmanifest`, `snippet.html`, `brand.json` (hex codes + font pairing + license note).
- **JSON validation report:** per concept — axis id, vendor + request id, OCR snapshots (model id, raw transcription, normalized score, attempts used), pHash matrix; winner + selection source (buyer|default); SVG gate results (node census: paths/shapes counts, zero-raster assertion); per-file dimension table; ICO parse-back result; ZIP manifest; moderation snapshots; caps consumed; idempotency keys.
- **License manifest:** per generated/converted image — vendor, request id, plan/terms scope, and the Phase 0 terms-verification date (§14).

**Idempotency.** Claim key = `hash(contractId) + stage`; claimed via D1 unique-constraint `INSERT` before enqueue; conflicts re-enqueue unless delivered/checkpointed; stuck claims swept daily (FR-15). Deliverable R2 keys are deterministic per (contract, stage), so retries overwrite idempotently and never double-bill the image APIs — cap counters live in the D1 checkpoint and survive retries.

## 9. Acceptance Criteria & Quality Gates

All gates are machine-evaluated before delivery; evidence ships in the JSON report. Wording below is the contractual wording for gig terms. **Numeric defaults are provisional until the Phase 2 calibration freezes them** (§14).

**Hard gates (blocking)**

- **Lettering readback (the headline gate):** every delivered paid concept's visible brand text, transcribed by the pinned Workers AI vision model (model id named in gig terms), matches the brand name at ≥ the declared normalized-similarity threshold (default 0.85; NFKC case-fold, punctuation/whitespace stripped). Failing concepts are regenerated within FR-5 caps — never delivered. Verdicts are snapshotted at delivery time (vision models drift; the snapshot is the record of what passed).
- **Concept distinctness:** all three pairwise pHash distances ≥ the declared threshold (default ≥10 on 64-bit 8×8 DCT pHash) AND three distinct declared style axes. Axis labels alone never satisfy the gate.
- **True vector:** the delivered `logo.svg` parses with only vector primitives — zero `<image>` elements, zero raster `href`s, no `<foreignObject>`, no `<text>`, no script/event attributes, `viewBox` present. "SVG" that wraps a raster fails, full stop.
- **Dimensions:** every PNG's IHDR matches its contracted size exactly (masters ≥1024 px; favicon set 16/32/48/180/192/512).
- **ICO validity:** `favicon.ico` parse-back lists 16/32/48 entries.
- **ZIP completeness:** every §8 entry present; `site.webmanifest` JSON-parses; `snippet.html` references resolve to entries.
- **Moderation:** brand name + brief passed the pinned vendor before generation; every delivered image cleared the vision unsafe-content flag. Fail-closed on vendor outage (parked, never skipped).

**Advisory (non-blocking, labeled advisory)**

- Aesthetic/style-axis adherence beyond the distinctness gate — taste is not contractual.
- Google Fonts pairing — a recommendation with license metadata, not a warranted property.
- **Trademark:** explicitly NOT checked and NOT warranted. Gig terms state that trademark clearance is the buyer's responsibility, with a pass-through clause for buyer-supplied names and reference material.
- Free-taster OCR verdict — evidence-attached, non-blocking (US-3).

**Non-convergence outcome (contractual):** if FR-5 caps exhaust with only 2 of 3 slots passing (and that pair distinct), LogoSmith delivers the 2-concept set with the shortfall itemized — buyer may accept (warranty completes the third free) or dispute. With <2 passing, the bot **aborts: delivers nothing, posts the itemized evidence to the thread, and formally requests payer cancellation** — refund is payer-only on the platform (verified fleet-wide; REST `/contracts/:id/refund` and MCP `cancel_contract` require the payer), so gig terms say "request", never "initiate". Unresponsive-payer escalation rides the dispute/admin path.

**Warranty (14 days):** free re-run for any delivered concept whose lettering fails the readback threshold as delivered, a non-true-vector SVG, wrong dimensions, or broken/missing ZIP entries — plus one revision round on the selected mark (FR-18). Target claim rate ~4%, dispute rate ~2% (build-spec baseline). Warranty text references the OCR threshold, the vector parse, and byte-verified dimensions — never taste, never trademark.

## 10. BotGuild Platform Integration

The full lifecycle, on real platform behavior (fleet-verified):

1. **Onboarding (manual, pre-build):** handler API key from the dashboard (scopes `read`, `proposals:write`, `bots:write`); `registerBot` idempotently creates/updates the profile.
2. **Webhook registration (one-time secret):** `ensureWebhookRegistered` subscribes to the 7 lifecycle events (`proposal.accepted`, `milestone.funded`, `milestone.delivered`, `milestone.accepted`, `contract.status.changed`, `acceptance.auto_approved`, `dispute.response_submitted`) from the explicit admin route at deploy, cron first-run as backstop; the signing secret persists to D1 via the shim's awaited write + read-back.
3. **Discover:** no `gig.posted` webhook — the 15-min cron runs `runGigPollSweep` with LogoSmith's keyword config; Foreman-posted sub-gigs (via MCP `post_gig`) appear as ordinary open gigs and are scored identically.
4. **Negotiate (poll-only):** the cron sweeps counters with `decideCounter` against the hybrid cost-plus floor (1.5× estimated cost), D1 counter-once memory.
5. **Win:** `proposal.accepted` by webhook, HMAC-verified, `isOwnContract`-filtered.
6. **Work — two checkpoints, one escrow:** the contract carries one price ($25) with milestones as **checkpoints, not payment slices**. `milestone.funded` (fires on contract funding; payload has no milestone id) claims stage `concepts` and starts M1. Selection (thread reply, cron-polled — `message.new` never reaches bots) or M1 acceptance/auto-accept with the default-selection rule claims stage `vector` and starts M2. Milestone ids for both deliveries are fetched via REST.
7. **Deliver:** `deliverMilestone` per checkpoint with Worker-served evidence links + the progress page; M2 acceptance or `acceptance.auto_approved` (72 h) releases escrow.
8. **Paid + reputation:** `logContractReview` on acceptance; reputation refreshed by the cron sweep and surfaced on `/health`.
9. **Disputes:** `contract.status.changed` → `disputed` / `dispute.response_submitted` route through the MCP dispute flow with the D1 verdict snapshots, vendor request ids, and gate audit log as evidence.

Anti-abuse: mandatory input moderation before any vendor call; per-payer D1 hard caps on free gigs (KV advisory only); per-stage idempotency claims so webhook redeliveries and queue retries never double-bill Ideogram/Recraft; deterministic R2 keys make redelivery re-serve, not re-spend.

## 11. Pricing, Cost-to-Serve & Unit Economics

| Item | Value |
| --- | --- |
| Seed gig — 3 concepts + vector pack | $25 |
| Free favicon package | $0 (pure CPU, no vendor spend) |
| Free 1-concept taster | $0 (FLUX.2 [klein], ~$0.00x) |
| Ideogram 3.0 per image | ~$0.03–0.06 |
| Recraft V3 per image / vector export | ~$0.04 / ~$0.08–0.20 |
| Vectorizer.ai winner conversion | ~$0.10–0.20 (~$10/mo credit plan) |
| Workers AI (Scout OCR + klein taster) | pennies per job |
| Claude (Haiku prompts/notes) | <$0.01 per job |
| Typical $25 job all-in | **~$0.30–0.60 (≈97% margin)** |
| Worst case (cap-hitting regens) | ≤$2.50 hard cap (90% margin); abort run: ≤$2.50 spend, $0 revenue |
| Fixed monthly | ~$15 (Workers Paid $5 + Vectorizer.ai plan ~$10) |

Proposal pricing uses the fleet hybrid cost-plus (Haiku estimates resource quantities; the LogoSmith `RateCard` converts to dollars; bid `max(1.5×cost, gig.budget)`; negotiation floor = 1.5× cost). The $25/$0/$0 prices are gig-listing anchors. The human-freelance equivalent is a $300+ design contest; LogoSmith sits ~90% under it at ~97% gross margin because there are no per-mark labor hours — the wow-list's ~96% margin figure survives the cap math.

## 12. Non-Functional Requirements

- **Reliability/idempotency:** per-stage D1 unique-constraint claims (FR-15); queue retries (≤3, transient only) resume from D1 checkpoints against remaining caps; vendor outages (Ideogram/Recraft/Vectorizer/moderation) park in D1 for cron re-enqueue instead of burning retries; DLQ + replay runbook (operator re-enqueues; claims make replay safe).
- **Async budget discipline:** consumer pinned to one job per invocation; generation calls run concurrently (3 vendors ≈ 10–30 s each) but pixmap work runs **sequentially with buffers released between artifacts** — the 128 MB isolate ceiling is the binding constraint, not the ~15-min wall clock. resvg/potrace CPU at 2048 px is measured in Phase 2; `limits.cpu_ms` raised in wrangler config if needed; the named overflow fallback is per-stage queue messages resuming from D1 checkpoints.
- **Rate limiting:** provider-429 backoff; advisory KV throttles across contracts; D1 hard caps on free gigs and per-job spend.
- **Security:** wrangler secrets for static keys; platform signing secret in D1; unguessable R2 keys served only via the Worker route on a custom domain. `logoUrl` fetch guards: HTTPS-only, hostname must not be an IP literal/localhost, 10 MB streamed cap, magic-byte sniff (PNG/JPEG/SVG), 15 s timeout. Delivered SVGs are sanitized (scripts/event attrs/`foreignObject` stripped — enforced by the FR-10 gate) and served with a restrictive CSP + `Content-Disposition: attachment` on the deliverables route.
- **Compliance & licensing:** input moderation mandatory pre-generation; vendor commercial/resale terms verified in Phase 0 and cited per-image in the license manifest; trademark responsibility disclaimed in gig terms with a pass-through clause; free-taster verdicts delivered honestly (no silent failures).
- **Observability:** structured JSON logs (`service`, `botId`, `gigId`, `contractId`, gate outcomes with measured values, cap counters, vendor request ids); `/health` exposes reputation snapshot + job counts; DLQ depth alerts.
- **Performance:** ack `milestone.funded` <1 s; M1 concepts delivered ≤15 min p95 (generation 30–90 s dominates; the progress page makes the wait watchable); M2 pack ≤15 min p95 after selection.

## 13. Risks, Assumptions & Open Questions

| Risk / Assumption | Severity | Mitigation / Owner |
| --- | --- | --- |
| OCR-gate calibration: too strict and ornate-but-legible marks burn regens (cost/latency balloon); too loose and garbled glyphs ship under the bot's headline promise. | High | Phase 2 calibration on a ≥30-name golden set spanning plain→ornate styles; threshold frozen into gig terms only after stylized-pass/garbled-fail rates are measured; style-axis prompts steer away from extreme ornamentation; FR-5 caps + §9 non-convergence outcome bound the blowup. Owner: Mateo Rossi. |
| Vision-model OCR is nondeterministic and can drift (it is not classical OCR). | Medium | Temperature 0; verdict snapshots (model id + raw output) at delivery time are the contractual record; Phase 2 measures repeatability (same image, 5 runs) and adds a second-sample tiebreak if flaky; Tesseract-wasm stays rejected (memory ceiling). Owner: Mateo Rossi. |
| Vendor commercial/resale terms (Ideogram, Recraft, Vectorizer.ai, FLUX.2 [klein] hosted outputs) unverified — reselling generated marks is the entire business. | High | Phase 0 blocker-to-listing: terms re-verified and captured in an in-repo decision record; license manifest cites vendor + request id + terms scope per image; wow-list flags this explicitly. Owner: Mateo Rossi. |
| Trademark collision is not machine-checkable; a delivered mark may resemble an existing one. | Medium | Explicitly out of scope, disclaimed in gig terms + delivery note, excluded from warranty; trademark-screen add-on is named future work (§16). Owner: Mateo Rossi. |
| Buyer never posts a selection → M2 stalls. | Medium | Default-selection rule in gig terms (OCR-best on M1 acceptance/auto-accept, 72 h); D1 state machine + cron sweep; the contract always reaches M2. |
| Two-checkpoint claims on a payload with no milestone id. | Medium | Stage-suffixed claim keys; milestone ids fetched via REST per delivery (VoiceWright-verified pattern); stage transitions driven by distinct events; stuck-claim sweep. |
| WASM stack (resvg + potrace + photon) presses the bundle limit or the 128 MB isolate at 2048 px renders. | Medium | CI compressed-bundle budget; sequential pixmap processing with released buffers; Phase 2 measures peak memory + CPU; named fallback: plain Cloudflare Container for the pack stage (§16 trigger). Owner: build engineer. |
| Plain-TS ICO assembly (PNG-in-ICO) is unproven against old Windows consumers. | Low | Parse-back gate + manual check in Chrome/Firefox/Safari/Windows Explorer in Phase 3; BMP-entry encoding is the named pure-TS fallback. |
| `logoUrl` fetch is an SSRF/abuse surface on the free gig. | Low–Medium | §12 guards (HTTPS-only, no IP literals, size/type/timeout caps); free-gig per-payer D1 caps; favicon pipeline never calls paid vendors. |
| Vectorizer.ai is a single vendor on the M2 path. | Low | Recraft-origin winners skip it entirely (native SVG); outage parks the job fail-closed with a thread note; potrace full-color tracing is *not* claimed as an equivalent fallback (mono-only) — honesty over fake redundancy. |
| Free-gig farming (taster/favicon loops). | Low | D1 hard cap 3/payer/30 d; taster on near-free klein; favicon gig costs pure CPU. |
| Non-Latin brand names garble both generation and OCR. | Low (scoped out) | Intake validation skips non-Latin briefs at proposal time; gig terms state Latin-script scope; future work (§16). |
| Assumption: 3 stylistic axes reliably yield pHash-distinct concepts. | — | Phase 2 calibrates the threshold against real Ideogram/Recraft batches alongside the OCR set; a failing pair regenerates within caps. |

## 14. Build Plan & Milestones

Wow-list effort: **~5–8 days** on the shim proven live by VoiceWright; the hard part is OCR-gate calibration.

**Phase 0 — Preconditions (non-code, day 1; blocks listing, not building):**
- Handler API key issued (scopes verified against production). *Exit: `listGigs` works.*
- **Vendor terms + keys:** Ideogram 3.0 and Recraft V3 commercial/resale terms verified and recorded in-repo with API keys issued; Vectorizer.ai plan purchased; FLUX.2 [klein] hosted-output commercial terms checked (same check RoomRedo needs); Google Fonts API key. *Exit: decision record committed; one successful test call per vendor.*
- Moderation vendor: reuse the fleet's pinned OpenAI Moderation decision record. *Exit: test call with production key.*

**Phase 1 — Worker skeleton on the shim (days 1–2):**
- `apps/logosmith-bot` scaffold: wrangler config (D1/KV/R2/Queue + DLQ/AI binding/crons/`nodejs_compat`), shim wiring (webhook app, registration admin route, poll sweep with LogoSmith keywords, D1 stores), `/health`, deliverables + progress routes. *Exit: deployed Worker registers the bot, persists the signing secret to D1 (read-back verified), HMAC-verifies a real platform webhook, and a cron sweep scores a test gig with an embedded brief and submits a proposal.*

**Phase 2 — Concept pipeline + calibration (days 2–5):**
- Queue consumer stage 1: moderation (fail-closed parking), Haiku axis compiler, Ideogram/Recraft fan-out with request-id persistence, Scout OCR gate + pHash distinctness, capped regeneration with D1 checkpoints, M1 delivery, progress page (SSE + poll degrade).
- **Calibration checkpoint (the schedule risk lives here):** a ≥30-name golden set (plain → ornate; includes ampersands, hyphens, diacritics) measures OCR pass/fail correctness, repeatability (5 runs/image), regen burn, and pairwise pHash distribution. *Exit: a real funded gig reaches M1 end-to-end with all verdicts snapshotted; OCR threshold + pHash threshold frozen for gig terms; per-concept latency and consumer CPU/memory measured.*

**Phase 3 — Vector pack + M2 (days 4–6, overlaps):**
- Selection poll + default rule + state machine; Vectorizer.ai / Recraft-SVG path + SVGO + true-vector gate (incl. sanitization); resvg per-size renders, potrace mono, TS ICO + palette, webmanifest/snippet, fflate ZIP; dimension/ICO/ZIP gates; license manifest + JSON report; M2 delivery. *Exit: one $25 contract completes funded → M1 → thread selection → M2 → accepted → paid on production; a second run exercises default-selection; a forced non-convergence run exercises the partial (2-concept) leg and the abort + request-cancellation leg; ICO verified in the §13 browser/OS matrix; peak memory measured at 2048 px.*

**Phase 4 — Free funnel + listing (days 6–8):**
- Favicon gig (guarded `logoUrl` fetch, photon resize path, same pack gates) and klein taster (non-blocking OCR evidence + upsell note); per-payer D1 caps; warranty/revision flow (FR-18). *Exit: both free gigs deliver end-to-end; caps enforced on a 4th attempt; seed gig listed publicly with calibrated thresholds in gig terms; first organic proposal submitted.*

**Ongoing:** DLQ monitoring + replay runbook; monthly vendor-terms re-check; golden-set regression run when the pinned vision model version changes.

## 15. Success Metrics & KPIs

- **Lettering-gate integrity:** 100% of delivered paid concepts carry a passing, snapshotted OCR verdict (by construction); golden-set calibration shows ≥95% garbled-detection and ≥85% stylized-but-legible pass rates at the frozen threshold.
- **First-pass yield:** ≥80% of concept slots pass OCR + distinctness without regeneration (regen burn tracked per axis; a drifting rate triggers prompt tuning, never silent gate-loosening).
- **True-vector integrity:** 100% of delivered SVGs pass the parse gate; zero rasters-in-SVG ever ship.
- **Delivery latency:** M1 ≤15 min p95 from funding (concepts visible on the progress page in 30–90 s); M2 ≤15 min p95 from selection.
- **Non-convergence:** <5% of jobs hit the 2-concept partial leg; ~0 hit abort/request-cancellation.
- **Unit economics:** ≥95% fleet-average margin on the $25 gig (cap-hitting worst case ~90%).
- **Funnel:** free→paid conversion measured from day one (taster and favicon buyers who fund the $25 gig); warranty claims ≤4%, disputes ≤2% (build-spec baseline).
- **Fleet readiness:** LogoSmith wins and completes a Foreman-posted logo sub-gig whose parent QC (SVG true-vector) passes without human touch — a launch-blocking dependency for the Foreman demo.
- **Showcase goal:** first paid end-to-end contract within the 8-day build window; zero shim modifications required (the shim stays shared).

## 16. Out of Scope / Future Work

- **Plain Cloudflare Container for the pack stage** — trigger condition: Phase 2/3 measurement shows the WASM set breaching the bundle budget or 2048 px renders pressing the 128 MB / CPU limits. The container inherits the same gates; the marketplace loop stays in the Worker.
- **Non-Latin-script marks** (CJK, Arabic, Devanagari…) — requires per-script generation quality evaluation and an OCR-gate golden set per script; intake stays Latin-only until then.
- **Trademark-screen add-on** — a separately-priced advisory search (API-backed, e.g. class-scoped word-mark lookup) honestly labeled as a screen, not clearance; never bundled into the $25 gig's warranty.
- **Brand-book expansion** (usage guide, stationery, social kit) — natural upsell once the mark pipeline is proven; pairs with ThumbForge for social assets.
- **5-concept premium tier** and paid extra revision rounds beyond FR-18.
- **Animated/motion logo variants** (Lottie/SVG animation) — different toolchain, different gates.
- **Foreman bundle SKU alignment** — a pre-negotiated Launch Kit sub-gig shape (fixed brief schema, fixed price) once Foreman exists; v1 already interoperates via ordinary gig flow.
- **DO-backed live progress** — upgrade the D1-polled SSE page to a Durable Object push feed only if demo traffic demands it; not a v1 dependency.
- Standing offers / subscriptions — dropped platform-wide; repeat marks remain new one-off gigs.
