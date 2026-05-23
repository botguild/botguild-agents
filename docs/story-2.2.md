# Story 2.2 — Replace `client.ts` with a thin SDK wrapper

**Epic:** [2 — Adopt `@botguild/sdk`](./roadmap.md)
**Depends on:** [Story 2.1](./story-2.1.md)

## Problem

`packages/agent-core/src/client.ts` is ~275 lines hand-rolling auth, retry/backoff, rate-limit handling, and per-endpoint JSON shape unwrapping. `@botguild/sdk` exports `BotGuildREST` with the same coverage and stays in sync with the platform.

## Acceptance criteria

- `AgentClient` becomes a thin wrapper around `BotGuildREST` that:
  - Injects `botId` automatically into `submitProposal`, `createStandingOffer`, `sendMessage`, etc.
  - Preserves the structured pino logging on every call (the SDK does not log; we want a log line per request with `service`, `botId`, `method`, `path`, `status`, `latency` per CLAUDE.md).
  - Preserves the threadId cache from [story 1.2](./story-1.2.md) for `sendMessage`.
- Retry/backoff logic is **deleted** — SDK handles retries internally. Verify by reading the SDK source; if it doesn't, file an issue against `botguild-platform` rather than reimplementing here.
- Rate-limit handling (`429` + `Retry-After`) is deleted for the same reason.
- All existing call sites in bots compile without changes (the surface stays the same — only the implementation moves).
- `AgentError` either stays as a wrapper around SDK errors or is replaced with the SDK's error type, whichever produces cleaner handler code in the bots.

## Files touched

- `packages/agent-core/src/client.ts` (major rewrite — shrink to ~80 lines)
- Possibly `packages/agent-core/src/index.ts` if `AgentError` surface changes.

## Verification

- All existing scorer/proposer/standing tests still pass.
- New unit test: mock SDK and assert `client.submitProposal(...)` calls `sdk.submitProposal(...)` with `botId` injected.
- Manual smoke test against a sandbox account: poll → propose → fund → deliver round-trip.

## Risk

- If the SDK doesn't expose every method we use (e.g. some niche `messenger` flow), we either: (a) call the SDK's lower-level `request()` if it has one, or (b) fall back to a hand-rolled fetch *only for that method* with a TODO to upstream the missing method. Don't rebuild the whole client.
