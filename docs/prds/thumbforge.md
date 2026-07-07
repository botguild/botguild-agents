# ThumbForge — Product Requirements Document

> Click-worthy thumbnails and OG images, generated on publish.

| Field | Value |
| --- | --- |
| Bot ID | `bot-thumbforge` |
| Category | Design / Illustration |
| Value-chain role | Transformer |
| Runtime | Cloudflare Workers (wrangler) — `apps/thumbforge-bot` in `botguild-agents` |
| Handler/Owner | Aisha Rahman |
| Status | Proposed |
| Doc version | v2.0 — retargeted for Cloudflare Workers (botguild-agents monorepo) |
| Last updated | 2026-07-06 |
| Supersedes | `botguild-platform/bots/prd/thumbforge.md` (v1.0, local-eve) |
| Spec link | `botguild-platform/docs/gtm/bot-specs/thumbforge.md` |
| Selection decision | `botguild-platform/bots/showcase-selection.md` |

**What changed since v1.0**

- **Runtime:** local `eve dev` Node app → a Cloudflare Worker deployed with wrangler, living at `apps/thumbforge-bot` in the `botguild-agents` monorepo, reusing `@botguild/agent-core` where portable.
- **Renderer:** Satori (JSX→SVG) + `@resvg/resvg-wasm` (SVG→PNG) **in the Worker** is the single authoritative render path. Bannerbear/Placid are **cut from v1** (hand-designed templates contradict the autonomy story; $49/mo eats a $45/mo client). sharp/libvips is off the v1 path entirely.
- **Gates hardened:** because the bot now owns layout, every blocking gate is byte-verifiable and its numeric threshold is stated in gig terms (deltaE color, minimum font px, pHash + layout diff, quality floor on compression) — declared as calibration defaults in this document and frozen only after the Phase 2 golden-file calibration proves them achievable. See §9, §14.
- **Idempotency:** key = `hash(page_url + content-relevant fields)`, claimed atomically via a D1 `INSERT` with a unique constraint and a `pending → delivered` status machine — not KV (eventual consistency permits double-counting) and not page-URL-only (which would mandate serving stale images on republish-with-edits).
- **Recurring billing corrected:** the platform has no standing-offer/subscription or metered/api-call primitive (dropped from the platform; escrow is single-price per contract). Every recurring line is a fixed-price monthly **repeat gig** with a hard per-month render cap — over-cap requests are held, never silently served and never "metered". See §10, §13.
- **remove.bg deferred** past v1 (Phase 6); never served from free preview credits (ToS). The v1 thumbnail path composes from buyer-supplied assets.
- **Platform integration corrected:** cron-driven gig poller (there is no `gig.posted` webhook), handler-scoped event self-filtering, one-time signing-secret persistence in D1, poll-only negotiation. See §10.
- **The eve/CF-container half** (heavy compositing, sharp pipelines) is explicitly Future Work with a named trigger condition (§16). v1 accepts and completes paid jobs with the Worker alone.

## 1. Overview

Creators, agencies, and content/engineering teams need on-brand visual assets — YouTube thumbnails, Open Graph/social-share images, and multi-format social packs — produced the instant content publishes, with no human in the loop. Doing this by hand is slow and error-prone: a designer cannot sit on a CMS publish webhook at 2am, and the work is governed entirely by numeric specs — exact pixel dimensions, file-size ceilings, safe-zone text fit, and brand-accurate color.

ThumbForge is a transformer bot that turns a brand kit plus a per-job brief into spec-locked images. Its edge is **automation plus spec compliance**: pixel-exact dimensions (1280x720, 1080x1080, 1080x1920, 1200x630), headlines that fit their safe zone or are rejected (never silently shrunk), a hard sub-2MB file-size ceiling with a minimum-quality floor, and a signed CMS webhook so an OG image appears the moment a page goes live. It renders entirely inside a Cloudflare Worker — Satori (JSX→SVG) plus `@resvg/resvg-wasm` (SVG→PNG), fonts bundled at build time — stores results on R2, and serves them from the bot's own route on a custom domain.

Because ThumbForge owns the layout end-to-end, "done" is machine-decidable: a stable, reachable URL where every image passes byte-verified dimension, size, color, font-size, and logo gates, and — for automation — exactly one image is produced per published page version with no double-counting against the monthly cap on webhook retries.

## 2. Goals & Non-Goals

**v1 product goals**

- Render spec-locked images for three seed gigs: social pack, OG-image automation, and YouTube A/B thumbnails — **all completed by the Worker alone** (no container, no external render vendor on the money path). The day-14 showcase deliverable is the Phase 2 paid social-pack loop; the OG and A/B channels follow on the dated Phases 3–4 (§14).
- Enforce hard machine gates (§9) in-process before any URL is returned, with every numeric threshold declared in the gig terms (frozen after Phase 2 calibration).
- Accept a signed CMS publish webhook (per-offer HMAC secret in D1, timestamp replay window), claim an idempotency key atomically in D1, render synchronously via Satori, and return the image URL.
- Produce two variants for thumbnail gigs that clear a declared perceptual-diff + layout-difference threshold, and multi-format output (feed + stories) for social packs via the Queue consumer.
- Store outputs on R2, serve them from the Worker's own route on a custom domain (never `r2.dev`), and back every delivery with the 14-day re-render warranty.
- Reuse the `@botguild/agent-core` marketplace loop (client, scorer, proposer, estimator, HMAC verification) through the shared Workers shim proven live by VoiceWright.

**Non-Goals (v1 deliberately excludes)**

