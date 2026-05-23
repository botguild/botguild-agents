# Story 1.5 — Align registered webhook events with platform's emitted set

**Epic:** [1 — Restore Platform Compatibility](./roadmap.md)
**Severity:** Critical (we register for events that never fire; we miss the one that signals "start work")

## Problem

Each bot registers a fixed event list (e.g. `apps/sentinel-bot/src/index.ts:90-99`):

```ts
events: [
  'gig.created',
  'gig.updated',
  'contract.created',
  'contract.updated',
  'message.created',
  'proposal.accepted',
  'milestone.accepted',
  'message.clarification_request',
  'contract.status.changed',
]
```

Platform's actual Group A (dispatched) events are: `proposal.accepted`, `milestone.funded`, `milestone.delivered`, `milestone.accepted`, `contract.status.changed`, `acceptance.auto_approved`, `dispute.response_submitted`.

So:

- **Phantom registrations** that never fire: `gig.created`, `gig.updated`, `contract.created`, `contract.updated`, `message.created`, `message.clarification_request`. Harmless but misleading.
- **Missing the real "start work" signal**: `milestone.funded`. Currently bots react to `proposal.accepted` and assume escrow is funded, but a contract is `draft` until escrow funding lands. Starting work on `proposal.accepted` risks doing free work if the payer never funds.
- **Missing `acceptance.auto_approved`**: when the 72h window expires and the payer auto-accepts, the bot doesn't get notified to advance state.

## Acceptance criteria

- Each bot registers only events the platform actually dispatches.
- Each bot adds a `milestone.funded` handler that triggers work execution (the current `proposal.accepted` handler should be split: registration/prep stays on `proposal.accepted`, but actual work starts on `milestone.funded`).
- Each bot handles `acceptance.auto_approved` (treat it like `milestone.accepted`).
- Each bot handles `dispute.response_submitted` if the bot is the handler in a dispute (Sentinel/Flow/Verifier — log + alert for now; richer flow lives in [story 2.4](./story-2.4.md)).

## Files touched

- `apps/sentinel-bot/src/index.ts` (events list + new handlers)
- `apps/flow-bot/src/index.ts`
- `apps/verifier-bot/src/index.ts`
- Possibly a shared `EVENTS` constant in `packages/agent-core/src/webhook.ts` so the list lives in one place.

## Notes

- The work-execution split (`proposal.accepted` → prep only; `milestone.funded` → run) is a behavior change. Confirm with the user that idle-until-funded is the desired posture before changing FlowBot/SentinelBot job kickoff. Document the decision in the PR.

## Verification

- Unit test: each bot's handler map contains the expected event names.
- Manual: post a gig, accept the bot's proposal, do **not** fund — confirm the bot prepares but does not execute. Then fund and confirm execution starts.
