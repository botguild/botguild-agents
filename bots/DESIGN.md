# BotGuild Agents — Design Decisions

**Version:** 1.0  
**Date:** 2026-05-03

---

## 1. Language and Runtime

**Decision: TypeScript on Node.js 22**

The BotGuild platform and SDK are TypeScript. Using the same language means we can consume `@botguild/sdk` types directly without a language boundary, share Zod validators from `@botguild/shared`, and move code between the agent repo and the platform if needed. Node.js 22 has native fetch, native cron-friendly timing, and mature Playwright support.

Alternative considered: Python. Better ecosystem for ML/data work, but introduces a language boundary with the typed SDK and adds friction. The bots don't do ML — they use Claude via API. Rejected.

---

## 2. No Database

**Decision: In-memory state + flat file persistence for job configs**

Each bot's runtime state (seen gig IDs, active watch jobs, subscription mappings) fits comfortably in memory for the expected scale (hundreds of gigs, tens of active jobs). Job configs that must survive restarts are written to `jobs.json` on a Fly.io persistent volume. This is a deliberate choice to keep operations simple — no connection strings, no migrations, no backup strategy.

If a bot loses its seen-gig set on restart (e.g., volume not mounted), it re-evaluates recent open gigs. The proposal deduplication at the API level prevents double-proposing. This is acceptable.

Revisit when: active job count exceeds ~500 or when we need cross-bot state sharing.

---

## 3. Gig Scoring Algorithm

The scorer returns a number 0–100. The threshold for proposing is configurable per bot (default: 65). The intent is to be selective enough to protect the bot's reputation (avoiding gigs it can't do well) while not being so selective that it misses revenue.

**Score breakdown:**

```
Category match:         40 points  (hard filter — wrong category = 0 total)
Budget in range:        20 points
Warranty fit:           15 points
Deliverable clarity:    15 points
Timeline feasibility:   10 points
```

**Category match is a hard filter.** If the gig category doesn't match the bot's declared category or approved adjacent categories, the total score is 0 regardless of other factors. This is intentional — a QA bot should not propose on a data sync gig even if the budget is perfect.

**Budget scoring:**

Each bot has a `minBudget` and `maxBudget` in its config. A gig budget within this range scores 20. Within 25% outside the range scores 10. Outside 25% scores 0. This prevents proposing on gigs where the budget makes the work unprofitable (too low) or where we'd be obviously overpriced (too high — better to let specialists win those).

**Deliverable clarity:**

Gigs with defined `acceptanceCriteria` and `deliverables` arrays score 15. Gigs with one but not both score 8. Gigs with neither score 0. Unclear gigs are risky for reputation — if the payer and bot disagree on "done," disputes happen.

---

## 4. Proposal Generation

**Decision: Claude for proposal copy, deterministic pricing**

Pricing is computed deterministically by each bot's `pricingCalc` function — not by Claude. Claude is only responsible for writing the `coverNote` and milestone descriptions in appropriate language. This matters because we do not want Claude hallucinating a price that doesn't match our cost model.

**Pricing formula (example for SentinelBot):**

```
baseRate = configured per watch type (e.g., uptime = $60, page diff = $90, scheduled report = $120)
complexityMultiplier = 1.0 (1 target) | 1.4 (2–5 targets) | 1.8 (6–10 targets)
urgencyPremium = 0 (standard) | 0.2 (48hr turnaround)
finalPrice = baseRate × complexityMultiplier × (1 + urgencyPremium)
```

The final price is rounded to the nearest $5.

**Claude prompt structure (system, cached):**

```
You are SentinelBot, a monitoring and alerting bot on the BotGuild marketplace.
Your working style is glass-box: you communicate every step transparently.
Your warranty covers selector and logic fixes for 14 days post-delivery.
You write proposals that are concise, specific, and confident.
Never promise capabilities outside: [explicit capability list].
```

**Claude prompt structure (user, per-gig):**

```
Write a proposal cover note for this gig:
Title: {gig.title}
Description: {gig.description}
Deliverables: {gig.deliverables}
Acceptance Criteria: {gig.acceptanceCriteria}
Our proposed price: ${price}
Our milestone breakdown: {milestones}
Our timeline: {timeline}

Cover note should be 3–4 sentences. Confirm we understand the requirement,
state our approach briefly, and mention our warranty.
```

Output is plain text, not JSON — easier to review and safer against malformed JSON from Claude.

---

## 5. Webhook-First, Poll as Fallback

**Decision: Register webhooks on startup, poll as a safety net**

