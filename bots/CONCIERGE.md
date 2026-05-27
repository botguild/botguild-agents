# Payer Concierge — Design

The **payer concierge** is the demand-side counterpart to the worker bots. Where a worker bot *discovers* gigs and bids on them, the concierge helps a **payer** *create* a well-formed gig and shepherd it to a funded contract.

It ships as a **local MCP server** (`apps/concierge-mcp`), not a hosted service.

## Why this shape

The concierge must be something a newcomer can fork, run in seconds, and drive with the AI assistant they already have. That rules out a chat UI we host and points at MCP:

- **Bring your own AI.** The payer's own assistant (Claude Desktop / Claude Code) is the brain — it understands intent and writes/revises the gig text. The server only supplies BotGuild-specific tools.
- **No hosting.** The assistant spawns the server over stdio with the payer's own key.
- **No multi-tenant auth.** Each payer runs their own instance with their own payer API key in their own env. The "who holds the payer's credentials" problem dissolves — they do, locally.
- **Idiomatic.** `agent-core` already speaks MCP (worker bots use it for disputes/warranty), so an MCP *server* is a natural extension.

## The core idea: the scorer, run in reverse

Worker bots use a 5-factor scorer (`packages/agent-core/src/scorer.ts`) to decide whether to bid: category (40), budget (20), warranty (15), clarity (15), timeline (10). That scorer *is the definition of a good gig*.

The concierge runs the **same scorer** over a payer's draft, against the matched bot's own `ScorerConfig`, and turns a low score into concrete gaps. A gig that scores above a bot's bid threshold is one that bot will compete for — and the clarity points (acceptance criteria) are exactly what prevents disputes later.

## The flow

```
1. Intent    → recommend_bot(need)        pick SentinelBot / FlowBot / VerifierBot
2. Budget    → suggest_budget(bot, scope)  deterministic band + milestone split
3. Draft     → (assistant writes the gig)
4. Score     → score_gig(draft)            breakdown + gaps; iterate until fundable
5. Approve   → create_gig(draft, confirm)  preview first, post only on confirm
6. Fund      → fund_milestone(…, confirm)  release the bot to start
7. Track     → list_my_gigs                proposals & deliveries
```

Steps 1–4 need no credentials, so a payer can try the whole draft-and-score loop offline. Steps 5–7 need a payer API key.

## Tool surface

| Tool | Kind | Notes |
|------|------|-------|
| `recommend_bot` | read | Keyword-ranked match against the reference-bot catalog |
| `suggest_budget` | read | From the bot's pricing band; **never AI-priced** |
| `score_gig` | read | The reverse scorer. Lenient schema so it can critique early drafts |
| `create_gig` | write | Posts only on `confirm: true`; refuses incomplete gigs |
| `fund_milestone` | write | Moves money only on `confirm: true` |
| `list_my_gigs` | read | Track posted gigs |

## Safety model (glass-box)

Two layers protect the write actions:

1. **MCP client approval** — Claude Desktop/Code prompts the human before any tool call.
2. **In-tool `confirm` gate** — `create_gig` / `fund_milestone` return a *preview* (and, for posting, the score) unless `confirm: true`. The assistant is instructed to preview, show the payer, and only confirm on explicit approval.

`create_gig` additionally refuses to post a gig missing a timeline, acceptance criteria, deliverables, or budget. Funding follows the platform's funded-before-work model — a bot starts a stage only once its milestone escrow is funded.

## Reuse vs new

| Concern | Reused from `agent-core` | New |
|---------|--------------------------|-----|
| Gig quality bar | `scoreGig`, `ScorerConfig`, `ScoreBreakdown` | reverse-scorer wrapper (`draft.ts`) |
| Entity types | `Gig` (re-exported from `@botguild/sdk`) | `DraftGig` (zod) |
| Bot knowledge | — | catalog of the 3 reference bots (`catalog.ts`) |
| Pricing | same "never AI-priced" rule the bots follow | deterministic `budget.ts` |
| Platform API | mirrors `AgentClient`'s fetch+retry style | `PayerClient` (`createGig`, `fundMilestone`, `listMyGigs`) |

Constraints inherited from the platform: **multi-milestone packages, not subscriptions** (escrow is one-shot); **deterministic budgets**; **no database**.

## Open items / follow-ups

- **Verify payer API endpoints.** Paths in `src/payerClient.ts` (`POST /gigs`, `GET /gigs?mine=true`, milestone funding) are assumptions, isolated to one file, pending verification against the live payer API — the same way the worker client's paths were corrected during the platform revamp. Drafting and scoring are fully functional today.
- **Track via webhooks.** A later iteration can register payer-side webhooks and relay `proposal.accepted` / `milestone.delivered` back into the conversation, reusing `agent-core`'s webhook server.
- **Optional web surface.** The same tools could back a guided web form on the Pages site for non-Claude users — but the MCP server is the primary, zero-hosting path.
