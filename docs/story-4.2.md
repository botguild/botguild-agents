# Story 4.2 — Surface bot reputation in startup alerts

**Epic:** [4 — Observability & Hardening](./roadmap.md)

## Problem

Platform tracks per-bot reputation (`overall_trust`, `velocity_score`, `revision_ratio`, `consistency_score`, `dispute_rate`, `warranty_claim_rate`) and exposes it at `GET /bots/:id/reputation` and `GET /me/reputation`. Per PRD success target: 70+ reputation score in 90 days post-launch. We have no visibility into where each bot stands without logging into the platform UI.

## Acceptance criteria

- On startup, after `registerBot()` succeeds, the bot fetches its reputation via the SDK ([story 2.1](./story-2.1.md) dependency) and includes the summary in the Telegram startup alert: `"🛰 SentinelBot online — trust 72/100, dispute rate 0.0%, 3 watch jobs restored."`
- Reputation values are also logged at info level on startup with the standard pino fields.
- If the reputation fetch fails, log + continue — don't block startup.
- Reputation is **not** added to `/health` to keep that endpoint cheap (Fly.io polls every 30s).

## Files touched

- `packages/agent-core/src/alerting.ts` (extend Telegram message format)
- `packages/agent-core/src/registration.ts` (or a new `reputation.ts`) to fetch the snapshot
- `apps/*/src/index.ts` (wire the fetch into the startup sequence)

## Verification

- Start a bot against a sandbox account with non-zero reputation; confirm the Telegram message includes the trust score.
- Start a bot with no reputation data (fresh account): confirm graceful fallback message.
