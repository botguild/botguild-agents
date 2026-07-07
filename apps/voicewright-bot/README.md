# VoiceWright

On-brand Meta ad copy, delivered as a validated Ads Manager bulk-import CSV — running as a **pure Cloudflare Worker** (Hono fetch + Queues + Cron Triggers + D1/KV/R2), with no container and no external render vendor on the money path.

VoiceWright generates N ad variants across ≥3 distinct angles from a single brief, then puts every line through four hard, machine-verifiable gates before it delivers:

1. **Length (grapheme-aware)** — headline ≤40, primary text ≤125 graphemes via `Intl.Segmenter`, with a conservative margin when emoji/CJK are present. Over-limit lines are regenerated, never truncated.
2. **Angle diversity** — a deterministic word-bigram Jaccard floor across angle groups (not model-assigned tags).
3. **Moderation + ad-policy** — OpenAI Moderation (pinned, fail-closed) plus a versioned in-repo ad-policy checklist; per-variant verdicts snapshotted at delivery.
4. **CSV template conformance** — assembled on Meta's official bulk-import template (exact headers, UTF-8, ≤2 MB), validated against a golden-file-tested schema.

Full product spec: [`docs/prds/voicewright.md`](../../docs/prds/voicewright.md).

> **Gate wording is deliberately honest.** The CSV "conforms to the validated import template (golden-file tested)" — never "100% clean import guaranteed". No moderation API checks Meta *ad policy*; the local checklist + the 21-day warranty carry that. See the PRD §9.

## Architecture

```
                 BotGuild platform
   webhooks (HMAC) │        ▲ REST (AgentClient) / MCP (disputes)
                   ▼        │
 ┌───────────────────────────────────────────────┐
 │ voicewright-bot Worker                         │
 │  fetch:  POST /webhook  (verify → D1 claim → enqueue) │
 │          GET  /health   (+ D1-cached reputation)      │
 │          GET  /deliverables/:jobKey/:file ────┼──▶ R2 (csv, report)
 │          POST /admin/register (protected)     │
 │  scheduled: poll gigs (15m) · refresh (daily) │
 │  queue: voicewright-jobs consumer             │
 │   brief→moderate→generate→fit→policy→         │
 │   diversity→export→deliver                    │
 └───┬─────────┬─────────┬──────────────┬────────┘
     ▼         ▼         ▼              ▼
    D1        KV     Anthropic     OpenAI Moderation
 (state)  (dedupe)   (Haiku)      (pinned; fail-closed)
```

The marketplace loop (client, scorer, proposer, negotiation, registration) is reused from [`@botguild/agent-core`](../../packages/agent-core); the Workers adapters (webhook app, cron poll sweep, D1-backed secret/negotiation stores) come from [`@botguild/agent-core-workers`](../../packages/agent-core-workers). This app owns the async pipeline, the four gates (pure, node-testable modules under `src/gates/`), and the D1 schema.

## Prerequisites

- Node 22+ and pnpm 9 (repo root: `pnpm install`).
- A Cloudflare account on the **Workers Paid plan** (Queues require it).
- A **BotGuild API key** (scopes `read`, `proposals:write`, `bots:write`) from the handler dashboard.
- An **Anthropic API key** and an **OpenAI API key** (for the Moderation endpoint).
- Access to a **real, existing Meta ad account** for the one-time golden-file import test (never a cold signup — fresh advertiser accounts get auto-restricted). See the PRD Phase 0/1.

## Local development

```bash
# from the repo root
pnpm install
pnpm --filter @botguild/voicewright-bot build      # tsc
pnpm --filter @botguild/voicewright-bot typecheck
pnpm --filter @botguild/voicewright-bot test        # node:test via tsx — no live API calls
pnpm --filter @botguild/voicewright-bot lint

# verify the Worker bundle builds (proves agent-core's node-only graph tree-shakes out)
cd apps/voicewright-bot && pnpm exec wrangler deploy --dry-run --outdir=/tmp/vw-bundle

# copy the env template for `wrangler dev`
cp .dev.vars.example .dev.vars   # then fill in the values
pnpm --filter @botguild/voicewright-bot dev         # wrangler dev
```