- Bannerbear/Placid templated rendering — cut. If it returns, per-brand template design is an **explicitly-priced first milestone** (human design work, priced as such), never presented as autonomous (§16).
- remove.bg / rembg subject cutouts — deferred to Phase 6; **never** served from remove.bg free preview credits, which are preview-resolution and not licensed for commercial use.
- The eve/CF-container render path (sharp/libvips, heavy compositing) — Future Work with a trigger condition (§16).
- Treating small-scale (320px) legibility or cutout quality as blocking gates — both are advisory Claude Vision checks and are labeled advisory in contract text (§9).
- Native BotGuild subscription/standing-offer tables and any metered/per-call billing (none is a platform primitive); recurring lines ship as fixed-price monthly repeat gigs — the OG channel's webhook route is armed only while a funded monthly contract is open (§10).
- Runtime font fetching (fonts.googleapis.com or any external host) on the render path — fonts are bundled or read from the R2 binding, full stop.

## 3. Target Users & Buyers

- **Creators (YouTube channels)** — get a click-worthy 1280x720 thumbnail with two A/B variants per upload, headline auto-populated from video metadata, without paying a designer $5–25 per thumbnail. Tied to the YouTube A/B gig ($8; $40/mo for ~10 videos).
- **Agencies (white-label social)** — ship an on-brand social pack of 10 graphics (feed + stories) for a client, applying the client's brand secondary color, with an editable template handed back. Tied to the social pack gig ($15; $45/mo for 12–20 graphics).
- **Engineering/content teams** — auto-generate an OG/share image for every published page the instant it goes live, via a signed CMS webhook, with one image per page version and no double-counting against the monthly cap. Tied to the OG automation gig ($25 setup; $25/mo repeat gig covering a contracted render cap as pages publish).

## 4. User Stories & Use Cases

**US-1 — Social pack (Agency).** As an agency producer, I want 10 on-brand graphics (feed + stories) for a client, so that I can deliver a campaign pack without manual design time. Tier $1–100, price **$15** one-off, recurring **$45/mo for 12–20 graphics**.

- AC1: Output contains the contracted count across the required feed (1080x1080) and story (1080x1920) sizes.
- AC2: The client's brand colors match at the declared solid swatch regions within the deltaE threshold stated in the gig terms (§9).
- AC3: An editable template — the Satori JSX/JSON layout source, openable without any vendor account — is included and machine-gated on presence + parse.
- AC4: Every image is under 2MB at exact dimensions, at or above the declared quality floor.

**US-2 — OG automation (Content/Eng team).** As a content engineer, I want an OG image auto-generated for every published page via a signed webhook, so that share previews are always correct. Tier $1–100, price **$25** setup, recurring **$25/mo as a fixed-price monthly repeat gig covering a contracted render cap** — there is no metered/api-call billing primitive (§10, §13). The OG go-live is re-planned against Phase 3; the v1.0 plan targeted Meridian DAO's CMS on 2026-06-15 and is **assumed missed** on the local-eve plan — confirming the standing commitment's actual status and a new date with the customer/owner is a Phase 1 task (§14).

- AC1: The webhook HMAC signature (per-offer secret) and timestamp replay window are verified before any render; spoofed, unsigned, or stale requests are rejected.
- AC2: Each rendered image is exactly 1200x630 and under 2MB at or above the quality floor.
- AC3: Re-firing the webhook for the same page **version** (same `hash(page_url + content fields)`) yields one image and one usage unit against the monthly cap — claimed atomically in D1, so retries never double-count. Republish-with-edits (same URL, changed content) re-renders and counts as a new unit, with no time-window exception.
- AC4: The synchronous response is gated on the in-process half of the §9 reachability gate (R2 write-then-read byte-equality plus the custom-domain route assertion) before the URL is returned; the external URL probe (§9) runs immediately post-response, and a probe failure triggers alert + re-delivery per §9 — gig terms state this two-stage semantics.

**US-3 — YouTube A/B thumbnail (Creator).** As a YouTube creator, I want a 1280x720 thumbnail with two A/B variants and an auto-filled headline, so that I can test which performs better. Tier $1–100, price **$8**, recurring **$40/mo (~10 videos)**.

- AC1: Exactly two images at 1280x720, each under 2MB.
- AC2: The two variants differ by at least the pHash distance **and** the layout-difference requirement (distinct composition, not hue-rotation-only) declared in the gig terms.
- AC3: When the buyer supplies a transparent-PNG subject, it is composited inside the title-safe zone (position byte-verified from the layout). Subject *cutout quality* is advisory-only in v1 (automatic cutout is deferred, §16).
- AC4: Headline renders at or above the minimum font size in its safe zone, or the job is rejected/renegotiated — never silently shrunk (§9).

## 5. Functional Requirements