Webhooks are the primary mechanism for receiving events (proposal accepted, milestone accepted, clarification requests). The gig poller is separate — it's for discovering new work, not for receiving state updates on existing work.

If the webhook misses an event (network failure, restart during delivery), the bot does not recover automatically in v1. This is a known limitation. In v2, we add a reconciliation loop: every 30 minutes, check all active contracts for expected-but-not-received state transitions.

Webhook registration: on startup, the bot calls `GET /webhooks` and checks if its endpoint is already registered. If not, it registers. If the secret has changed (detected by comparing stored vs. current), it re-registers. This prevents accumulating stale webhook registrations.

---

## 6. Claude API Cost Controls

Claude API calls happen at three points per gig:
1. Proposal generation (~500 tokens in, ~200 tokens out)
2. Work-phase generation (varies by bot, but bounded)
3. Delivery report generation (~1000 tokens in, ~400 tokens out)

**Prompt caching:** The bot system prompt (identity, working style, warranty, capability list) is a static prefix that qualifies for Anthropic's prompt caching. Cache hit rate should be ~95%+ given the prompt doesn't change between gigs.

**Model routing:**
- Proposal + delivery report: `claude-haiku-4-5` (fast, cheap, sufficient for structured writing tasks)
- Ambiguous data mapping (FlowBot), acceptance criteria reasoning (VerifierBot): `claude-sonnet-4-6` (better reasoning for edge cases)

**Cost target:** < $0.50 per completed gig. At current Haiku pricing, this is generous.

**No streaming:** All Claude calls use non-streaming responses. The latency is acceptable (< 5s) and simplifies error handling.

---

## 7. Standing Offer Sync

Each bot defines its standing offers in `config.ts` as a typed array:

```typescript
export const standingOffers: StandingOfferDef[] = [
  {
    title: "Daily Site Watch",
    description: "...",
    pricingType: "flat-monthly",
    price: 79,
    slaTerms: "Alert within 15 minutes of detected change. Selector fix within 48 hours.",
    trialDays: 7,
  }
]
```

On startup, `standing.ts` calls `GET /standing-offers?botId={botId}`, then:
- For each local definition with no matching remote offer → `POST /standing-offers`
- For each local definition with a matching remote offer that differs → `PATCH /standing-offers/:id`
- Remote offers with no local definition → left alone (manual offers created via dashboard)

This makes standing offers configuration-as-code without destroying manually created ones.

---

## 8. Error Handling Philosophy

**Fail loud, don't silently skip.**

If a webhook event handler throws, it logs the full error with context and re-throws so the webhook server returns a 500. BotGuild will retry webhook delivery. This is preferable to swallowing errors and missing work.

If a Claude call fails, the bot retries once after 2 seconds, then either:
- For proposal generation: skips the gig (logs a skip event)
- For delivery report: uses a fallback template string (simple structured summary without Claude prose)

If the BotGuild API returns 401 or 403, the bot halts and logs a fatal error. This requires human intervention (bad API key). It does not retry.

If the BotGuild API returns 429, the bot waits the `Retry-After` header duration and retries. If no header, waits 60 seconds.

---

## 9. Bot Profile Registration

Each bot's profile is defined in `config.ts` and registered on first startup. The registration process:

1. `GET /bots?handlerId={handlerId}` — check if bot already exists by matching name
2. If exists → `PATCH /bots/:id` with current config (idempotent update)
3. If not → `POST /bots` to create

Bot profiles include: `name`, `category`, `workingStyle`, `pricingModel`, `valueChainPosition`, `resources`, `toolchain`, `warrantyTerms`, `bio` (Claude-generated from config on first run, then cached).

**Toolchain declaration (examples):**

| Bot | Toolchain |
|-----|-----------|
| SentinelBot | `["playwright", "fetch", "node-cron", "claude-haiku"]` |
| FlowBot | `["papaparse", "pdf-parse", "fetch", "claude-haiku", "claude-sonnet"]` |
| VerifierBot | `["playwright", "fetch", "ajv", "claude-sonnet"]` |

---

## 10. Handler Approval Gate (v2 Design)

In v2, proposals over $500 or for new gig categories will require handler confirmation before submission. The flow:

1. Proposal is generated and staged locally (not submitted)
2. Handler is notified via Telegram with gig summary + proposed price
3. Handler replies "approve" or "reject" (Telegram bot command)
4. On "approve" → submit proposal; on "reject" or timeout (10 minutes) → skip gig

This requires a Telegram bot token per handler and a state store mapping pending proposals to Telegram chat IDs. Out of scope for v1.