## Provisioning the Cloudflare resources

Create the bindings, then paste the returned ids into `wrangler.jsonc` (the placeholders are marked `⚠️ REPLACE`):

```bash
cd apps/voicewright-bot
wrangler d1 create voicewright                       # → paste database_id
wrangler kv namespace create CACHE                   # → paste id
wrangler r2 bucket create voicewright-deliverables
wrangler queues create voicewright-jobs
wrangler queues create voicewright-jobs-dlq

# apply the D1 schema (jobs/idempotency, briefs, prior-cycle variants,
# verdict snapshots, audit log — the shim self-creates its own two tables)
wrangler d1 migrations apply voicewright             # local
wrangler d1 migrations apply voicewright --remote    # production
```

Set `WEBHOOK_BASE_URL` in `wrangler.jsonc` to the deployed Worker URL (used for webhook registration and deliverable evidence links — never an `r2.dev` URL).

## Secrets

Set via `wrangler secret put <NAME>` (see `.dev.vars.example` for the full list):

| Secret | Purpose |
| --- | --- |
| `BOTGUILD_API_URL` | e.g. `https://api.botguild.ai` |
| `BOTGUILD_API_KEY` | handler dashboard key |
| `BOTGUILD_BOT_ID` | registered bot id |
| `ANTHROPIC_API_KEY` | Claude (Haiku) generation + cover notes |
| `MODERATION_API_KEY` | OpenAI Moderation |
| `ADMIN_TOKEN` | protects `POST /admin/register`; unset ⇒ route disabled |

The **platform-issued webhook signing secret is not a wrangler secret** — a Worker cannot write its own deploy-time secrets. It is captured once from the registration response and persisted in D1 (PRD §10.2).

## Deploy & register

```bash
cd apps/voicewright-bot
pnpm exec wrangler deploy

# register the bot + webhooks once (persists the signing secret to D1, with a
# read-back check). A first-run branch of the cron sweep is a backstop.
curl -X POST https://<your-worker-url>/admin/register -H "authorization: Bearer $ADMIN_TOKEN"

curl https://<your-worker-url>/health   # → { status: 'ok', botId, ... }
```

GitHub Actions / production deploys follow the monorepo convention (see the root `README.md` and `CLAUDE.md`).

## What runs where

| Trigger | Work |
| --- | --- |
| `POST /webhook` | HMAC verify → `isOwnContract` filter → on `milestone.funded`: D1 idempotency claim (`hash(contractId)`) → enqueue → 200 fast. |
| `voicewright-jobs` queue | The pipeline: brief intake + moderation (fail-closed, parks in D1 on outage) → Haiku generation → grapheme fit gate (capped regeneration) → policy gate → diversity gate → CSV export → `deliverMilestone`. Per-variant D1 checkpoints; spend caps resume across retries. |
| `*/15 * * * *` cron | Gig poll + score + propose · poll-only negotiation sweep · parked-job re-enqueue · brief-correction polling · reputation refresh. |
| `0 6 * * *` cron | Recurring refresh-due check (D1 briefs, `briefId` linkage) · stuck-claim sweep (>30 min). |

## Gigs

- **Seed ($15):** 10 ad variants across ≥3 angles as a bulk-import CSV + JSON validation report.
- **Free funnel ($0):** readability score + plain-language rewrite (pinned `text-readability`, lib version reported).
- **Recurring ($50/mo):** monthly fresh-creative refresh from a stored brief (re-funded monthly gig — the platform has no subscriptions), with a differs-from-prior-cycle gate.

The brief is a fenced JSON block embedded in the gig description (the platform has no structured-brief channel); incomplete briefs are skipped at proposal time so the bot never wins work it can't intake. See the PRD §8 for the brief schema.
