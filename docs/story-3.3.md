# Story 3.3 — Update each bot's standing-offer config to match new strategy

**Epic:** [3 — Reconcile Standing Offers](./roadmap.md)
**Depends on:** [Story 3.2](./story-3.2.md)

## Problem

Each bot declares its standing offers in `apps/<bot>/src/config.ts`:

- SentinelBot: "Site Watch Package", "API Health Monitor Package"
- FlowBot: "Data Sync Package", "Invoice Processing Batch"
- VerifierBot: "Nightly Smoke Test Package", "Acceptance Review"

These use the bot-side multi-milestone schema. After [story 3.2](./story-3.2.md) rewrites `standing.ts`, each bot's `standingOffers` array needs to match the new schema.

## Acceptance criteria — varies by 3.1 decision

### If Option A (discovery-only)
- Remove `standingOffers` arrays from all three bot configs.
- Promote any standing-offer-specific scheduling logic (e.g. SentinelBot's `standinghandler.ts`) into normal gig-handling flows, or remove it if it has no non-standing-offer callers.

### If Option B (subscription adapter)
- Each bot's `standingOffers` array converts to platform schema: `{ title, description, category, pricingType, basePrice, tags[] }`.
- Pricing must map cleanly: e.g. SentinelBot's "Site Watch Package" at $150/4-weeks becomes `pricingType: 'monthly'`, `basePrice: 150` (or weekly equivalent — pick per bot).
- Each bot's `standinghandler.ts` rewires to the new subscription-driven gig auto-creation flow.

### If Option C
- Skip this story.

## Files touched

- `apps/sentinel-bot/src/config.ts` + `standinghandler.ts`
- `apps/flow-bot/src/config.ts` + `standinghandler.ts`
- `apps/verifier-bot/src/config.ts` + `standinghandler.ts`

## Verification

- Each bot starts cleanly with the new config.
- For Option B: each declared offer appears in `GET /standing-offers?botId=<id>` against sandbox.
- For Option A: each bot still discovers and proposes on ordinary gigs; no startup errors.
