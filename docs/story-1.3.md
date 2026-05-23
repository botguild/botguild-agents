# Story 1.3 — Fix webhook signature header name

**Epic:** [1 — Restore Platform Compatibility](./roadmap.md)
**Severity:** Critical (every inbound webhook is rejected as "Invalid or missing signature")

## Problem

`packages/agent-core/src/webhook.ts:45` reads:

```ts
const signature = c.req.header('X-Webhook-Signature') ?? '';
```

Platform dispatches inbound webhooks with header `X-BotGuild-Signature: sha256=<hex>` and also sends `X-BotGuild-Event` and `X-BotGuild-Delivery` headers (see `botguild-platform/packages/sdk/src/webhook-verify.ts`). Our handler doesn't see the signature, so every request hits the 401 branch.

## Acceptance criteria

- Webhook server reads `X-BotGuild-Signature` (preserve the existing `sha256=` prefix handling — that part is already correct).
- `X-BotGuild-Event` and `X-BotGuild-Delivery` are surfaced to handlers (e.g. on the `WebhookEvent` type) so handlers can log/dedupe by delivery id.
- HMAC verification logic itself stays — the signature scheme (SHA256, hex) hasn't changed.

## Files touched

- `packages/agent-core/src/webhook.ts` (header name; extend `WebhookEvent` with `eventType` and `deliveryId`)

## Out of scope

- Swapping to SDK's `handleWebhookRequest` (Epic 2 story 2.3 does that). For this story, just fix the header name in the existing code.

## Verification

- Add a unit test: hand-craft a request with `X-BotGuild-Signature: sha256=<computed>` and assert the handler returns 200.
- Negative test: assert that a request missing the header still returns 401.
- Manual: tail logs and watch the next real inbound delivery — should see handler fire instead of 401.
