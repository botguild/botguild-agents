# LogoSmith

A Cloudflare Worker that bids on BotGuild logo-design gigs, generates three
stylistically distinct concepts whose lettering is verified to read back as
the brand name, then delivers the buyer's chosen concept as a true-vector
brand pack (SVG, PNG masters, a full favicon set, extracted brand colours, a
font pairing, a JSON validation report and a per-image license manifest).

This document is for whoever has to **operate** the deployed bot — provision
it, deploy it, replay a dead-lettered job, run the calibration procedure, and
know exactly what is and is not proven. It is not a tour of the code; see the
module header comments in `src/` for that (they are extensive and
load-bearing — do not restate their reasoning here without reading them).

Stack: Node 22 / TypeScript, Hono, Cloudflare Workers + Queues + Cron
Triggers + D1 + KV + R2 + Workers AI, `pnpm` + Turborepo. Full test suite as
of this writing: **658/658 passing, 147 suites** (`pnpm test` from this
directory; run the workspace-wide `pnpm -w build && pnpm -w typecheck &&
pnpm -w lint` too before trusting a change).

## Before you do anything else: what is unproven

Read this section before the runbooks below — it changes how much you should
trust a given failure.

**All three image vendors are now live-verified** (Ideogram 2026-07-30,
Recraft and Vectorizer.ai 2026-08-04), which closes what was this branch's
largest standing caveat: no adapter here is written from documentation alone
any more. What each probe did *not* observe is named vendor by vendor below,
and those gaps are real — but "we have never once called this API" is no
longer among them.

- **Recraft's adapter is now verified live (2026-08-04) — and it shipped
  wrong for a while.** This entry used to say no Recraft key was obtainable
  and that `src/generate.ts`'s `generateRecraft` was written from published
  documentation only. A key arrived, the endpoint was probed twice, and
  **three of the documented assumptions were wrong**; the adapter, its
  fixtures and its comments were corrected together. What is now *measured*:

  - `style: "vector_illustration"` **does** return SVG (`image/svg+xml`,
    ~40–50 kB), and that SVG passes `checkTrueVector` clean **both raw and
    after `sanitizeSvg`** — zero violations, no `<image>` element, no
    external references. **The native-SVG bypass is real**, so a job whose
    winning concept came from the `emblem` axis genuinely skips the ~$0.20
    Vectorizer.ai call.
  - The per-call request id is the **`x-recraft-requestid` response
    header**. The success body has no `id` field at all (top-level keys:
    `created`, `credits`, `data`), and `created` is a **Unix timestamp**,
    not an id — the identical trap already found on Ideogram's leg.
    `data[0].image_id` names the *output asset*, not the call, and is kept
    only as a labelled fallback.
  - `credits` reports **what the vendor actually charged** (80 for one
    image). The FR-5 ledger now bills from that figure rather than from a
    constant that drifts unobserved; `IMAGE_COST_USD.recraft` remains the
    fallback and the planning figure `MAX_SPEND_USD` is sized against.

  **Still unproven for this vendor**, so a failure here still points at our
  handling before it points at the vendor: the credits→USD **ratio** is
  derived (Recraft publishes the credit count, not the credit price — see
  `RECRAFT_CREDITS_PER_USD` in `src/config.ts` for the reconciliation), the
  **raster-return branch** was never observed (every live call returned
  SVG), and neither the **non-200 error bodies** nor a response **missing
  the header or the credit count** has ever been seen.

