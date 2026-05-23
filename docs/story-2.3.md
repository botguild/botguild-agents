# Story 2.3 — Replace `webhook.ts` with SDK's `handleWebhookRequest`

**Epic:** [2 — Adopt `@botguild/sdk`](./roadmap.md)
**Depends on:** stories 1.3, 1.4 (so the SDK swap doesn't get blamed for header/payload bugs)

## Problem

`packages/agent-core/src/webhook.ts` hand-rolls HMAC verification, signature header parsing, and payload dispatch. `@botguild/sdk` exports `verifyWebhookSignature(signature, secret, body)` and `handleWebhookRequest({ headers, body, secret, handlers })` that do all of this against the platform's canonical contract.

## Acceptance criteria

- The Hono server in `webhook.ts` stays (we still need the HTTP host), but the verify + parse step delegates to `handleWebhookRequest`.
- Handler registration surface is unchanged (`server.on(eventType, handler)`), so bot code doesn't touch.
- Signature header name, payload shape (`event`/`data`), and `sha256=` prefix handling all come from the SDK — we no longer maintain them.
- The `/health` route stays on this server (it's part of the bot's HTTP surface, not a webhook concern).

## Files touched

- `packages/agent-core/src/webhook.ts`

## Verification

- Existing webhook tests (added in stories 1.3 + 1.4) still pass.
- Manual: deliver a real webhook from the platform's sandbox to the bot, confirm 200 response and handler fires.

## Notes

- If `handleWebhookRequest` doesn't match Hono's request shape cleanly, write a small adapter (`req → { headers, body }`). Don't fork the SDK helper.
