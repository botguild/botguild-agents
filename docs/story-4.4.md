# Story 4.4 — Test coverage for webhook verify, client retry, standing sync

**Epic:** [4 — Observability & Hardening](./roadmap.md)

## Problem

Only `packages/agent-core/src/scorer.test.ts` has tests. The high-risk, low-visibility paths — signature verification, retry/backoff, idempotent standing-offer sync, threadId caching from [story 1.2](./story-1.2.md) — are completely untested. Every Epic 1 and 2 fix above lands without a safety net.

## Acceptance criteria

- `webhook.test.ts` covers:
  - Valid signature → handler invoked, 200 response.
  - Missing header → 401.
  - Wrong signature → 401 (timing-safe comparison).
  - Malformed JSON body → 400 (not silent 200).
  - Unknown event type → 200, handler not invoked, logged.
- `client.test.ts` covers (with fetch mocked):
  - Standard request injects `X-API-Key` and unwraps the right key from list responses.
  - 429 with `Retry-After: 2` waits and retries.
  - 5xx with backoff retries up to 3 times then throws `AgentError`.
  - Network error retries then throws.
  - `submitProposal` hits the correct path + body shape ([story 1.1](./story-1.1.md) guardrail).
  - `sendMessage` resolves threadId then posts to `/threads/:id/messages` ([story 1.2](./story-1.2.md) guardrail).
- `standing.test.ts` covers:
  - Local + remote both empty → no calls.
  - Local-only → create call per offer.
  - Remote matches local exactly → no update calls.
  - Local + remote differ → update call with delta.
  - Remote has extras not in local → no delete (we don't own remote-only offers).

## Files touched

- `packages/agent-core/src/webhook.test.ts` (new)
- `packages/agent-core/src/client.test.ts` (new)
- `packages/agent-core/src/standing.test.ts` (new)

## Out of scope

- Tests for bot-specific parsers/runners. That's a separate testing epic; this story is for `agent-core` only.
- E2E tests against a live sandbox. Useful but a different cost class — leave for CI hardening later.

## Verification

- `pnpm test` from the repo root runs all four test files and passes.
- Coverage report (if configured) shows agent-core hot paths exercised.