- **Vectorizer.ai is now verified live (2026-08-04) too — and unlike Recraft,
  every assumption held.** This entry used to warn that the credential shape
  was unverified and that getting it wrong would fail every job not taking the
  Recraft bypass. A token arrived, the endpoint was probed three times in the
  vendor's **free test mode**, and the adapter needed no correction. What is
  now *measured*:

  - **The credential shape is right.** This bot has exactly one secret slot
    (`PipelineSecrets.vectorizerToken`, backed by the `VECTORIZER_AI_TOKEN`
    wrangler secret), and `src/vectorize.ts` reads that single string as an
    **already-joined** `"apiId:apiSecret"` pair, base64-encoding the whole
    thing — that is exactly what the API accepts. **This does not remove the
    provisioning warning:** vectorizer.ai still hands you `apiId` and
    `apiSecret` as two separate values, so you must join them yourself
    (`` `${apiId}:${apiSecret}` ``) before putting the secret. Do not put just
    the secret half in `VECTORIZER_AI_TOKEN` and assume it works.
  - The endpoint, the `image` + `output.file_format=svg` multipart fields and
    the raw-SVG success body (`HTTP 200`, `image/svg+xml`, 47899 bytes) are
    all as the adapter assumed.
  - **The response carries an external reference, and only SVGO removes it.**
    The body opens with an XML prolog *and* a `<!DOCTYPE>` naming an external
    DTD URL (`http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd`). It does not
    reach the buyer — SVGO's `removeDoctype` strips it (47899 → 23105 bytes on
    the real response; zero `http:` outside `xmlns` in the delivered SVG) —
    but `removeDoctype` is an *inherited* `preset-default` plugin nobody here
    chose, and it is **load-bearing**: mutation-tested, with it disabled the
    DOCTYPE and its URL survive and `checkTrueVector` **passes them** (a
    DOCTYPE matches neither the tag allowlist nor the reference scan). There
    is no second line of defence. `src/vectorize.test.ts` now pins this with
    the real captured prefix; do not override that plugin off.
  - The charge is the **`x-credits-charged` response header** (a header, not
    a body field — the body is raw SVG), reported beside
    `x-credits-calculated`. The stage-2 ledger bills from it, falling back to
    `IMAGE_COST_USD.vectorizer` on any count it cannot parse.

  **Verifying this integration costs nothing.** Adding `mode=test` to the
  multipart form returns a **full-shaped** response — real SVG, real headers —
  and charges `x-credits-charged: 0.000000` (against
  `x-credits-calculated: 1.000000`). That is how all three probes above were
  run, and it is the way to re-verify the adapter after a vendor change, check
  a freshly provisioned credential before a paying customer depends on it, or
  extend the calibration harness over this leg without real spend. **It is
  deliberately not wired into production code:** `src/vectorize.ts` never
  sends `mode=test`, so what ships always pays. Inject it from a probe by
  wrapping the `fetchImpl` you hand `createVectorizer`, not by adding a flag
  to the adapter.

  **Still unproven for this vendor:** every probe was test-mode, so **no paid
  call has ever been observed** — the non-zero charge value, specifically, is
  inferred; the credits→USD **ratio** is derived exactly as Recraft's is
  (vectorizer.ai publishes a credit *count*, and 1 credit ≈ $0.20 only at the
  entry pricing tier — see `VECTORIZER_CREDITS_PER_USD` in `src/config.ts`);
  and no **non-200 error body** has ever been seen.

- **The license manifest ships incomplete on purpose, not by omission.**
  `buildLicenseManifest` (`src/report.ts`) looks up each delivered image's
  vendor in `VENDOR_TERMS` and stamps a `verifiedOn` date — but every entry
  in `VENDOR_TERMS` today (`ideogram`, `recraft`, `flux`, `vectorizer`) has
  `verifiedOn: null`, because **no in-repo decision record exists yet**
  saying anyone actually read those vendors' commercial/resale terms. The
  manifest's own `note` field says so in the delivered JSON:
  `INCOMPLETE: ... does NOT attest that those resale terms were read.` This
  bot sells packs on the strength of commercial-use rights — shipping that
  note to a paying customer is honest, not a defect, and inventing a
  verification date to make it go away would be worse than the gap it
  covers. **This blocks launch. It requires a human to read the vendor
  terms and write the decision down (see the Phase 0 checklist below) — it
  is not something a code change can fix.**

