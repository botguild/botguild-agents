# Story 2.4 — Add MCP client wrapper for warranty + dispute flows

**Epic:** [2 — Adopt `@botguild/sdk`](./roadmap.md)
**Depends on:** [Story 2.1](./story-2.1.md)

## Problem

Platform's MCP server (`POST /mcp/v1`) exposes high-level tools that are easier to call than wiring up the underlying REST endpoints — particularly:

- `raise_warranty_claim` — payer-side, but bots need to know how it works for [story 1.5](./story-1.5.md) handling.
- `respond_to_dispute` — handler-side; lets the bot submit a counter-statement when a contract is disputed or warranty claim filed. **No REST equivalent exists; only MCP exposes this.**
- `get_warranty_status` — handler-side status lookup.

`@botguild/sdk` exports `BotGuildMCP` with `.call(tool, args)` and `.listTools()`.

## Acceptance criteria

- `packages/agent-core/src/mcp.ts` exports an `AgentMcpClient` that wraps `BotGuildMCP` with:
  - The same auth as the REST client (API key from config).
  - Typed methods for `respondToDispute(contractId, response, evidenceUrls?, evidenceType?)` and `getWarrantyStatus(claimId)`. Other MCP tools are out of scope for this story — add them as needed by future flows.
  - The same pino logging treatment as the REST client.
- `dispute.response_submitted` handlers in each bot (added in [story 1.5](./story-1.5.md)) become real: when a dispute or warranty claim is filed against a contract this bot owns, post a default counter-statement (e.g. "Awaiting human review — see contract events for delivery evidence."). Real-time human escalation is out of scope.

## Files touched

- `packages/agent-core/src/mcp.ts` (new)
- `packages/agent-core/src/index.ts` (export)
- `apps/*/src/index.ts` (wire the new handler to call `mcpClient.respondToDispute`)

## Out of scope

- Auto-generating a high-quality dispute response from Claude. The default boilerplate plus a Telegram alert is enough for v1 — humans handle real disputes.
- Bot-side warranty triage. That's a separate epic if/when needed.

## Verification

- Unit test: stub MCP transport, assert `respondToDispute('c_1', 'response text')` issues the `respond_to_dispute` JSON-RPC call with the expected args.
- Manual: trigger a warranty claim in sandbox against a bot-owned contract, confirm the bot posts a default response.
