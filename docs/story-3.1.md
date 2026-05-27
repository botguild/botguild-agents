# Story 3.1 — Decision doc: subscription adapter vs. discovery-only

**Epic:** [3 — Standing Offers (dropped)](./roadmap.md)
**Type:** Decision, not code. Blocks 3.2 and 3.3.

> **Resolved (historical).** The decision below was made: **Option A — discovery-only**. Standing offers were dropped; `standing.ts`, per-bot `standingOffers` config, and `standinghandler.ts` were removed. Bots transact per-gig via upfront multi-milestone packages. Kept as the decision record.

## Problem

Bots model standing offers as upfront multi-milestone packages (e.g. SentinelBot's "Site Watch Package": 4 weekly milestones at $150). Platform models them as subscriptions: `pricingType ∈ {monthly, weekly, per-use}`, `basePrice`, `billingCycle`, `active_subscribers` counter, `POST /standing-offers/:id/subscribe`.

Underlying constraint: blockchain escrow on BotGuild is **one-shot**. There's no recurring on-chain billing primitive. So even if we adopt the platform's subscription schema, no money will actually move on a recurring schedule — subscriptions are purely a discovery + handshake mechanism that has to terminate in a one-shot escrow per period.

`packages/agent-core/src/standing.ts:19-24` already documents this mismatch and currently swallows sync failures so startup doesn't crash. Best-effort sync probably isn't creating most offers on the platform today.

## Options

### Option A — Discovery-only
Stop creating standing offers entirely. Bots advertise services by posting/responding to gigs only. Standing-offer config in each bot's `config.ts` is removed. Simplest; honors the platform reality.

### Option B — Subscription adapter (one period = one gig)
Adapt the bot's multi-milestone package to platform's monthly/weekly schema. When a payer subscribes, the bot auto-creates a fresh gig + proposal + contract every period (this becomes a new cron job per subscriber). The platform's `subscription.activated/cancelled/paused/resumed` events drive the cron lifecycle.

### Option C — Keep current best-effort sync
Do nothing. Accept that offers may not appear on the platform.

## Acceptance criteria

- This doc is updated with the chosen option, the rationale, and the implications for stories 3.2 + 3.3.
- If Option B: also list the new webhook events the bots need to handle and the cron-orchestration design.
- If Option A: also list what bot-side telemetry / Telegram messaging compensates for the loss of standing-offer discovery.

## Recommendation (for the decision)

**Option A** unless we have a concrete payer asking for a subscription experience. The complexity of Option B (per-subscriber cron + gig auto-creation + handling pause/resume across cron jobs) is high relative to its value while escrow remains one-shot. Discovery-only is honest and gets us un-blocked on Epic 3.

## Verification

- N/A — this is a decision artifact. The "verification" is user sign-off on the chosen option.