- **Trademark clearance is not performed and not warranted, full stop.**
  This bot verifies that delivered lettering *reads back correctly* (an OCR
  gate) and that the delivered file *is* a true vector (a structural SVG
  gate). Neither of those is a trademark search. The bot's own warranty
  terms (`src/config.ts`'s `botProfile.warrantyTerms`) say this explicitly
  and every delivery note repeats it — do not let a support conversation
  imply otherwise.

- **Latin script only.** `src/brief.ts`'s `isLatinScript` check
  (`\p{Script=Latin}` plus digits/punctuation/spacing/combining marks) is a
  deliberate v1 scope boundary, not an oversight. A brief in another script
  is rejected at intake with a clear reason, before anything is generated or
  charged.

- **Taste is advisory, not warranted.** The OCR gate proves lettering reads
  back; the pHash gate proves three concepts are visually distinct from each
  other; the vector gate proves the delivered file is a true vector. None of
  that is a claim that a concept looks *good*. The extracted colour palette
  and the Google Fonts pairing in `brand.json` are advisory outputs, not
  warranted ones.

- **There is no re-run and no revision round, and the warranty no longer
  claims one.** `botProfile.warrantyTerms` and both delivery notes used to
  promise that a failing artifact "is re-run free of charge, plus one
  revision round on the selected mark". Nothing implements either: there is
  no thread trigger and no code path that mints a per-revision claim key
  (`grep -rn "revision" src/ --include '*.ts'` outside the tests returns only
  prose). Task 23 left that path deliberately unbuilt, because any scheme has
  to preserve the original `concepts` and `gate_audit` rows and the obvious
  one collides with them on the primary key — losing the evidence of what was
  delivered at the moment of a dispute.

  The terms now describe what the bot does do: every stated check runs
  **before** delivery and a failing artifact is not shipped at all; the
  evidence page, validation report and license manifest stay available with
  every measurement behind those claims; and a dispute gets that complete
  record filed (`assembleDisputeEvidence`). `freeGigs.test.ts`'s FR-18 suite
  characterises what a re-run *would* inherit if one is ever built — a fresh
  FR-5 cap and no free-gig quota cost — and constructs the claim key itself.
  Do not read it as evidence that anything triggers one. **Building the
  re-run/revision path is an open product decision.**

## Required secrets

Set every one of these with `wrangler secret put <NAME>` before the Worker
can do real work (see `.dev.vars.example` for local dev). None of them are
committed anywhere, and `.dev.vars` is gitignored.

| Secret | Used for |
|---|---|
| `BOTGUILD_API_URL` | BotGuild platform REST base URL |
| `BOTGUILD_API_KEY` | BotGuild platform auth (scopes: read, proposals:write, bots:write) |
| `BOTGUILD_BOT_ID` | This bot's registered id (`bot-logosmith`) |
| `ANTHROPIC_API_KEY` | Haiku axis-prompt compilation |
| `MODERATION_API_KEY` | FR-2 input content-safety screening (OpenAI omni-moderation, pinned model — see `src/moderation.ts`) |
| `IDEOGRAM_API_KEY` | Ideogram 3.0 image generation (`wordmark`/`lockup` axes) — **verified live** |
| `RECRAFT_API_KEY` | Recraft V3 image generation (`emblem` axis) — **verified live 2026-08-04**, see above |
| `VECTORIZER_AI_TOKEN` | Vectorizer.ai raster-to-vector conversion — **verified live 2026-08-04**; the joined `apiId:apiSecret` pair, not either half alone, see above |
| `GOOGLE_FONTS_API_KEY` | Font-pairing lookup for `brand.json` |
| `ADMIN_TOKEN` | Bearer-protects `POST /admin/register`; the route is disabled (503) if this is unset |

One more secret is deliberately **not** in this list: the BotGuild webhook
HMAC signing secret is not a `wrangler secret` at all — the platform issues
it at registration time and this bot persists it in D1 (`webhook_secret`
table), read fresh on every inbound webhook. That is why registration
(`POST /admin/register`) has to actually run before webhooks will verify.

## Phase 0 ops checklist (do this before listing the bot)

This is entirely outside code — nothing in this repository can complete it
for you, and nothing here should be trusted to have completed it silently.

1. **Read and record vendor commercial/resale terms** for every vendor whose
   output this bot resells or whose output feeds a resold artifact:
   - Ideogram 3.0 (image generation)
   - Recraft V3 (image generation + native SVG export)
   - Vectorizer.ai (raster-to-vector conversion)
   - FLUX.2 [klein] **hosted on Workers AI** (the free-taster path) — the
     terms that matter are Cloudflare's Workers AI hosted-output terms for
     this model, not a direct Black Forest Labs agreement, since this bot
     never calls Black Forest Labs directly.
   For each: confirm the buyer-facing bot's use (generate a mark for a
   customer, who then owns and resells/commercializes it) is within the
   vendor's permitted use, and write the decision down **in this repo** —
   who read what, on what date, and what was concluded — the same way
   `src/pack/fonts.ts` already records font licence provenance (grep it for
   the pattern: a comment naming the licence, who verified it, and when).
   Until that record exists, **do not** hand-edit `verifiedOn` dates into
   `src/report.ts`'s `VENDOR_TERMS` — an invented date in a customer-facing
   license manifest is worse than an honest `INCOMPLETE`.
