# Story 4.1 — Add `jobCount` and last-webhook timestamp to `/health`

**Epic:** [4 — Observability & Hardening](./roadmap.md)

## Problem

`CLAUDE.md` documents the planned health response as `{ status, botId, uptime, jobCount }`. Current implementation (`packages/agent-core/src/webhook.ts:76-83`) returns `{ status, botId, uptime, version }` — no `jobCount`, no signal that webhooks are actually being received.

Fly.io health checks every 30s. Without `jobCount` and a "last webhook received at" timestamp, an operator can't tell from `/health` whether the bot is alive-but-isolated (process up, no inbound traffic) vs. alive-and-working.

## Acceptance criteria

- `/health` returns: `{ status, botId, uptime, jobCount, lastWebhookAt, lastWebhookEvent, version }`.
- `jobCount` is provided by the bot at startup as a `() => number` callback (each bot's scheduler/store knows its own count — SentinelBot has watch jobs, FlowBot has ETL jobs, VerifierBot has check jobs).
- `lastWebhookAt` is set inside the webhook handler dispatch wrapper, so any inbound event updates it.
- `lastWebhookEvent` is the event name of the most recent delivery (useful for spotting "stuck on one event type" patterns).
- Backwards compatible: `version` stays so any existing dashboards keep working.

## Files touched

- `packages/agent-core/src/webhook.ts` (config takes a `jobCount?: () => number` callback; webhook dispatch updates `lastWebhookAt`/`lastWebhookEvent`)
- `apps/sentinel-bot/src/index.ts`, `apps/flow-bot/src/index.ts`, `apps/verifier-bot/src/index.ts` (pass the callback)

## Verification

- `curl http://localhost:3001/health` on SentinelBot after scheduling a watch job shows `jobCount: 1`.
- After receiving a webhook, `lastWebhookAt` updates.
