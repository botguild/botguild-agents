// ---------------------------------------------------------------------------
// Deterministic budget guidance
//
// Pricing is NEVER LLM-generated on BotGuild (same rule the bots follow). The
// concierge suggests a single budget from the matched bot's own band plus a set
// of milestone checkpoints. Milestones are progress checkpoints, not payment
// slices — the gig carries one price funded into escrow up front. Payers can
// override — this is guidance, not a quote.
// ---------------------------------------------------------------------------

import type { BotProfile } from './catalog.js';

export type Scope = 'small' | 'medium' | 'large';

export interface BudgetSuggestion {
  total: number;
  scope: Scope;
  milestones: { title: string }[];
  rationale: string;
}

const ROUND = (n: number) => Math.round(n / 5) * 5;

export function suggestBudget(bot: BotProfile, scope: Scope): BudgetSuggestion {
  const { budgetMin, budgetMax } = bot.scorer;
  const span = budgetMax - budgetMin;

  // Position within the bot's band: small ≈ low end, medium ≈ middle, large ≈ top.
  const fraction = scope === 'small' ? 0.25 : scope === 'medium' ? 0.55 : 0.9;
  const total = Math.max(budgetMin, ROUND(budgetMin + span * fraction));

  // Checkpoints structure the work: a setup/scoping stage, then delivery. Large
  // jobs get a mid checkpoint so the buyer sees progress before sign-off. These
  // are verification points — the full price is funded into escrow up front.
  let milestones: { title: string }[];
  if (scope === 'large') {
    milestones = [
      { title: 'Milestone 1 — Setup & plan' },
      { title: 'Milestone 2 — Interim delivery' },
      { title: 'Milestone 3 — Final delivery & sign-off' },
    ];
  } else {
    milestones = [
      { title: 'Milestone 1 — Setup & confirmation' },
      { title: 'Milestone 2 — Delivery' },
    ];
  }

  return {
    total,
    scope,
    milestones,
    rationale:
      `${bot.name}'s budget band is $${budgetMin}–$${budgetMax}; a "${scope}" job lands around $${total}. ` +
      `Full budget points in the scorer are earned at $${budgetMax}. The full price is funded into escrow ` +
      `up front; milestones are checkpoints where the bot delivers and you verify progress before sign-off.`,
  };
}
