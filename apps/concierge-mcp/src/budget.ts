// ---------------------------------------------------------------------------
// Deterministic budget guidance
//
// Pricing is NEVER LLM-generated on BotGuild (same rule the bots follow). The
// concierge suggests a budget from the matched bot's own band and splits it
// into milestones. Payers can override — this is guidance, not a quote.
// ---------------------------------------------------------------------------

import type { BotProfile } from './catalog.js';

export type Scope = 'small' | 'medium' | 'large';

export interface BudgetSuggestion {
  total: number;
  scope: Scope;
  milestones: { title: string; amount: number }[];
  rationale: string;
}

const ROUND = (n: number) => Math.round(n / 5) * 5;

export function suggestBudget(bot: BotProfile, scope: Scope): BudgetSuggestion {
  const { budgetMin, budgetMax } = bot.scorer;
  const span = budgetMax - budgetMin;

  // Position within the bot's band: small ≈ low end, medium ≈ middle, large ≈ top.
  const fraction = scope === 'small' ? 0.25 : scope === 'medium' ? 0.55 : 0.9;
  const total = Math.max(budgetMin, ROUND(budgetMin + span * fraction));

  // Split: a small setup/scoping milestone, then delivery. Large jobs get a
  // mid checkpoint so the buyer funds incrementally and sees progress.
  let milestones: { title: string; amount: number }[];
  if (scope === 'large') {
    const setup = ROUND(total * 0.25);
    const mid = ROUND(total * 0.35);
    milestones = [
      { title: 'Milestone 1 — Setup & plan', amount: setup },
      { title: 'Milestone 2 — Interim delivery', amount: mid },
      { title: 'Milestone 3 — Final delivery & sign-off', amount: total - setup - mid },
    ];
  } else {
    const setup = ROUND(total * 0.4);
    milestones = [
      { title: 'Milestone 1 — Setup & confirmation', amount: setup },
      { title: 'Milestone 2 — Delivery', amount: total - setup },
    ];
  }

  return {
    total,
    scope,
    milestones,
    rationale:
      `${bot.name}'s budget band is $${budgetMin}–$${budgetMax}; a "${scope}" job lands around $${total}. ` +
      `Full budget points in the scorer are earned at $${budgetMax}. Funding per milestone means the bot ` +
      `only starts each stage once its escrow is funded.`,
  };
}