2. **Provision API keys** for Ideogram, Recraft, and Google Fonts (Anthropic
   and the moderation vendor are presumably already provisioned from
   development). Put each with `wrangler secret put`.
3. **Purchase a Vectorizer.ai plan** sized for expected volume, and get the
   real `apiId`/`apiSecret` pair — join them into one `apiId:apiSecret` string
   before putting the secret (see the Vectorizer.ai entry above), then confirm
   the token works with a **free `mode=test` call**, which costs nothing and
   is documented in that same entry. The credit price a plan buys is also what
   `VECTORIZER_CREDITS_PER_USD` in `src/config.ts` is reconciled against, so
   if the plan's rate is not the entry tier's ~$0.20/credit, update that
   constant (`config.test.ts` will tell you if it and `IMAGE_COST_USD`
   disagree).
4. **Get the Google Fonts API key** (a simple API-key signup, no plan
   choice) and put it as `GOOGLE_FONTS_API_KEY`.
5. Only after 1–3 are done: run the **calibration procedure** below and
   freeze the two provisional gate thresholds, then list the gig on
   BotGuild.

## Ordered deploy runbook

Run these in order. Steps 1–2 are one-time per environment; steps 3–6 repeat
on every deploy (though `d1 create` and `kv namespace create` are obviously
idempotent-skippable once ids exist).

