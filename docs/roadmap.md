# Agent Revamp Roadmap

Driven by an audit of `../botguild-platform` (REST API, MCP server, `@botguild/sdk@0.1.0`, webhook contract) against the current `botguild-agents` implementation. Several endpoints, headers, and payload shapes have drifted; this roadmap captures the work to re-align.

Stories are sized to land as individual PRs. Each story has its own file: `docs/story-<epic>.<story>.md`.

---

## Epic 1 — Restore Platform Compatibility (critical)

The bots are currently broken against the live platform in several places. Nothing else matters until these are fixed.

| Story | Title |
|-------|-------|
| [1.1](./story-1.1.md) | Fix `submitProposal` endpoint path + body shape |
| [1.2](./story-1.2.md) | Fix `sendMessage` to use the threads model |
| [1.3](./story-1.3.md) | Fix webhook signature header name |
| [1.4](./story-1.4.md) | Fix webhook payload shape parsing |
| [1.5](./story-1.5.md) | Align registered webhook events with platform's emitted set |

## Epic 2 — Adopt `@botguild/sdk` (high leverage)

Platform now publishes a typed SDK (`@botguild/sdk@0.1.0`) on npm with REST client, MCP client, and webhook helpers. Adopting it deletes ~300 lines of hand-rolled code and keeps us automatically aligned with future platform changes.

| Story | Title |
|-------|-------|
| [2.1](./story-2.1.md) | Add `@botguild/sdk` to agent-core and re-export typed entities |
| [2.2](./story-2.2.md) | Replace `client.ts` with a thin SDK wrapper |
| [2.3](./story-2.3.md) | Replace `webhook.ts` with SDK's `handleWebhookRequest` |
| [2.4](./story-2.4.md) | Add MCP client wrapper for warranty + dispute flows |

## Epic 3 — Reconcile Standing Offers

Bots model upfront multi-milestone packages; platform expects subscription pricing (`monthly | weekly | per-use`). Blockchain escrow is one-shot, so even with the platform schema in place, no money will move on a recurring schedule — a subscription period would have to terminate in a fresh one-shot escrow each time. Decision needed before code change.

| Story | Title |
|-------|-------|
| [3.1](./story-3.1.md) | Decision doc: subscription adapter vs. discovery-only |
| [3.2](./story-3.2.md) | Implement chosen standing-offer strategy in `standing.ts` |
| [3.3](./story-3.3.md) | Update each bot's standing-offer config to match new strategy |

## Epic 4 — Observability & Hardening

Once compatibility is restored, close gaps that make production debugging hard.

| Story | Title |
|-------|-------|
| [4.1](./story-4.1.md) | Add `jobCount` and last-webhook timestamp to `/health` |
| [4.2](./story-4.2.md) | Surface bot reputation in startup alerts |
| [4.3](./story-4.3.md) | Monitor webhook deliveries and alert on dead-letters |
| [4.4](./story-4.4.md) | Test coverage for webhook verify, client retry, standing sync |

---

## Sequencing notes

- **Epic 1 must land before Epic 2.** Otherwise we don't know whether breakage came from the SDK swap or from preexisting drift.
- **Epic 2 can land incrementally** (one story per PR), with the hand-rolled client kept until story 2.2 replaces it.
- **Epic 3 is blocked on a product decision** (story 3.1), not on engineering. Park it until the decision is made.
- **Epic 4 is independent** and can be picked up in parallel by anyone.