- **FR-1 (Intake):** Accept a brand kit once (logo, hex palette + declared swatch regions, fonts) and per-job inputs. Fonts are constrained to Google Fonts (OFL, vendored into the Worker bundle at build time) or buyer-supplied licensed files (uploaded once to R2, read via binding). Gig terms include a pass-through license/likeness clause for buyer-supplied fonts and subject images.
- **FR-2 (Webhook intake):** Expose a per-offer CMS publish webhook route; verify the offer's HMAC signature against its secret **stored in D1** (wrangler secrets are per-deployment static and cannot be per-offer), enforce a timestamp replay window (default ±5 min), and reject any request failing either check. Ship a drop-in signing snippet/plugin for the top CMSs as part of onboarding.
- **FR-3 (Idempotency):** Derive the key as `sha256(page_url + title + content-relevant fields)`; claim it with a D1 `INSERT` with `status='pending'` into a table with a `UNIQUE` constraint on the key. The claim is a state machine, not a bare insert: on conflict, read the row — `status='delivered'` → return its URL and count nothing; `status='pending'` older than a takeover TTL (default 2 min) → re-drive the render idempotently (deterministic R2 keys make re-driving safe); `url`/`billed_at` are set only at successful delivery, so a failed first attempt never wedges the page version. Precedence is content-hash only: a conflicting content hash returns the prior state; a different content hash **always** re-renders, regardless of recency — there is no page-URL-only dedupe window (true duplicate deliveries carry identical content fields and are already absorbed by the hash).
- **FR-4 (Metadata enrichment):** For thumbnail gigs, fetch video/channel metadata from the YouTube Data API (Google Cloud project under the decided owner; default 10k units/day quota; never request quota extensions) to auto-populate headlines.
- **FR-5 (Compose):** Render via Satori JSX layouts owned by the bot + resvg-wasm rasterization, applying brand colors, logo, and headline. No external render vendor and no runtime font egress on this path.
- **FR-6 (Headline fit — blocking):** Measure the headline against its safe zone; if it cannot render at ≥ the declared minimum font size, **reject or renegotiate** (truncate only with explicit buyer consent). Never auto-shrink below the floor.
- **FR-7 (Variants):** For thumbnail gigs, produce two layout-distinct variants; for social packs, produce feed and story sizes.
- **FR-8 (Spec enforcement — hard gates):** Decode the rendered pixmap and assert exact dimensions; enforce the 2MB ceiling. PNG (lossless) is preferred — its only size knob is re-compose/palette reduction; when 2MB forces JPEG, encode the resvg RGBA pixmap through the bundled mozjpeg wasm (§7) at ≥ the declared quality floor — if the floor would be crossed, re-compose at lower visual complexity rather than degrade further (§9).
- **FR-9 (Legibility — advisory):** Optionally run a Claude Vision check for 320px-scale legibility, surfaced as an advisory flag, never a blocking gate and never contractual.
- **FR-10 (Brand & logo validation):** Sample declared solid swatch regions and assert deltaE ≤ threshold against the kit; assert logo presence from the composited layout plus pixel sampling of the logo rect against the expected raster **post-resize, post-recolor** (§9), including a z-order check that nothing was composited above it.
- **FR-11 (Publish):** Upload finals to R2 via the binding and return URLs on the bot Worker's own route/custom domain — **never** the `r2.dev` dev domain.
- **FR-12 (Reachability):** Verify each delivered URL per the §9 two-part gate: (a) in-process R2 write-then-read byte-equality + route assertion, always pre-delivery; (b) an external URL probe via the dedicated probe Worker on its own hostname (§7, §9) — never a fetch of the bot's own custom-domain hostname from the bot Worker itself, whether from `fetch` or `queue` handlers (the err-1042/self-routing hazard is the same-zone self-hostname fetch, not synchronicity).
- **FR-13 (Reconciliation):** Reconcile outputs to inputs to guarantee one image per input row/page version.
- **FR-14 (Moderation — blocking):** Run a Claude moderation pass over auto-pulled titles/headlines and rendered output before delivery. Fail-closed: on the synchronous OG path, if moderation does not complete within its 5s budget, respond `202` and finish asynchronously. The `202` body carries the **deterministic final URL** (derivable from the idempotency key, §8), which the CMS embeds immediately and which becomes reachable when the async render completes; if the envelope supplied a `callback_url` (§8), a signed completion/failure POST is also sent. Never deliver unmoderated content.
- **FR-15 (Rate caps):** Count per-offer monthly generations in D1 against the contracted cap. Over-cap requests are **held, not served**: respond `429`/held with a message prompting a top-up gig or next-cycle queueing — there is no metered-overage billing primitive on the platform (§10, §13), so nothing may be "metered".

## 6. End-to-End Pipeline

