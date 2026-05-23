# Story 1.1 — Fix `submitProposal` endpoint path + body shape

**Epic:** [1 — Restore Platform Compatibility](./roadmap.md)
**Severity:** Critical (every proposal currently 404s)

## Problem

`packages/agent-core/src/client.ts:203-208` POSTs to `/gigs/{gigId}/proposals`:

```ts
submitProposal(gigId, draft) {
  return this.request('POST', `/gigs/${gigId}/proposals`, { ...draft, botId });
}
```

Platform exposes proposal creation at `POST /proposals` (see `botguild-platform/apps/api/src/routes/proposals.ts`). The gig is referenced via `gigId` in the request body, not the URL.

The request body also no longer matches: platform expects `{ gigId, botId, price, timeline?, milestones?, warrantyOffer?, processTransparency?, toolchainPlan?, fitScore?, assumptions? }`. Our `ProposalDraft` sends a `coverNote` field that the platform doesn't accept, and a per-milestone shape (`{ title, description, price }`) that doesn't match the platform's (`{ title, amount, duration, deliverables[] }`).

## Acceptance criteria

- `submitProposal` POSTs to `/proposals` with `gigId` in the body.
- Request body uses the platform's field names (`amount` not `price`, `duration` and `deliverables[]` on each milestone).
- `coverNote` is either dropped or folded into a supported field (likely the `assumptions` array or a separate `send_message` after the proposal lands — pick whichever keeps the proposal API call valid).
- `ProposalDraft` type is updated to match; callers in `proposer.ts` and each bot's index.ts compile cleanly.
- Returns `{ proposal: { id, ... } }` (platform wraps response in a `proposal` key) — unwrap to a `proposalId` for the existing caller signature.

## Files touched

- `packages/agent-core/src/client.ts` (method + `ProposalDraft` type + `Milestone` shape)
- `packages/agent-core/src/proposer.ts` (cover note handling)
- `apps/sentinel-bot/src/index.ts`, `apps/flow-bot/src/index.ts`, `apps/verifier-bot/src/index.ts` (anywhere proposal milestones are constructed — bot pricing configs in `config.ts`)

## Out of scope

- Switching to `@botguild/sdk` (that's Epic 2). Keep the hand-rolled client; just fix the path and shape.

## Verification

- Add a unit test that asserts the URL and body shape.
- Manual smoke test: run one bot against `BOTGUILD_API_URL` in a sandbox account, post a test gig, confirm the bot's proposal lands and is visible via `GET /proposals?gigId=<id>`.
