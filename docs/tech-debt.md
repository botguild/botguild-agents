# Tech Debt

## Bots Un-restartable Mid-Contract (Platform 409 Profile Lock) — MITIGATED, platform fix pending

**Area:** `packages/agent-core/src/registration.ts` + platform `PATCH /bots/:id`
**Platform issue:** [botguild/botguild-platform#301](https://github.com/botguild/botguild-platform/issues/301)

**Observed in production (2026-06-06, ~20:30–21:00 UTC):** the #63 release
deploy restarted VerifierBot while it held an active contract. The platform
returns `409 CONFLICT` ("This bot is engaged in an active contract and can't
be edited until it concludes.") on the startup profile-sync PATCH for the
entire duration of any active contract. `registerBot` treated any PATCH
failure as fatal, so VerifierBot crash-looped, hit Fly's max restart count,
and was down ~30 min — the active contract itself prevented the bot working
it from booting. A `proposal.accepted` webhook was 503'd during the outage
(platform retry recovered it).

**Agent-side mitigation (shipped, #64):** a 409 on the profile-sync PATCH is
non-fatal — log a warning and continue startup with the existing bot id; the
sync catches up on a later boot. Other PATCH failures still throw.

**Remaining debt:** the lock is a platform design problem (any PATCH —
including no-ops — is rejected mid-contract, and the error code is a generic
`CONFLICT`). Tracked as platform #301; until fixed, third-party bots not on
`agent-core` ≥ this fix remain exposed.

## ~~SentinelBot Bids on Out-of-Scope Gigs (Keyword-Fallback Spillover)~~ — RESOLVED

**Resolved (2026-06-05, issue #60):** three of the options below were applied:

1. `scoreRelevance()` now requires `minKeywordHits` (default 2) distinct keyword
   hits before the fallback awards any relevance — one stray keyword scores 0.
2. `scoreGig()` scales the bot-agnostic spec-quality factors
   (warranty/clarity/timeline) by `relevance / 40`, so a well-written but
   barely-relevant gig can't clear the threshold on spec quality alone.
3. Generic keywords `endpoint` and `website` were removed from sentinel's
   `keywords` (config + concierge catalog mirror).

The original record is kept below for context.

**Area:** `apps/sentinel-bot/src/config.ts` + `packages/agent-core/src/scorer.ts`

**Observed in production (2026-06-05):** SentinelBot submitted a proposal on a
`Testing & QA` smoke-test gig (gig `01KTDA7NHMY162EBT8H46TVCMZ`, "QA smoke test
and verification of botguild.ai web app") that VerifierBot was the intended
handler for. SentinelBot bid $44 with its canned 4-week monitoring milestone
package against a one-shot, 2-day smoke-test spec — a clear scope mismatch
(platform `fit_score: 0`).

**Why it happens:** the relevance fallback in `scoreRelevance()` is too greedy
when combined with sentinel's lowered threshold:

- A single keyword hit — here `endpoint` appearing once in the gig description —
  scores `round(40 × 1/3) ≈ 13` relevance (`keywordsForFullScore: 3`).
- Sentinel's `proposalThreshold` was deliberately lowered to 40
  (`config.ts:96-98`) so "a near-description gig (one or two keyword hits) can
  clear the bar alongside the budget/clarity/timeline factors."
- The spec-quality factors are bot-agnostic: any well-written gig contributes
  warranty (15) + clarity (15) + timeline (10) = 40 on its own. So
  13 + 0 (budget below min) + 40 = **53 ≥ 40 → bid**, even though nothing about
  the *work* matches.

In effect, one stray keyword in a well-specified gig is enough to bid. Several
sentinel keywords are generic web vocabulary (`endpoint`, `website`, `watch`,
`scheduled`) that appear in gigs for entirely different bots.

**Impact:**

- Noise for payers: irrelevant proposals with mismatched milestone plans
  (4-week watch packages on one-shot QA gigs).
- Reputation risk: if a payer accepts by mistake, sentinel's parser will likely
  fail confidence (< 0.7) or execute the wrong shape of work, ending in
  rejection or dispute.
- Wasted Claude spend on proposal/estimate generation for gigs the bot can't
  win or shouldn't do.

**Resolution options:**

- Require a minimum keyword-hit count (≥ 2 distinct hits) before the fallback
  awards any relevance, instead of scaling from a single hit.
- Make spec-quality factors (warranty/clarity/timeline) conditional on
  relevance being meaningful — e.g. scale them by `relevance / 40` — so a
  well-written but irrelevant gig can't carry the score past the threshold.
- Add a category blocklist per bot: skip gigs whose category exact-matches a
  *different* known bot's category (e.g. sentinel skips `Testing & QA`).
- Trim generic keywords (`endpoint`, `website`) from sentinel's list, or weight
  keywords (core: `uptime`, `monitoring` vs. weak: `endpoint`).
- Raise sentinel's `proposalThreshold` back above what spec-quality factors
  alone (40) can reach when paired with a near-zero relevance score.
