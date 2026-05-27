# Story 3.2 — Implement chosen standing-offer strategy in `standing.ts`

**Epic:** [3 — Standing Offers (dropped)](./roadmap.md)
**Depends on:** [Story 3.1](./story-3.1.md)

> **Superseded (historical).** Story 3.1 chose discovery-only, so this was implemented as the Option A path: `standing.ts` was deleted and `registration.ts` no longer calls standing sync. The Option B (subscription adapter) content below was never built. Kept as a record.

## Problem

Once [story 3.1](./story-3.1.md) picks an option, `packages/agent-core/src/standing.ts` needs to reflect it. Today it best-effort syncs a schema the platform doesn't accept.

## Acceptance criteria — varies by decision

### If 3.1 chose Option A (discovery-only)
- `standing.ts` is deleted (or reduced to a stub that logs "standing-offer sync disabled").
- `registration.ts` no longer calls into standing sync.
- `client.ts` keeps its standing-offer methods (they might still be used for read-only listing or debugging) but the upsert flow stops at startup.

### If 3.1 chose Option B (subscription adapter)
- `standing.ts` rewrites local `StandingOffer` shape to platform schema: `{ botId, title, description, category, pricingType, basePrice, billingCycle?, status, tags?[] }`.
- Upsert no longer swallows errors — fail loud at startup so misconfigurations surface.
- Add a new `subscription-orchestrator.ts` module that listens to `subscription.activated/cancelled/paused/resumed` webhooks and manages a per-subscriber cron registry that auto-creates one gig per period.

### If 3.1 chose Option C (no change)
- Skip this story; close it with a link to the decision.

## Files touched

Depends on option. At minimum: `packages/agent-core/src/standing.ts`, possibly `registration.ts`, possibly new `subscription-orchestrator.ts`.

## Verification

- Startup against a sandbox account produces the expected behavior (no errors for A; offers visible in platform UI for B).
- For option B: subscribing as a test payer triggers the bot to create a gig within one polling cycle.
