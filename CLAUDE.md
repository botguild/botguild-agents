# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

This repository is currently in the **planning/documentation phase**. The `bots/` directory contains four design documents. No source code exists yet. Implementation begins by initializing the monorepo structure described in `bots/ARCHITECTURE.md`.

## Planned Stack

- **Runtime:** Node.js 22, TypeScript
- **Monorepo:** pnpm workspaces + Turborepo (mirrors `botguild-platform` structure)
- **Deployment:** Fly.io (one `fly.toml` per bot app)
- **HTTP framework:** Hono (for webhook servers)
- **AI:** Anthropic Claude API — Haiku for proposals/reports, Sonnet for complex reasoning
- **Headless browser:** Playwright (SentinelBot page diffs, VerifierBot DOM checks)

## Planned Commands (once monorepo is initialized)

```bash
pnpm install              # Install all workspace dependencies
pnpm build                # Build all packages (via Turborepo)
pnpm typecheck            # TypeScript type-check across workspace
pnpm dev                  # Start a bot in dev mode (run from apps/<bot>/)
pnpm test                 # Run tests across workspace
docker-compose up         # Full local stack with all 3 bots
```

Single-bot dev:
```bash
cd apps/sentinel-bot && pnpm dev
```

Deploy (or let GitHub Actions handle it on push to `main`):
```bash
cd apps/sentinel-bot && fly deploy
```

## Repository Structure (planned)

```
packages/
  agent-core/             # Shared library used by all three bots
    src/
      client.ts           # BotGuild REST API wrapper with retry + logging
      webhook.ts          # Hono-based webhook server factory
      poller.ts           # Gig discovery polling loop with deduplication
      scorer.ts           # 5-factor gig scoring algorithm
      proposer.ts         # Claude proposal generation (prompt caching)
      messenger.ts        # Contract thread helpers
      standing.ts         # Standing offer idempotent sync on startup
apps/
  sentinel-bot/           # Port 3001 — monitoring & alerting
  flow-bot/               # Port 3002 — data transformation / ETL
  verifier-bot/           # Port 3003 — QA & acceptance testing
```

## Architecture

Three independent Fly.io microservices share the `agent-core` library. All bots follow the same lifecycle:

**Gig discovery → scoring → proposal → acceptance webhook → work execution → delivery → payout**

- Webhooks are primary; polling is the fallback. On startup each bot registers its webhooks with the BotGuild platform, then begins polling in parallel.
- Standing offers are configuration-as-code; bots upsert them idempotently on startup.
- Persistence is in-memory + flat-file (`jobs.json`) — no database.

### Gig Scoring (`packages/agent-core/src/scorer.ts`)

5-factor algorithm, max 100 points:

| Factor | Weight |
|--------|--------|
| Category match | 40 |
| Budget | 20 |
| Warranty terms | 15 |
| Clarity | 15 |
| Timeline | 10 |

Only gigs scoring above a configurable threshold receive proposals.

### Claude Integration

- **Proposal generation:** Haiku with prompt caching on the system prompt (cost optimization).
- **Pricing:** Deterministic per-bot calculation, never Claude-generated.
- **Report/delivery writing:** Haiku for routine reports, Sonnet for complex reasoning tasks.
- **VerifierBot acceptance criteria evaluation:** Sonnet.
- Cache the system prompt; vary only the gig-specific user message.

### Webhook Events

`proposal.accepted`, `milestone.accepted`, `message.clarification_request`, `warranty.claim_filed`, `contract.status.changed`, `subscription.activated/cancelled/paused/resumed`

HMAC-verify every inbound webhook using `BOTGUILD_WEBHOOK_SECRET`.

## Required Environment Variables

```
BOTGUILD_API_KEY          # Scopes: read, proposals:write, bots:write
BOTGUILD_API_URL          # https://botguild.ai/api
BOTGUILD_BOT_ID           # Registered bot ID for this service
BOTGUILD_WEBHOOK_SECRET   # HMAC signature secret
ANTHROPIC_API_KEY
```

## Key Design Decisions

See `bots/DESIGN.md` for full rationale. Short version:

- **No database** — In-memory + `jobs.json` is sufficient for hundreds of concurrent gigs and keeps ops simple.
- **Deterministic pricing** — Never ask Claude to price a gig; use a per-bot formula.
- **Prompt caching** — Always cache the Claude system prompt to control token costs.
- **Webhook-first** — Register webhooks on startup; polling is only a fallback, not the primary event source.
- **Standing offers as config** — `standingOffers` array in bot config, upserted idempotently on every startup.

## Health & Observability

Each bot exposes `GET /health` → `{ status, botId, uptime, jobCount }`. Fly.io checks this every 30 s.

Logging: structured pino JSON. Every log entry includes `service`, `botId`, and where applicable `gigId`, `contractId`, `durationMs`. Ship logs to Axiom or Logtail via Fly.io drain.

## Success Targets (90-day post-launch)

Per `bots/PRD.md`: 70+ reputation score, 5+ active standing offer subscriptions per bot.
