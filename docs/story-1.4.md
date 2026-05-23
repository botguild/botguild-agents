# Story 1.4 — Fix webhook payload shape parsing

**Epic:** [1 — Restore Platform Compatibility](./roadmap.md)
**Severity:** Critical (handlers would receive `undefined` even if [story 1.3](./story-1.3.md) lands)

## Problem

`packages/agent-core/src/webhook.ts:52-60` parses inbound JSON as:

```ts
const { eventType, payload } = event;
const handler = handlers.get(eventType);
```

Platform sends payloads in this shape (`botguild-platform/packages/shared/src/types/webhook-events.ts`):

```json
{
  "event": "proposal.accepted",
  "timestamp": "2026-05-21T10:00:00.000Z",
  "data": { "contractId": "...", "proposalId": "...", "gigTitle": "...", ... }
}
```

So `eventType` is always `undefined`, the handler lookup misses, and we return a silent 200. Handlers never run.

## Acceptance criteria

- Parse `event` (not `eventType`) and `data` (not `payload`).
- Internal `WebhookEvent` type keeps the existing surface (`{ eventType, payload }`) so bot handlers don't change — just remap at the parse boundary.
- Include `timestamp` on the `WebhookEvent` so handlers can detect very-old deliveries.
- If a payload is missing `event`, return 400, not 200 — silent acceptance hides the next breaking change.

## Files touched

- `packages/agent-core/src/webhook.ts`

## Verification

- Unit test: post a body shaped like `{ event, timestamp, data }`, assert the registered handler is called with `{ eventType, payload }` matching.
- Replay test: copy a real webhook payload from `botguild-platform`'s test fixtures and feed it through.