```bash
# 1. Create the D1 database (one time).
wrangler d1 create logosmith
# -> prints a database_id. Paste it into wrangler.jsonc's d1_databases[0].database_id
#    (currently a placeholder marked "⚠️ REPLACE").

# Also one-time: create the KV namespace and R2 bucket, and paste their ids/names
# into wrangler.jsonc the same way (kv_namespaces[0].id, r2_buckets[0].bucket_name —
# the bucket name "logosmith-deliverables" is already set; only the KV id is a
# placeholder).
wrangler kv namespace create CACHE
wrangler r2 bucket create logosmith-deliverables   # if it doesn't already exist

# 2. Set WEBHOOK_BASE_URL in wrangler.jsonc's "vars" to this Worker's real
#    public URL (or your custom domain) — it is baked into every deliverable
#    link, progress-page URL, and the webhook registration call itself.

# 3. Apply migrations (all three; wrangler tracks which have already run).
wrangler d1 migrations apply logosmith --remote

# 4. Put every secret listed in "Required secrets" above.
wrangler secret put BOTGUILD_API_URL
wrangler secret put BOTGUILD_API_KEY
wrangler secret put BOTGUILD_BOT_ID
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put MODERATION_API_KEY
wrangler secret put IDEOGRAM_API_KEY
wrangler secret put RECRAFT_API_KEY
wrangler secret put VECTORIZER_AI_TOKEN
wrangler secret put GOOGLE_FONTS_API_KEY
wrangler secret put ADMIN_TOKEN

# 5. Deploy.
wrangler deploy

# 6. Register webhooks — exactly once (idempotent if you run it again, but
#    it does not need to be). This also captures the HMAC webhook secret the
#    platform issues and persists it to D1, which is what makes GET /webhook
#    signature verification start working at all.
curl -X POST "https://<your-worker-url>/admin/register" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

If you skip step 6, the 15-minute cron sweep has a first-run backstop that
registers automatically the next time it fires (it checks for a stored
webhook secret and runs registration itself if none exists) — but every
webhook delivery returns `503 {"error": "Secret unavailable"}` until either
that cron fires or you run the admin route by hand (the shared webhook app
in `@botguild/agent-core-workers` checks for an empty secret specifically
and 503s rather than attempting signature verification against one), so do
not skip it and assume it will silently start working immediately.

Sanity-check the deploy with `GET /health` — it should return
`{"status": ..., "botId": "bot-logosmith", ...}`, with a `reputation` field
once the cron has run at least once.

## DLQ replay runbook

**Why replay is safe here, before the how.** Every job is claimed against a
`job_key = sha256(contractId) + ':' + stage` row in D1 (`src/jobs.ts`) before
it is ever sent to the queue, and every pipeline stage resumes from a
persisted checkpoint rather than starting over:

- If the job already reached `status = 'delivered'`, `runConceptStage` /
  `runVectorStage` / `runSingleStage` (`src/pipeline.ts`) each check that
  **first** and return immediately — redelivering a completed job's message
  is a no-op, not a double-delivery.
- If it did not finish, every paid vendor asset is written to R2 and every
  dollar spent is written to the D1 spend ledger **before** the next thing
  that can throw (see the "SPEND IS DURABLE BEFORE ANYTHING THAT CAN THROW"
  and "PAID BYTES ARE NEVER LOST" invariants documented at the top of
  `pipeline.ts`). A replayed message re-enters the same slot loop, sees the
  work already paid for, and re-gates the stored bytes instead of paying for
  a second image.

So replaying a dead-lettered message re-drives the **same** job to
completion — it does not create a duplicate contract, double-charge a
vendor, or double-deliver a milestone. This is also why the DLQ consumer
(`queue()` in `src/index.ts`) just logs and acks poisoned messages instead of
retrying them itself: retrying automatically would fight whatever made the
message fail in the first place, whereas an operator can look at *why* it
died before deciding to replay it.

**How to actually replay one:**

1. **Find the message.** The DLQ consumer logs every dead-lettered message as
   a structured line: `"DEAD-LETTERED JOB — operator action required (see
   README runbook)"`, carrying `queue`, `messageId`, `attempts`, and — the
   part you need — `body` (`{ contractId, jobKey, stage }`). Find it via
   `wrangler tail` (if you're watching live) or Cloudflare's dashboard
   Workers Logs for this Worker (`observability.enabled` is on in
   `wrangler.jsonc`, so these lines are retained there even if you weren't
   tailing at the time). **Grab this promptly** — dashboard log retention is
   not unlimited, and there is no other way to recover a dead-lettered
   message's body once it has scrolled out of both.
2. **Push it back onto the live queue, not the DLQ.** Cloudflare's dashboard
   supports composing and sending a message to any queue directly (Queues →
   `logosmith-jobs` → Messages tab → Send → Content Type: JSON), specifically
   documented for debugging queues/consumers without a producer Worker. Paste
   the exact `body` object you copied in step 1 and send it to
   **`logosmith-jobs`** (the live queue — sending it to
   `logosmith-jobs-dlq` again just re-dead-letters it once the DLQ consumer's
   own retry budget of 0 is immediately exhausted).
3. **Confirm it landed.** Tail the Worker again, or check the job's row via
   `wrangler d1 execute logosmith --remote --command "SELECT job_key, status,
   outcome, park_reason, updated_at FROM jobs WHERE job_key = '<jobKey>'"`.

There is no `wrangler queues` CLI subcommand for pushing a single message
(checked against wrangler 4.107 — `wrangler queues` only exposes
list/create/update/delete/info/consumer/pause-delivery/resume-delivery/
purge/subscription) and no public REST endpoint for it outside a producer
Worker binding, so the dashboard compose-and-send feature above is the
actual supported mechanism today, not a workaround.

If a message died from a genuine, still-present bug rather than a transient
fault, replaying it will just die the same way again — read *why* it failed
(the log line right before the dead-letter one, or the gate-audit trail via
`listGateAudit` for that `job_key`) before replaying, not after.

## Calibration procedure

`src/config.ts` marks two thresholds `PROVISIONAL`:

```ts
export const OCR_SIMILARITY_THRESHOLD = 0.85; // PROVISIONAL
export const MIN_PHASH_HAMMING = 10; // PROVISIONAL
```

The comment above them is binding: **do not loosen either one to make a job
pass.** A too-strict threshold burns regeneration budget (§15 tracks this
precisely so the fix is prompt tuning, not gate-loosening); a too-loose one
ships a broken logo. Both are wrong in a way this procedure is built to
catch — it has to be able to say a threshold is wrong, not just confirm
whatever number is already there.

**When to run this:** before first listing the bot (once Phase 0 above is
done), and again **every time the pinned vision model
(`SCOUT_MODEL_ID` in `src/config.ts`) or the pinned Ideogram/Recraft/FLUX
model versions change** — a new model version can shift the OCR gate's
score distribution out from under an already-frozen threshold without any
code here changing at all.

**What it does.** `src/calibration/harness.ts`'s `runCalibration` generates
a real image for every name in `src/calibration/goldens.json` (34 names
today, spanning plain-to-ornate styling, ampersands, hyphens, diacritics,
repeated letters, all-caps, and single-character names) on each of the three
paid style axes, using the **real, injected** Ideogram/Recraft generator and
the **real, injected** OCR gate — this is a real-money exercise (image
generation + vision-model calls), which is exactly why it is a deliberate,
occasional ops action and not something that runs in CI. For each generated
image it runs the OCR gate `n` times (default 5) against the correct brand
name and again against a deliberately wrong one, and computes the pairwise
pHash distance within each name's three axis images. `summarize` (the pure,
unit-tested half — see `harness.test.ts`) rolls all of that into a report:
garbled-detection rate, stylized-but-legible pass rate, per-image score
variance (and an `unstable` flag on any image whose repeat runs land on both
sides of the threshold — that instability, not the mean, is the drift risk),
regeneration burn per axis, and the pHash distribution (min/median/p10
across all pairs).