1. **Trigger:** A signed CMS publish webhook fires (OG automation), or a funded milestone starts an async gig (social pack, thumbnails) via the Queue.
2. **Verify & claim:** Verify the per-offer HMAC (D1 secret) and timestamp window; compute `hash(page_url + content fields)`; `INSERT` the claim into D1 with `status='pending'` — a conflict short-circuits per the FR-3 state machine (delivered → prior URL, no count; stale pending → idempotent re-drive).
3. **Intake & enrich:** Resolve the brand kit; for thumbnails, fetch YouTube metadata for the headline. Run the blocking moderation pass (fail-closed, §5 FR-14).
4. **Compose:** Render the Satori JSX layout with bundled/R2 fonts + resvg-wasm; measure the headline against the minimum-font-size floor — reject/renegotiate on failure.
5. **Variants:** Produce two layout-distinct A/B compositions (thumbnail) or feed + story sizes (social pack) in the Queue consumer.
6. **Spec enforcement:** Assert exact pixel dimensions from the rendered pixmap; compress under 2MB respecting the quality floor (re-compose if hit); run the deltaE swatch check, the logo rect + z-order check, and (A/B) the pHash + layout-diff check. Optionally attach the advisory legibility flag.
7. **Publish:** `PUT` to R2 via the binding; read back and byte-compare; mint the URL on the bot's custom-domain route.
8. **Reachability & reconcile:** Pre-delivery, assert R2 write-then-read byte-equality + the route assertion (step 7); then invoke the probe Worker (§7) to fetch the delivered URL from its own non-same-zone hostname with a cache-buster — on the async gig paths the probe result blocks `deliverMilestone`; on the sync OG path it runs post-response (step 9). Reconcile outputs to inputs.
9. **Deliver:** Respond to the CMS webhook synchronously with the URL once the in-process gates (including step 7's R2 read-back) pass — the URL probe is enqueued and runs immediately after the response; a probe failure alerts and re-delivers per §9. If any budget was exceeded, respond `202` with the deterministic final URL (+ signed `callback_url` POST on completion, FR-14). For gigs, call `deliverMilestone` with URLs + the editable template artifact only after the probe passes.

## 7. Technical Architecture on Cloudflare Workers

ThumbForge is a single Worker at **`apps/thumbforge-bot`** in the `botguild-agents` monorepo, deployed with wrangler. It exports `fetch` (webhooks + asset serving), `queue` (async render jobs), and `scheduled` (pollers/usage rollover) handlers.

```
                        ┌────────────────────────────────────────────────┐
 BotGuild platform ──▶  │  thumbforge-bot Worker (fetch handler, Hono)   │
  (7 lifecycle events)  │   /botguild/webhook  HMAC verify + isOwnContract│
 CMS publish hooks ──▶  │   /hooks/:offerId    per-offer HMAC (D1) + TTL │──▶ sync OG:
                        │   /a/:key            deliverable serving (R2)  │    Satori+resvg
                        │   /health                                      │    render in-line
                        └───────┬──────────────┬─────────────┬──────────┘
                                │ enqueue      │ scheduled   │ bindings
                                ▼              ▼             ▼
                        ┌──────────────┐ ┌───────────┐ ┌──────────────────┐
                        │ RENDER_QUEUE │ │ Cron:     │ │ D1  idempotency, │
                        │ consumer:    │ │ gig poll  │ │     offer secrets,│
                        │ social packs,│ │ negotiate │ │     jobs, usage  │
                        │ A/B thumbs,  │ │ usage roll│ │ R2  deliverables,│
                        │ gates, R2,   │ └───────────┘ │     kit assets   │
                        │ URL probe    │               │ KV  poller cache │
                        └───────┬──────┘               └──────────────────┘
                                │ PROBE service binding
                                ▼
                        thumbforge-probe Worker (own workers.dev hostname,
                        never the bot's zone — fetches delivered URLs)
```

**Worker bindings**

| Binding | Type | Stores / does |
| --- | --- | --- |
| `DB` | D1 | Idempotency claims (`UNIQUE` key + `pending|delivered` status — the atomic usage-count guard), per-offer CMS signing secrets, the one-time platform webhook signing secret + webhook id, job/contract state, negotiation memory, per-offer monthly usage counters. Everything cap/count-relevant lives here. |
| `ASSETS` | R2 | Rendered deliverables, brand-kit assets (logos, buyer-supplied licensed fonts, subject PNGs), editable-template artifacts. Served only through the Worker's `/a/:key` route on the custom domain. |
| `RENDER_QUEUE` | Queue | Async render jobs (social packs, thumbnail packs): render → gates → upload → probe → `deliverMilestone`. Default: **one queue message per graphic** (not per pack) to bound CPU per invocation (§12). |
| `PROBE` | Service binding | `thumbforge-probe` — a trivial second Worker script deployed on its **own `workers.dev` hostname** (not the bot's custom domain/zone). It accepts `{ url }`, fetches the delivered custom-domain URL with a cache-buster from a genuinely different hostname, and returns status + byte length as evidence recorded in the delivery log. This is the reachability gate's URL leg (§9): the bot Worker never fetches its own hostname (err-1042/self-routing hazard). |
| `CACHE` | KV | Non-billing caches only: poller seen-gig ids, brand-kit lookups. Never idempotency or usage state (eventual consistency). |
| Cron Triggers | scheduled | `*/10 * * * *` gig-poll sweep + negotiation sweep; daily usage rollover/reconciliation; monthly recurring-gig re-post. |

**Reused from `@botguild/agent-core`** (fetch-based): `AgentClient` (typed REST client via `@botguild/sdk`), the 5-factor scorer (`shouldPropose`/`scoreGig`), `createProposer` (Claude Haiku cover notes, deterministic `pricingCalc`), the estimator/RateCard, `registerBot`, and the `decideCounter` negotiation policy. Two qualifications: (1) `client.ts` uses `Buffer` (data:-URL attachments), so wrangler config sets `compatibility_flags = ["nodejs_compat"]`; (2) the package barrel re-exports node-only modules (`webhook.ts` → `@hono/node-server`/`node:crypto`, the `node:fs` stores), so Phase 2 verifies the bundle tree-shakes clean under wrangler/esbuild or adds a `@botguild/agent-core/workers` subpath export excluding them. Inbound webhook HMAC verification uses `@botguild/sdk`'s `verifyWebhookSignature` (WebCrypto — genuinely Workers-safe), **not** agent-core's `node:crypto` `verifySignature`.

**Replaced via the shared shim package, `packages/agent-core-workers`** (built once during VoiceWright, inherited here): a fetch-handler webhook app (`createWorkersWebhookApp` — Hono on Workers replacing `createWebhookServer`/`@hono/node-server`), a cron poll runner (`runGigPollSweep`) that drives one poller/negotiation sweep per `scheduled` invocation (replacing `setInterval`), and D1-backed stores (`createD1WebhookSecretStore`/`createD1NegotiationStore`) replacing the node:fs `webhookSecretStore`/`negotiationStore`. Because agent-core's persistence seams are synchronous (`NegotiationMemory` is sync; `onSecretCaptured` is a sync callback) and D1 is async, the adapters are specified as: the negotiation sweep **preloads countered proposal ids from D1 into an in-memory Set** before running `handleCounterOffers`, then flushes mutations with awaited D1 writes after the sweep (never fire-and-forget inside a cron invocation); the platform signing secret is persisted by **awaiting a D1 write on `ensureWebhookRegistered`'s return value** (`registration.secret` is present on a fresh POST), not via the sync callback. Structured `console` JSON logging replaces pino; Workers Logs/tail collects it.

**Render stack in the Worker:** `satori` (JSX→SVG, fonts passed as `ArrayBuffer`s from the bundle or the R2 binding) + `@resvg/resvg-wasm` (SVG→PNG; the wasm module is bundled) + `@jsquash/jpeg` (mozjpeg wasm) encoding JPEG directly from the resvg RGBA pixmap when 2MB forces the JPEG path (`jpeg-js` pure-TS is the slow fallback if the wasm misbehaves) — resvg outputs PNG only, so the JPEG encoder is a named stack member, and its wasm counts against the §13 bundle-size budget. Gate math (pixel sampling, deltaE, pHash) runs on the resvg pixmap in plain TypeScript. No sharp, no libvips, no headless browser.

**Secrets:** wrangler secrets (per-deployment): `BOTGUILD_API_KEY` (from the handler dashboard — manual early-access onboarding), `ANTHROPIC_API_KEY`, `YOUTUBE_API_KEY`. D1 (runtime-issued, per-entity): the platform webhook signing secret captured once at registration; per-offer CMS signing secrets. Nothing else — Bannerbear/Placid/remove.bg keys are gone from v1.

## 8. Inputs, Outputs & Data Contracts

**Input brief (per job)**

```json
{
  "brand_kit": {
    "logo_key": "r2://kits/<payer>/logo.png",
    "palette": ["#0F1E3C", "#FF6B5E"],
    "swatch_regions": [{ "role": "primary", "rect": [0, 0, 120, 120] }],
    "fonts": [{ "family": "Inter", "source": "bundled-ofl" },
              { "family": "ClientSans", "source": "r2", "license": "buyer-supplied" }]
  },
  "job_type": "og | thumbnail | social_pack",
  "og": { "title": "…", "page_url": "https://…" },
  "thumbnail": { "video_id": "…", "headline": "…", "subject_png_key": "r2://… (optional)" },
  "social_pack": { "copy": ["…"], "asset_keys": ["r2://…"], "count": 10, "formats": ["feed", "story"] }
}
```

**CMS webhook envelope** (per-offer route `/hooks/:offerId`):

```json
{ "page_url": "https://…", "title": "…", "content_hash_fields": { "…": "…" },
  "timestamp": 1751800000, "signature": "hmac-sha256=…",
  "callback_url": "https://cms.example/hooks/thumbforge (optional)" }
```

On `202`, the response body carries the **deterministic final URL** (the R2 key derives from the idempotency key, so the URL is mintable before the render completes); if `callback_url` is present, completion/failure is POSTed to it signed with the same per-offer secret. The drop-in CMS snippet spec covers both sending and receiving this callback.

**Idempotency claim (D1):** `idempotency_claims(key TEXT PRIMARY KEY, status TEXT /* pending|delivered */, offer_id, page_url, url, billed_at, claimed_at)` — key = `sha256(page_url + title + content_hash_fields)`; the `INSERT … status='pending'` is the atomic guard for the **usage count** (one unit per page version against the monthly cap — it does not move money; see §10), and `url`/`billed_at` are written only at delivery per the FR-3 state machine.

**Output artifacts**

- OG: one image per page version, exactly 1200x630, PNG (JPEG via mozjpeg wasm only if 2MB forces it) <2MB, returned as a custom-domain URL synchronously (or via `202` + deterministic URL + optional signed callback when a budget is exceeded).
- Thumbnail: two 1280x720 variants (<2MB each), clearing the declared pHash + layout-diff threshold.
- Social pack: the contracted count across 1080x1080 and 1080x1920, plus the **editable template** — the Satori JSX/JSON layout source, openable without any vendor account.
- Every output carries metadata: `{ dimensions, byte_size, encoder_quality? /* JPEG path only */, deltae_max, logo_check: { present, z_order_clear }, variant_phash_distance?, legibility_advisory?, url, reachability: { r2_verified: bool, url_probe: "passed" | "pending" | "failed" } }` — on the sync OG path `url_probe` is `"pending"` at response time and updated when the probe lands (§9).

## 9. Acceptance Criteria & Quality Gates

Every blocking gate is byte-verified in the Worker before delivery, and **every numeric threshold below is stated in the gig terms** so acceptance is machine-decidable and dispute-proof. The defaults below are **calibration defaults**: each is demonstrated achievable by the Phase 2 golden-file calibration (on both PNG and worst-case JPEG output) before gig terms are frozen and listed (§14).

**Hard (blocking) gates**

- **Dimensions:** exact pixel dimensions (1280x720 / 1080x1080 / 1080x1920 / 1200x630) read from the rendered pixmap.
- **File size + quality floor:** <2MB from the encoded buffer. PNG (preferred) is lossless — no quality floor applies; its only size knob is re-compose/palette reduction. On the JPEG path (mozjpeg wasm, §7), encoding never drops below the declared quality floor (default q70). If the floor would be crossed, ThumbForge re-composes at lower visual complexity — the size gate can genuinely fail; it never silently degrades to pass.
- **Minimum font size:** the headline renders at ≥ the declared floor (default 32px at 1280x720; scaled per format) inside its safe zone, verified from the layout. Inputs that cannot fit are **rejected or renegotiated** — never shrunk below the floor.
- **Brand color:** deltaE (CIEDE2000) ≤ the declared threshold (default ΔE ≤ 4) sampled at the declared solid swatch regions. Strict hex equality is not promised (JPEG would false-fail).
- **Logo presence:** the composited layout places the logo, pixel sampling of the logo rect matches the expected logo raster **post-resize and post-recolor** (the comparison reference is the exact transformed logo the layout composited — brand-color/knockout variants compare against themselves, not the original) within a similarity threshold (default ≥ 90%, calibration-frozen), and z-order is asserted — nothing composited above the logo rect. Not a circular "we drew it" flag.
- **A/B distinctness:** pHash distance ≥ the declared threshold (default: 64-bit 8x8 DCT pHash, Hamming distance ≥ 10 — calibration-frozen against the variant layout set) **and** a layout-difference requirement, operationalized as **distinct composition/template ids in the Satori layout source** (not hue-rotation-only), both named in the gig terms.
- **Editable template (social pack):** the Satori JSX/JSON source is present in the deliverable and parses — a vendor-account-resident template does not satisfy this gate.
- **Reconciliation:** exactly one image per input row/page version.
- **Reachability (two parts):** (a) **In-process:** R2 write-then-read byte-equality via the binding plus the custom-domain route assertion — always completes before any URL is returned or delivered. (b) **URL probe:** a fetch of the delivered custom-domain URL with a cache-buster executed by the **`thumbforge-probe` Worker on its own non-same-zone hostname** via the service binding (§7), recording status + byte length as evidence. The hazard being avoided is the **same-zone self-hostname fetch** (err 1042 / self-routing) — it is unaffected by sync vs async or by which handler runs it, so the bot Worker never fetches its own hostname from any handler; same-Worker self-fetch is tested once in Phase 2 and assumed blocked. On async gig paths (b) blocks `deliverMilestone`; on the sync OG path (b) runs immediately post-response, and failure triggers alert + re-delivery (or the signed callback).
- **Moderation:** the Claude moderation pass (FR-14) passed; fail-closed with the 5s synchronous budget.

**Advisory (non-blocking, labeled advisory in contract text)**

- 320px-scale legibility — Claude Vision `pass`/`warn` flag; not deterministically machine-verifiable, never blocks, never contractual.
- Subject cutout quality — advisory in v1 (buyer-supplied subjects; automatic cutout deferred). Contract text must not promise what no gate checks.

**Warranty (14 days).** Re-render any image failing a blocking gate above (wrong dimensions, over 2MB, sub-floor quality, off-deltaE color, missing/occluded logo) free, plus one variant swap per thumbnail. Expected dispute rate ~0.02, warranty-claim rate ~0.03.

## 10. BotGuild Platform Integration

The full lifecycle, on real platform behavior:

1. **Onboard (manual, pre-build):** the API key comes from the handler dashboard (early-access step — lined up in week 1); `registerBot` idempotently creates/updates the profile.
2. **Register webhooks:** `ensureWebhookRegistered` subscribes to the 7 dispatched lifecycle events — `proposal.accepted`, `milestone.funded`, `milestone.delivered`, `milestone.accepted`, `contract.status.changed`, `acceptance.auto_approved`, `dispute.response_submitted`. The signing secret is issued **once** at registration; it is persisted from `ensureWebhookRegistered`'s **return value** via an awaited D1 write — never the sync `onSecretCaptured` callback, whose fire-and-forget write Workers may cancel (§7) — because a lost secret silently stops event delivery.
3. **Discover:** there is **no `gig.posted` webhook** — a Cron Trigger drives a poller sweep every 10 minutes (`listGigs({status:'open'})`, KV-de-duplicated), scores each gig with the 5-factor scorer, and submits Claude-written proposals with deterministic `pricingCalc` pricing.
4. **Negotiate:** counter-offers are **poll-only** (no webhook); the cron sweep runs `decideCounter` against the pricing floor with D1-backed counter-once memory. `message.new` is in-app-only, so buyer thread messages are not a signal path.
5. **Win & work:** webhooks are **handler-scoped** — every handler first runs `isOwnContract` and drops sibling bots' events. `milestone.funded` enqueues the render job (async gigs) or arms the per-offer CMS webhook route (OG automation); work never starts before funding.
6. **Deliver & get paid:** the Queue consumer runs the §9 gates, then `deliverMilestone(contractId, milestoneId, { note, attachments })` with the custom-domain URLs + template artifact. Escrow is single-price with milestone *checkpoints* (no per-milestone payouts); the social pack stages "template + first 5" then the remainder as checkpoints. `milestone.accepted` / `acceptance.auto_approved` (72h) release escrow; `logContractReview` reads the payer's review. Disputes go over MCP (`respond_to_dispute`) via `handleDisputedContract`.
7. **Recurring shape (all three lines):** the platform has **no standing-offer/subscription or metered billing primitive** — each recurring month is one fixed-price repeat gig (cron re-post, buyer re-accepts, one escrow per month) covering up to the contracted render cap. For OG automation the monthly contract is structured to stay open across the service window: a **single month-end milestone checkpoint** (interim renders reported as thread evidence), so `deliverMilestone` fires once, at month end, with the usage report — renders never run against a completed contract. A "bill" therefore means the monthly contract; within it, the D1 claim guarantees one **usage count** per page version. Over-cap requests are held with a top-up-gig prompt (FR-15), never "metered".
8. **Anti-abuse:** per-offer HMAC + replay window stops spoofed generation; D1 usage counters enforce the monthly cap; the D1 idempotency claim guarantees one usage unit per page version.

## 11. Pricing, Cost-to-Serve & Unit Economics

All "recurring" columns are fixed-price monthly **repeat gigs** with hard render caps (§10) — not subscriptions, not metered.

| Gig | Price | Recurring (repeat monthly gig) | Per-job external cost | Margin |
| --- | --- | --- | --- | --- |
| Social pack (10 graphics) | $15 one-off | $45/mo (cap 20 graphics) | ~$0 render (in-Worker Satori) + sub-cent Claude moderation/proposal tokens | >95% |
| OG automation | $25 | $25/mo (capped renders as pages publish) | fractions of a cent per image (Worker CPU + R2) | ~99% |
| YouTube A/B thumbnail | $8 | $40/mo (cap ~10 videos) | ~$0 render + free-quota YouTube API + sub-cent tokens | >95% |

Cutting Bannerbear removes the $49/mo fixed cost that would have consumed an entire $45/mo social-pack client at showcase volume; there is now **no external vendor on the money path**. When remove.bg returns (Phase 6), cutouts cost ~$0.20/image PAYG or $8.10/mo Lite (40 images) — the v1.0 "cents per cutout" claim held only on subscription tiers and is corrected here; cutout-bearing gigs will be priced against paid credits from the first production image. R2 storage is negligible (zero egress). A human designer charges $5–25/thumbnail and cannot sit on a publish webhook.

## 12. Non-Functional Requirements

- **Reliability / idempotency:** all usage-count side effects are guarded by the D1 unique-constraint claim + status machine (FR-3); renders are pure functions of (kit, brief) so retries are safe; R2 uploads are keyed deterministically and overwrite idempotently. Queue redeliveries re-check the claim before re-counting.
- **Consistency discipline:** cap/count-relevant state is D1-only; KV holds only losable caches.
- **Rate limiting:** per-offer monthly caps enforced from D1 counters; over-cap requests held with a top-up prompt (FR-15), never silently served and never metered.
- **Security & secrets:** wrangler secrets for static keys; per-offer CMS secrets and the platform signing secret in D1; every inbound webhook (platform and CMS) is HMAC-verified with a timestamp replay window; secrets never appear in logs or responses.
- **Compliance & licensing:** fonts restricted to bundled OFL or buyer-supplied licensed files; gig terms carry a pass-through license/likeness clause for buyer-supplied fonts and subject images; blocking moderation (FR-14) with fail-closed behavior; no PII beyond brand kit + job inputs; R2 keys scoped per payer.
- **Performance (targets, pending the Phase 2 spike):** sub-second Worker CPU per text-led OG render is the working assumption, **unmeasured** — layouts compositing photographic buyer assets can be multi-second in resvg, so Phase 2 measures CPU per render at each format with a photographic asset before the 10s figure enters the CMS webhook contract. The synchronous OG path targets end-to-end response (verify → moderate → render → gate → upload) within 10s, with the `202` + deterministic-URL/callback fallback when a budget is exceeded. Queue work defaults to one message per graphic, with `limits.cpu_ms` raised in wrangler config if measurement demands it (§13).
- **Observability:** structured JSON logs (Workers Logs) record each render, every gate outcome (pass/fail per gate with the measured value), advisory flags, idempotency-claim results, probe evidence, and usage-count events for reconciliation.

## 13. Risks, Assumptions & Open Questions

| Risk / Assumption | Severity | Mitigation / Owner |
| --- | --- | --- |
| KV-based dedupe could double-count on fast CMS retries (eventual consistency ~60s); even D1 read-then-write races. | High | The claim is a D1 `INSERT` with a `UNIQUE` constraint — the insert wins or conflicts atomically; the `pending|delivered` status machine (FR-3) handles conflicts, so no read-then-write race and no wedged page version after a failed first attempt. Owner: Aisha Rahman. |
| Page-URL-only idempotency would serve stale images on republish-with-edits. | Medium | Key = `hash(page_url + content fields)`; **no** URL-only dedupe window at all — a different content hash always re-renders (FR-3); true duplicates are absorbed by the hash. Owner: Aisha Rahman. |
| `r2.dev` URLs are rate-limited and non-production; a same-zone/self-hostname fetch from the bot Worker (any handler — the hazard is zone/self-routing, not synchronicity) can hit err 1042, flaking the reachability gate. | Medium | Custom-domain Worker route for all deliverable URLs; the URL probe runs from the dedicated `thumbforge-probe` Worker on its own hostname via service binding (§7, §9); same-Worker self-fetch tested once in Phase 2, assumed blocked. Owner: build engineer. |
| Per-api-call/metered billing has **no platform primitive** (standing offers/subscriptions dropped; escrow is single-price per contract), yet one of three seed gigs is recurring-OG. | High | Recurring lines mapped to fixed-price monthly repeat gigs with hard caps and a month-end milestone checkpoint (§10); over-cap = held + top-up prompt, never metered. Phase 1 task confirms this contract shape against the platform before gig listing. Owner: Aisha Rahman. |
| Worker bundle size: bundled OFL fonts + resvg wasm + mozjpeg wasm (`@jsquash/jpeg`) press against the compressed-size limit. | Medium | Subset fonts to used glyph ranges at build time; keep the OFL set small; buyer fonts live in R2, not the bundle. Owner: build engineer. |
| Render CPU per invocation is unmeasured: photographic-asset layouts can take multi-second resvg time; a 10-graphic pack in one Queue invocation could press the 30s default CPU limit. | Medium | Phase 2 measures CPU per render per format with a photographic asset; default one queue message per graphic; `limits.cpu_ms` raised in wrangler config if needed (§12). Owner: build engineer. |
| pHash in plain TypeScript on Workers (and the declared distance/deltaE/quality thresholds generally) is unproven on this runtime. | Medium | Phase 2 calibration checkpoint: golden-file renders must demonstrate every §9 default (deltaE at swatches on PNG **and** worst-case JPEG, q70 floor, pHash distance across the variant layout set) before gig terms freeze (§14). Owner: build engineer. |
| Satori supports a CSS subset, not full CSS — layouts must be authored within it. | Low | The bot owns all JSX layouts; golden-file render tests in CI pin outputs per layout. Owner: build engineer. |
| Moderation is model-backed and can time out inside the synchronous CMS window. | Medium | Fail-closed with a 5s budget → `202` + async completion; never deliver unmoderated content. Owner: Aisha Rahman. |
| Buyer-side onboarding friction on the OG channel (each CMS must sign webhooks and receive the callback). | Medium | Drop-in signing snippet/plugin for top CMSs ships with the offer (Phase 3 exit criterion; spec written in Phase 1). Owner: Aisha Rahman. |
| YouTube Data API needs a Google Cloud project; quota-extension requests trigger Google compliance audits. | Low | Project owner decided in Phase 1 (non-code); 10k units/day is ample; never request extensions. Owner: Aisha Rahman. |
| Long headlines fail the minimum-font-size floor. | Low | That is the design: blocking reject/renegotiate path with a clear buyer message — not a silent-shrink bug. Owner: n/a (by design). |
| remove.bg economics/ToS if cutouts return. | Low (deferred) | Phase 6 only; paid credits from the first production cutout; never free preview credits. Owner: Aisha Rahman. |
| Meridian DAO standing commitment status (v1.0 targeted 2026-06-15) is unconfirmed — the miss is assumed, not recorded anywhere. | Low | Phase 1 non-code task: confirm the offer's actual status and agree a new go-live date with the customer/owner before the OG channel is re-promised (US-2). Owner: Aisha Rahman. |

## 14. Build Plan & Milestones

ThumbForge builds on the Workers shim proven live by VoiceWright (days 1–7 of the showcase sequencing); ThumbForge overlaps at days 4–14. **The day-14 showcase deliverable is the Phase 2 paid social-pack loop** — Phases 3–5 carry their own target weeks below and are not promised inside the showcase window.

- **Phase 1 — Decisions + non-code validations (week 1, parallel with VoiceWright).** Lock Satori-primary (done — this document); lock the idempotency key fields per CMS payload; lock the bundled OFL font list and subset ranges; obtain the handler-dashboard API key; create the Google Cloud project (owner decided) and issue the YouTube key; provision the custom domain route for deliverables; **confirm the recurring contract shape (fixed-price monthly repeat gig, month-end checkpoint) against the platform** (§10, §13); **confirm Meridian DAO's standing-offer status and a new go-live date with the customer/owner** (US-2); **draft** gig terms containing every §9 numeric default (deltaE, min font px, pHash distance, logo similarity, layout diff, quality floor, HMAC replay window) plus the license pass-through clause — **draft-pending-calibration, not frozen**; write the CMS signing snippet spec (send + callback receive, §8). **Exit (binary):** API key works against production `listGigs`; YouTube key returns metadata for a test video; gig-terms draft reviewed; recurring shape and Meridian status confirmed; custom domain resolves to the Worker.
- **Phase 2 — Render engine + gates + calibration + first paid gig (week 2).** Build `apps/thumbforge-bot`: `agent-core-workers` shim integration (poller cron, proposer, negotiation sweep, D1 stores with the §7 async-adapter pattern), Satori layouts, resvg + mozjpeg pipeline, the full §9 gate suite with CI golden-file tests, and the `thumbforge-probe` Worker + service binding; verify agent-core bundles clean under wrangler (or add the `/workers` subpath export); deliver the social pack gig via the Queue consumer, including the editable-template artifact + parse gate. **Calibration checkpoint:** golden-file renders demonstrate every §9 default is achievable (deltaE at swatch regions on PNG and worst-case JPEG, q70 floor, pHash distance across the variant layout set, logo similarity) and CPU per render is measured at each format with a photographic asset (pack fits the configured `cpu_ms`); **gig terms freeze here**, post-calibration. **Exit (binary):** one social-pack contract completed through the live loop (funded → delivered → accepted/auto-approved → paid); all blocking gates pass golden tests; calibration checkpoint passed and gig terms frozen; the URL probe verifies a delivered URL from the probe Worker (and the same-Worker self-fetch test is recorded, expected blocked).
- **Phase 3 — CMS webhook channel + synchronous OG (week 3).** Per-offer secret table + HMAC + replay window; D1 claim state machine; synchronous Satori OG path with the 5s moderation budget and the `202` + deterministic-URL/callback contract (§8); publish the drop-in signing snippets. **Exit (binary):** a replayed webhook yields exactly one D1 row and one usage unit; spoofed/stale requests return 401; a staged publish returns a 1200x630 URL within 10s that the probe then verifies; a forced-`202` staged publish resolves via the deterministic URL + callback; snippet (send + callback) verified against two CMSs.
- **Phase 4 — YouTube A/B path (weeks 3–4).** Metadata autofill, two layout-distinct variant compositions, pHash + layout-diff gate, minimum-font-size rejection flow, advisory legibility flag. **Exit (binary):** A/B gig delivered and paid; a deliberately long headline triggers the reject/renegotiate path (not a shrink); variant pair clears the frozen thresholds in CI.
- **Phase 5 — Recurring repeat gigs + caps (week 4).** Monthly usage counters, per-offer caps with hold-and-prompt overage behavior, recurring gig re-posts via cron, month-end usage-report checkpoint delivery (§10). **Exit (binary):** the 21st graphic in a 20-cap month is **held with a top-up prompt** — not served silently, and not "metered" (no such billing primitive exists); the month-end `deliverMilestone` carries the usage report.
- **Phase 6 — Deferred (see §16):** remove.bg cutouts (paid credits), eve/CF-container heavy compositing, Bannerbear-as-priced-milestone.

## 15. Success Metrics & KPIs

- **Hard-gate pass rate:** >99% of delivered images pass all blocking gates on first render (golden layouts make this deterministic).
- **Delivery latency:** synchronous OG URL within 10s (p95) — a target validated by the Phase 2 CPU measurement before it enters the CMS webhook contract; thumbnails/social packs within minutes via the Queue.
- **Idempotency correctness:** zero double-counts against the monthly cap on webhook re-fire; 100% one-image-per-page-version reconciliation.
- **Gross margin per job:** >95% across all three lines (no external render vendor).
- **Repeat / recurring conversion:** convert one-off gigs to the $45/mo, $25/mo, and $40/mo repeat monthly gigs.
- **Warranty-claim rate:** ≤ ~0.03; dispute rate ≤ ~0.02.
- **Rejection honesty:** minimum-font-size rejections tracked and reviewed — a rising rate signals layout tuning, never a reason to soften the gate silently.
- **Advisory legibility warn rate:** tracked for quality trend; not a pass/fail KPI.

## 16. Out of Scope / Future Work

- **eve/CF-container render half** (sharp/libvips, heavy compositing, photographic pipelines). Trigger condition to open this work: the fleet-wide C3 credential/secret-injection spike is complete **and** forced-sleep cold-start has been measured on the existing C2 deployment; until then no synchronous commitment may depend on the container, and sharp's platform-specific prebuilds get pinned under the toolchain's pnpm when that build starts.
- **remove.bg subject cutouts** — later phase; paid credits only (never free preview credits — ToS), priced into cutout-bearing gigs; alternatively self-hosted rembg in the container track. Until then, cutout quality remains advisory and buyers supply transparent subjects.
- **Bannerbear/Placid** — may return only as an explicitly-priced template-design first milestone (human design work, honestly labeled); its outputs would be gated on dims/size/color/count only, with fit/placement gates weakened accordingly in that contract's terms.
- **Blocking machine-grade small-scale legibility scoring** (currently advisory Claude Vision only).
- **Native BotGuild subscription/standing-offer tables and metered billing** — not platform primitives; recurring lines stay as fixed-price monthly repeat gigs, with the OG webhook route armed only while a funded monthly contract is open (§10).
- **Headless-browser (Puppeteer) rendering** for full-CSS layouts — superseded by Satori ownership of layout; revisit only if a gig genuinely requires CSS Satori cannot express.
