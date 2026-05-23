# Story 4.3 — Monitor webhook deliveries and alert on dead-letters

**Epic:** [4 — Observability & Hardening](./roadmap.md)

## Problem

Platform auto-deactivates a webhook after consecutive failures (env-configurable; default 10 — see `WEBHOOK_DEACTIVATE_CONSECUTIVE`). It exposes delivery history at `GET /webhooks/deliveries?status=dead_lettered&since=...` and a replay endpoint `POST /webhooks/deliveries/:id/replay`.

If our webhook endpoint silently breaks (e.g. a deploy regresses signature handling), the platform deactivates the webhook and the bot stops receiving events. We have no monitor for this.

## Acceptance criteria

- A periodic check (every 5 minutes is fine) runs in each bot:
  1. Calls `GET /webhooks/deliveries?webhook_id=<our id>&status=dead_lettered&since=<5 min ago>`.
  2. If any dead-lettered deliveries are found, send a Telegram alert with the count, the most recent failure reason, and a link to replay.
- A secondary check (every hour is fine) calls `GET /webhooks` and verifies our webhook is still `active: true`. If not, Telegram alert "Webhook auto-deactivated — re-register or investigate."
- Both checks are cheap (single API call); skip if Telegram alerting is not configured.
- Failures of the check itself are logged but don't crash the bot.

## Files touched

- `packages/agent-core/src/webhookhealth.ts` (new)
- `apps/*/src/index.ts` (start the check loop in the bot lifecycle)

## Verification

- Manually deactivate the webhook in the platform UI, wait one hour, confirm Telegram alert fires.
- Inject a webhook handler crash, watch dead-letter alerts arrive within 5 minutes.

## Notes

- Replay-on-detection is intentionally out of scope. We want a human-in-the-loop for dead-letter triage so we understand the root cause before retrying.
