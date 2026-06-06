# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

The monorepo is **implemented**. `packages/agent-core` is the shared runtime; `apps/` holds the `starter-bot` template, three reference bots (`sentinel-bot`, `flow-bot`, `verifier-bot`), and the payer-side `concierge-mcp` server. The `bots/` directory holds the original design docs (PRD/DESIGN/ARCHITECTURE/CONCIERGE) — treat them as background rationale, not the current source of truth where they disagree with the code.

## Stack

- **Runtime:** Node.js 22, TypeScript
- **Monorepo:** pnpm workspaces + Turborepo (mirrors `botguild-platform` structure)
- **Deployment:** Fly.io (one `fly.toml` per bot app)
- **HTTP framework:** Hono (for webhook servers)
- **AI:** Anthropic Claude API — Haiku for proposals/reports, Sonnet for complex reasoning
- **Headless browser:** Playwright (SentinelBot page diffs, VerifierBot DOM checks)

## Commands

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

## Repository Structure

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
apps/
  sentinel-bot/           # Port 3001 — monitoring & alerting
  flow-bot/               # Port 3002 — data transformation / ETL
  verifier-bot/           # Port 3003 — QA & acceptance testing
```

## Architecture

Three independent Fly.io microservices share the `agent-core` library. All bots follow the same lifecycle:

**Gig discovery → scoring → proposal → acceptance webhook → work execution → delivery → payout**

- Webhooks are primary; polling is the fallback. On startup each bot registers its webhooks with the BotGuild platform, then begins polling in parallel.
- Persistence is in-memory + flat-file (`jobs.json`) — no database.

### Gig Scoring (`packages/agent-core/src/scorer.ts`)

5-factor algorithm, max 100 points:

| Factor | Weight |
|--------|--------|
| Relevance (category/keyword) | 40 |
| Budget | 20 |
| Warranty terms | 15 |
| Clarity | 15 |
| Timeline | 10 |

Only gigs scoring above a configurable threshold receive proposals.

**Relevance is fuzzy, not an exact-category gate.** `scoreRelevance` (in `scorer.ts`) gives the full 40 for an exact `categories` match, but a gig whose category doesn't match still scores partial relevance if its text shares `keywords` with the bot's description — `round(40 × hits / keywordsForFullScore)`, requiring at least `minKeywordHits` (default 2) distinct hits before the fallback awards anything (a single stray keyword is noise, not a near-match — issue #60). This lets a bot bid on *any job near its description*. A gig with no category match *and* fewer than `minKeywordHits` keyword hits scores 0 relevance and is skipped, so bots never bid on unrelated work. The spec-quality factors (warranty/clarity/timeline) are scaled by `relevance / 40`, so a well-written but barely-relevant gig can't carry the score past the threshold on spec quality alone. Each bot config sets `keywords` + `keywordsForFullScore` and a lowered `proposalThreshold` (~40) so near-description gigs clear the bar.

### Claude Integration

- **Proposal generation:** Haiku with prompt caching on the system prompt (cost optimization).
- **Pricing (hybrid cost-plus):** Claude (Haiku, tool-forced JSON) estimates only the *resource quantities* a gig needs (LLM calls/tokens, browser-minutes, compute-minutes, runs); a deterministic per-bot `RateCard` converts those quantities to a dollar `cost` (`estimator.ts → applyRateCard`). The model never emits a dollar figure, so the dollars half stays reproducible and auditable. From cost: `target = round(1.5 × cost)` (the firm minimum, no floor/clamp), and the **bid `price = max(target, gig.budget)`** — propose the 1.5× target, but align up to the gig's budget when the gig already pays more. The negotiation floor is the `target`, so a counter is accepted down to 1.5× cost even if we bid higher. Estimates are cached per gig id so proposer and negotiation agree on one number. `pricingCalc` still supplies the timeline + milestone checkpoints and a deterministic baseline price used as the fallback when estimation is unavailable.
- **Report/delivery writing:** Haiku for routine reports, Sonnet for complex reasoning tasks.
- **VerifierBot acceptance criteria evaluation:** Sonnet.
- Cache the system prompt; vary only the gig-specific user message.

### Webhook Events

Each bot registers for: `proposal.accepted`, `milestone.funded`, `milestone.delivered`, `milestone.accepted`, `contract.status.changed`, `acceptance.auto_approved`, `dispute.response_submitted`.

HMAC-verify every inbound webhook using `BOTGUILD_WEBHOOK_SECRET`.

## Required Environment Variables

```
BOTGUILD_API_KEY          # Scopes: read, proposals:write, bots:write
BOTGUILD_API_URL          # https://api.botguild.ai
BOTGUILD_BOT_ID           # Registered bot ID for this service
BOTGUILD_WEBHOOK_SECRET   # HMAC signature secret
ANTHROPIC_API_KEY
```

## Key Design Decisions

See `bots/DESIGN.md` for full rationale. Short version:

- **No database** — In-memory + `jobs.json` is sufficient for hundreds of concurrent gigs and keeps ops simple.
- **Hybrid cost-plus pricing** — Bid `max(1.5 × estimated cost, gig.budget)`: propose 1.5× the guessed cost, or the gig's budget if it already pays more. Claude estimates resource *quantities*; a deterministic per-bot `RateCard` turns them into dollars. No budget floor/clamp — a cheap job yields a cheap bid. Claude never names a price, keeping the dollar math reproducible. (Supersedes the earlier "never ask Claude to price a gig" rule, which forbade Claude any role in pricing.)
- **Prompt caching** — Always cache the Claude system prompt to control token costs.
- **Webhook-first** — Register webhooks on startup; polling is only a fallback, not the primary event source.
- **Single-price escrow, milestone checkpoints** — As of SDK 0.3.0, milestones are progress *checkpoints*, not payment slices: the gig/contract carries one price (`Proposal.price` / `Contract.totalAmount`) funded into escrow, and milestones (`title`, `duration`, `deliverables`) mark verifiable delivery stages along the way. There is no per-milestone `amount`. There are no standing offers or subscriptions (those were dropped from the platform).

## Health & Observability

Each bot exposes `GET /health` → `{ status, botId, uptime, jobCount }`. Fly.io checks this every 30 s.

Logging: structured pino JSON. Every log entry includes `service`, `botId`, and where applicable `gigId`, `contractId`, `durationMs`. Ship logs to Axiom or Logtail via Fly.io drain.

## Success Targets (90-day post-launch)

Per `bots/PRD.md`: 70+ reputation score per bot. (The PRD's original "5+ standing-offer subscriptions" target no longer applies — standing offers/subscriptions were dropped from the platform.)
