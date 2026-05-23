# Story 1.2 — Fix `sendMessage` to use the threads model

**Epic:** [1 — Restore Platform Compatibility](./roadmap.md)
**Severity:** Critical (every status update / clarification 404s)

## Problem

`packages/agent-core/src/client.ts:232-238` POSTs to `/contracts/{contractId}/messages`:

```ts
sendMessage(contractId, content, contentType = 'text/plain') {
  return this.request('POST', `/contracts/${contractId}/messages`, {
    senderBotId: this.botId,
    content,
    contentType,
  });
}
```

Platform uses a threads model. Messages live under `POST /threads/:threadId/messages` (see `botguild-platform/apps/api/src/routes/messages.ts`). A contract has an associated thread; the thread id is returned with the contract via `GET /contracts/:id`.

Also wrong: `contentType` defaults to `'text/plain'` (an HTTP media type). Platform enum is `text | progress_update | delivery_note | clarification_request | system_notice`.

## Acceptance criteria

- `sendMessage` accepts a `contractId` and resolves the matching thread id (cached per contract so we don't re-fetch every send).
- POSTs to `/threads/:threadId/messages` with `{ content, contentType, botId?, metadata? }`.
- Default `contentType` is `'text'`, not `'text/plain'`.
- `messenger.ts` continues to expose the same surface (`sendProgress`, `sendClarificationRequest`, `sendDeliveryNote`, `sendGeneral`) — internally it just passes the correct semantic type.
- If a contract has no thread (edge case), log + return rather than throwing — don't block delivery on a missing thread.

## Implementation notes

- Simplest approach: extend the in-memory contract fetch with a `threadId` field, and add a small `threadIdCache: Map<contractId, threadId>` to the client.
- Alternative: take `threadId` directly as a parameter and push thread lookup into the bots. Cleaner separation, but more call-site churn. **Recommend** the cache approach.

## Files touched

- `packages/agent-core/src/client.ts` (new private `getThreadId(contractId)`; rewrite `sendMessage`)
- `packages/agent-core/src/messenger.ts` (verify it still compiles; default type swap)

## Verification

- Unit test: stub the fetch layer, assert `sendMessage('c_123', 'hi')` resolves the contract's threadId then POSTs `/threads/<id>/messages` with `contentType: 'text'`.
- Manual: send a progress update on an active contract, confirm it appears in the platform UI's thread.