**Running it for real needs a real Workers AI binding**, and that is only
available from inside an actual Workers runtime — there is no verified,
supported way to call Workers AI from a bare Node script the way Ideogram or
Recraft (plain HTTPS APIs) can be. Do not improvise a raw Cloudflare REST
call to Workers AI here and trust its response shape without checking it
against `gates/ocr.ts`'s `{response, usage}` expectations first — this
repository's own history (see `src/gates/ocr.ts`'s header comment) is a
vision call that returned HTTP 200 with a shape that looked plausible and
was wrong. The lowest-risk way to get a real binding:

1. Add a **temporary** route to this Worker, gated behind the same
   `ADMIN_TOKEN` bearer check `/admin/register` already uses, that builds
   `CalibrationDeps` from the real bindings/secrets and calls
   `runCalibration`:

   ```ts
   import { createGenerator } from './generate.js';
   import { createOcrGate } from './gates/index.js';
   import { runCalibration } from './calibration/harness.js';

   // Inside buildApp(), alongside the existing /admin/register route:
   app.post('/admin/calibrate', async (c) => {
     if (!env.ADMIN_TOKEN) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
     if ((c.req.header('Authorization') ?? '') !== `Bearer ${env.ADMIN_TOKEN}`) {
       return c.json({ error: 'Unauthorized' }, 401);
     }
     const report = await runCalibration({
       generator: createGenerator({
         fetchImpl: fetch,
         ai: env.AI,
         ideogramApiKey: env.IDEOGRAM_API_KEY,
         recraftApiKey: env.RECRAFT_API_KEY,
       }),
       ocrGate: createOcrGate({ ai: env.AI }),
       sources: {
         resvg: () => import('@resvg/resvg-wasm/index_bg.wasm').then((m) => m.default),
         potrace: () => { throw new Error('unused by calibration'); },
       },
     });
     return c.json(report);
   });
   ```

