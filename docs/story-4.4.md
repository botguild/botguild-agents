# Story 4.4 — Test coverage for webhook verify, client retry, standing sync

**Epic:** [4 — Observability & Hardening](./roadmap.md)

## Problem

Epic 1 added `client.test.ts` (proposal endpoint + threads-model sendMessage + threadId cache) and `webhook.test.ts` (signature header, payload envelope, deliveryId, malformed body, unknown event, handler throws). What's still untested in agent-core:

- Client retry/backoff and 429 `Retry-After` handling
- Idempotent standing-offer sync (`standing.ts`)
- Webhook registration cleanup logic (`webhookregistration.ts`)
- Bot registration mapping (`registration.ts`)

This story closes those gaps and covers any new modules added by Epic 2 (SDK wrappers).

## Acceptance criteria

- Extend `client.test.ts` (already exists; covers proposal + sendMessage from Epic 1) with:
  - 429 with `Retry-After: 2` waits and retries.
  - 5xx with backoff retries up to 3 times then throws `AgentError`.
  - Network error retries then throws.
  - Standard request injects `X-API-Key` and unwraps the right key from list responses.
- `webhook.test.ts` already covers signature verification + payload parsing (added in Epic 1 story 1.3/1.4). No new work needed unless Epic 2 story 2.3 swaps to SDK helpers, in which case retarget tests at the new surface.
- `standing.test.ts` (new) covers:
  - Local + remote both empty → no calls.
  - Local-only → create call per offer.
  - Remote matches local exactly → no update calls.
  - Local + remote differ → update call with delta.
  - Remote has extras not in local → no delete (we don't own remote-only offers).
- `webhookregistration.test.ts` (new) covers duplicate cleanup behavior.

## Files touched

- `packages/agent-core/src/client.test.ts` (extend with retry/backoff cases)
- `packages/agent-core/src/standing.test.ts` (new)
- `packages/agent-core/src/webhookregistration.test.ts` (new)

## Out of scope

- Tests for bot-specific parsers/runners. That's a separate testing epic; this story is for `agent-core` only.
- E2E tests against a live sandbox. Useful but a different cost class — leave for CI hardening later.

## Verification

- `pnpm test` from the repo root runs all four test files and passes.
- Coverage report (if configured) shows agent-core hot paths exercised.
