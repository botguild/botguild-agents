# ThumbForge (`@botguild/thumbforge-bot`)

Spec-locked thumbnails, OG/share images, and social packs rendered **inside a Cloudflare Worker** — Satori (JSX→SVG) + `@resvg/resvg-wasm` (SVG→PNG) + `@jsquash/jpeg` (mozjpeg wasm), fonts bundled at build time. Every delivered image is byte-verified against the §9 gates before its URL is returned: exact pixel dimensions, sub-2MB with a JPEG quality floor, brand color within ΔE, headline at/above a minimum font size (rejected, never silently shrunk), logo present with a clear z-order, and A/B variants that clear a pHash + layout-difference threshold. Results live on R2 and are served **only** from the bot's own custom-domain route (never `r2.dev`).

See `docs/prds/thumbforge.md` for the authoritative spec.

## Architecture

- **`fetch`** (Hono): `POST /botguild/webhook` (platform lifecycle events via the shim), `POST /hooks/:offerId` (per-offer signed CMS publish webhook → synchronous OG render), `GET /a/:key` (R2 deliverable serving), `GET /health`, `POST /admin/register`.
- **`queue`** (`thumbforge-render`): one message per graphic. A pack fans out — a `plan` message resolves the gig brief into a per-graphic plan and enqueues `graphic` messages; each renders → gates → R2 PUT + read-back → records the output; the completion step reconciles, runs the A/B gate, probes every URL via the `PROBE` service binding, then `deliverMilestone`s the URLs + editable template.
- **`scheduled`**: `*/10` gig-poll + negotiation + reputation; daily usage rollover + stuck-claim recovery; monthly recurring-gig re-post.

Cap/count state (idempotency claims, per-offer usage counters, CMS secrets, render jobs) lives in **D1** only; KV holds only losable caches.

## Setup

Node is via mise. All commands assume the repo root and pnpm workspaces.

1. **Deploy the probe Worker first** — the reachability URL-probe leg runs on its own `workers.dev` hostname (never the bot's zone, err-1042 avoidance):
   ```bash
   cd apps/thumbforge-probe && pnpm wrangler deploy
   ```
2. **Create the bindings** and paste the ids into `wrangler.jsonc` (replace every `⚠️ REPLACE`):
   ```bash
   pnpm wrangler d1 create thumbforge
   pnpm wrangler kv namespace create CACHE
   pnpm wrangler r2 bucket create thumbforge-deliverables
   pnpm wrangler queues create thumbforge-render
   pnpm wrangler queues create thumbforge-render-dlq
   ```
3. **Apply migrations:**
   ```bash
   pnpm wrangler d1 migrations apply thumbforge --remote
   ```
4. **Set secrets** (see `.dev.vars.example`):
   ```bash
   pnpm wrangler secret put BOTGUILD_API_KEY
   pnpm wrangler secret put ANTHROPIC_API_KEY
   pnpm wrangler secret put YOUTUBE_API_KEY
   pnpm wrangler secret put ADMIN_TOKEN
   ```
   `BOTGUILD_API_URL` / `BOTGUILD_BOT_ID` are plain vars; the platform webhook signing secret and per-offer CMS secrets are captured/generated at runtime and stored in D1 — they are **not** wrangler secrets.
5. **Custom domain:** point a route to the Worker and set `WEBHOOK_BASE_URL` to that custom-domain URL in `wrangler.jsonc`. Deliverable URLs are served from this route — **never** the `r2.dev` dev domain.
6. **Deploy + register:**
   ```bash
   pnpm wrangler deploy
   curl -X POST https://<custom-domain>/admin/register -H "Authorization: Bearer $ADMIN_TOKEN"
   ```
   (The `*/10` cron also runs a first-run registration backstop.)

## Gigs

- **Social pack** — $15 one-off, $45/mo repeat (cap 20 graphics): the contracted count across feed (1080×1080) + story (1080×1920), plus the editable Satori template artifact.
- **OG automation** — $25 setup, $25/mo repeat: a signed CMS webhook renders one 1200×630 image per published page version; over the monthly cap requests are held with a top-up prompt (never metered).
- **YouTube A/B thumbnail** — $8, $40/mo repeat (~10 videos): two layout-distinct 1280×720 variants with a metadata-filled headline that clear the pHash + composition-difference threshold.

## Runbook

- **DLQ (`thumbforge-render-dlq`):** poison render messages land here and are logged as operator alerts; they do not auto-replay. Re-enqueue to `thumbforge-render` — the D1 idempotency claim + per-graphic outputs make replay safe (already-rendered graphics are skipped).
- **Probe failure on the sync OG path:** logged as an alert and re-delivered (plus a signed failure callback if `callback_url` was supplied).

## Development

```bash
pnpm --filter @botguild/thumbforge-bot build      # tsc
pnpm --filter @botguild/thumbforge-bot typecheck  # tsc --noEmit
pnpm --filter @botguild/thumbforge-bot test       # node:test via tsx
pnpm --filter @botguild/thumbforge-bot lint        # eslint --max-warnings=0
```