2. Run this against real bindings with `wrangler dev` using **remote
   bindings** for `AI` (Workers AI cannot run locally — see the `wrangler`
   skill's remote-bindings guidance) and hit the route, or deploy it
   temporarily and hit the live URL.
3. Capture the JSON response (`report.summary` is the part to read first;
   `report.results` is the full per-image detail if `summary.blockers`
   points you at something specific).
4. **Remove the route before the next real deploy.** It is a one-time ops
   tool, not a permanent surface — leaving it in place means anyone with the
   admin token can trigger real vendor spend on demand.

**Where the result gets written back.** Once `report.summary.canFreeze` is
`true` (which itself requires >=30 distinct names, zero unstable images, and
both rates clearing a healthy bar — see `summarize`'s `blockers` array if it
is `false`, it names exactly why):

1. Update `src/config.ts`'s two constants to the calibrated values and
   **remove the `PROVISIONAL` markers** (keep the surrounding comment
   explaining what they mean and the "do not loosen" warning — that
   reasoning does not expire just because the numbers are now frozen).
2. Update the **gig terms** that quote these numbers verbatim — today that
   is `botProfile.warrantyTerms` in `src/config.ts` (which says "the stated
   OCR readback threshold") and the M1/M2 delivery notes in `src/pipeline.ts`
   (`buildM1Note`, which literally interpolates `OCR_SIMILARITY_THRESHOLD`
   and `MIN_PHASH_HAMMING` into the buyer-facing note — if the constants
   change, the next delivery automatically quotes the new numbers, so this
   is really "confirm the interpolated text still reads correctly," not a
   separate edit).
3. Re-run the full test suite (`gates/ocr.test.ts` and `gates/phash.test.ts`
   assert specific pass/fail behaviour at the current threshold values —
   confirm nothing there was silently relying on the old numbers) and
   redeploy.

If `canFreeze` never turns `true` no matter what threshold you try — i.e.
the golden set shows the gate cannot separate stylized-but-legible from
garbled at *any* reasonable cutoff — that is a product problem, not a tuning
problem, and needs a decision before listing, not a smaller number in
`config.ts`.

## Architecture, in one paragraph

Gigs are discovered by poll and scored by `agent-core`'s shared scorer
(`src/config.ts`'s `scorerConfig`); an accepted proposal funds an escrow
milestone, which lands as a `milestone.funded` webhook that claims a job row
and enqueues it. The Queue consumer (`src/index.ts`) dispatches by stage —
`concepts` (three style axes → generate → OCR/pHash gate → capped
regeneration → deliver M1), `vector` (buyer's or default-picked winner →
vectorize → assemble the brand pack → gate → deliver M2), or `single` (the
free favicon/taster funnel, quota-gated) — each resumable from a D1
checkpoint so a queue retry or a DLQ replay never re-pays for finished work.
A public, unguessable-token progress page (`GET /p/:token`) shows each
concept and its verdict as it lands; `GET /deliverables/:token/:file` serves
the final artifacts. Three cron-driven sweeps (`src/sweeps.ts`) handle
thread-based selection resolution, parked-job give-up, and stuck-claim
recovery. See the header comments in `src/pipeline.ts`, `src/jobs.ts`, and
`src/report.ts` for the specific invariants each one guarantees — they are
detailed and are the actual source of truth, not a paraphrase of them here.

## Schema

Three migrations in `migrations/`, applied in order by `wrangler d1
migrations apply`:

- **`0001_init.sql`** — the full initial schema: `jobs` (per-stage claims and
  resumable checkpoints), `concepts` (one row per generated concept),
  `selection` (the FR-9 winner-selection state machine), `free_gig_usage`
  (the free-funnel quota ledger), `license_manifest` (declared but currently
  unused — nothing inserts into it yet; the manifest is built in memory and
  shipped as `licenses.json` without being persisted), `dispute_responses`
  (one-shot dispute-response claim), `gate_audit` (the append-only FR-17
  evidence trail everything above is reconstructed from), plus the
  `webhook_secret` and `negotiation_countered` tables owned by
  `@botguild/agent-core-workers`.
- **`0002_parked_since.sql`** — adds `jobs.parked_since`, the column the
  6-hour parked-give-up bound (`PARKED_GIVE_UP_HOURS` in `src/config.ts`)
  actually measures against. Read the migration's own comment before
  "simplifying" this away — two other columns (`updated_at`, `created_at`)
  were tried first and both measure the wrong thing (a park→unpark→fail loop
  never lets `updated_at` accumulate past one cron interval; `created_at`
  measures age-since-claim, not age-spent-failing).
- **`0003_free_gig_contract_unique.sql`** — a `UNIQUE INDEX` on
  `free_gig_usage(contract_id)`, making one-free-allowance-per-contract a
  database-enforced invariant rather than resting on application-level
  `NOT EXISTS` logic a future refactor could quietly drop.

## Bundle and memory

`wrangler deploy --dry-run` reports **~1978 KiB gzip** (5874 KiB raw) against
the Workers Paid plan's 10 MB cap — about 19% — with **three WASM modules**
linked into the bundle: `@resvg/resvg-wasm` (SVG rasterization for every
favicon/master PNG), `esm-potrace-wasm` (raster→vector tracing), and
`@cf-wasm/photon` (source-logo decode/resize for the free favicon gig).
Bundle size was never the binding constraint here; **peak isolate memory**
was — the 128 MB ceiling was hit early in development from an unfreed resvg
handle and fixed by the `.free()`-in-`finally` discipline documented in
`src/pack/render.ts` and guarded by regression tests that spy on
`Resvg.prototype.free`/`RenderedImage.prototype.free`. If a future change
adds a bare `new Resvg(...)` anywhere outside `render.ts`, those guards are
what will catch it — do not remove them to make a refactor easier.

## Health, logging, observability

`GET /health` returns `{status, botId, ...}` plus a cached `reputation`
snapshot once the cron has populated it. `wrangler.jsonc` has
`observability.enabled: true` (Cloudflare Workers Logs) — use `wrangler
tail` for live debugging or the dashboard's Workers Logs for anything after
the fact (see the DLQ runbook above for the one place this matters
operationally). This bot does not ship logs to a Fly.io-style external drain
the way the original Fly.io-hosted bots in this monorepo do — it is a
Cloudflare Worker, and Cloudflare's own Logs/`wrangler tail` are the
mechanism here.

## Disputes

`contract.status.changed → disputed` and `dispute.response_submitted` route
through `src/disputes.ts`, which assembles the counter-statement from this
bot's own D1 records and files it with the platform's `respond_to_dispute`
MCP tool: the stored lettering-readback verdicts and per-image vendor request
ids from `concepts`, each image's generation seed recovered from the
`gate_audit` row that recorded that image's verdict (so a disputed concept
can be regenerated), the winner and how it was chosen from `selection`, the
per-stage claims and spend from `jobs`, and the full `gate_audit` trail
merged across every stage key in insert order. Nothing is recomputed at
dispute time — a verdict is quoted as the gate wrote it, not re-derived from
today's thresholds — and anything that could not be sourced is named in the
document's `evidenceGaps`, following the same rule `report.ts` follows for
the delivered validation report: in an evidence document "0" and "unknown"
are never the same value.

A slot is gated once per attempt, so several `gate_audit` rows can describe
one concept and only one of them describes the image that was kept. The seed
is therefore elected rather than looked up: every row that could be this
image's votes, **including rows that record no seed at all**, and only an
unanimous vote is reported. A null `seed` means no seed could be named from
the record — the vendor may have issued none, the attempts may be
indistinguishable, the slot may have been re-gated after a park, or that
row's detail may no longer parse — so it asserts nothing either way rather
than confirming the record is complete. Do not "improve" this into picking
the newest row: naming a seed that regenerates a *discarded* attempt
falsifies the document's own strongest claim on the payer's first check.

The response fires **exactly once per contract**: it is claimed with a
unique-constraint `INSERT` into `dispute_responses` before the MCP call, so
concurrent webhook redeliveries collapse to one counter-statement (including
the `dispute.response_submitted` event our own filing triggers). A failed
post releases the claim and lets the handler throw, so the platform's
redelivery is a real retry rather than permanent silence.
