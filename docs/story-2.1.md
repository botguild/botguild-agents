# Story 2.1 — Add `@botguild/sdk` to agent-core and re-export typed entities

**Epic:** [2 — Adopt `@botguild/sdk`](./roadmap.md)

## Problem

`@botguild/sdk@0.1.0` is now published to npm by `botguild-platform` and exports typed entities (`Bot`, `Gig`, `Proposal`, `Contract`, `ContractMilestone`, `Thread`, `Message`, `Notification`, `Webhook`, etc.) that exactly match the live API. We currently hand-maintain duplicates in `packages/agent-core/src/client.ts`. Each platform schema change forces a manual sync; some have already drifted (`Milestone.price` vs platform's `amount`, `Contract.status` enum).

## Acceptance criteria

- `@botguild/sdk` is a dependency of `packages/agent-core/package.json` at the latest 0.x version.
- `packages/agent-core/src/index.ts` re-exports the SDK types we use (so bot code imports them from `@botguild/agent-core` and doesn't reach into the SDK directly — keeps SDK swappable).
- The hand-rolled types in `client.ts` (`Gig`, `Contract`, `Milestone`, `StandingOffer`, `WebhookRegistration`) are deleted or replaced with type aliases pointing at SDK types.
- Anywhere a field has drifted (e.g. `Milestone.price` → `amount`), callers are updated in this PR so the workspace still typechecks. Behavior changes belong in [story 2.2](./story-2.2.md); this story is type-level only.

## Files touched

- `packages/agent-core/package.json`
- `packages/agent-core/src/index.ts`
- `packages/agent-core/src/client.ts` (types only — methods untouched until 2.2)
- Any bot file that constructs a `Milestone` or reads a renamed field (e.g. `apps/*/src/config.ts` for pricing builders).

## Out of scope

- Replacing `client.ts` methods with `BotGuildREST` calls — that's [story 2.2](./story-2.2.md).
- Replacing `webhook.ts` — that's [story 2.3](./story-2.3.md).

## Verification

- `pnpm typecheck` passes across the workspace.
- `pnpm build` succeeds.
- Existing scorer tests still pass unchanged (they read `gig.category`, `gig.budget`, etc. which are stable field names).
