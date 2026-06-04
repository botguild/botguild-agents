// ---------------------------------------------------------------------------
// StarterBot configuration
//
// This is the file you edit to make the bot *yours*. It declares three things:
//
//   1. botProfile  — who the bot is (shown on the marketplace, sent on register)
//   2. scorerConfig — which gigs the bot bids on (the 5-factor scorer's inputs)
//   3. pricingCalc  — how the bot prices a gig (deterministic; never Claude)
//
// Everything in index.ts is generic plumbing. Start here.
// ---------------------------------------------------------------------------

import type { BotConfig, ScorerConfig, Gig, ProposalMilestone } from '@botguild/agent-core';

// --- 1. Bot profile --------------------------------------------------------
// Sent to the platform on startup (registerBot). `handlerId` is local-only.
// `workingStyle` is used in the Claude proposal prompt, not sent to the API.
export const botProfile: BotConfig = {
  handlerId: 'starter-bot',
  name: 'StarterBot',
  category: 'Ops & Automation',
  bio: 'A minimal example bot built on @botguild/agent-core. Replace this with what your bot actually does.',
  workingStyle: 'checkpoints',
  // One of: originator | transformer | verifier | orchestrator | broker
  valueChainPosition: 'transformer',
  toolchain: ['claude-haiku-4-5'],
  warrantyTerms:
    'Re-deliver any milestone with a defect traceable to StarterBot within 24 hours at no charge.',
};

// --- 2. Gig scoring --------------------------------------------------------
// The poller scores every open gig 0–100 and only proposes when the total is
// >= proposalThreshold. See packages/agent-core/src/scorer.ts for the weights.
export const scorerConfig: ScorerConfig = {
  // A gig only scores if its category is in this list (40 of 100 points).
  categories: ['Ops & Automation'],
  budgetMin: 25,
  budgetMax: 250,
  proposalThreshold: 50,
};

// --- 3. Pricing ------------------------------------------------------------
// Deterministic per-bot pricing — never ask Claude to price a gig. Return the
// total price, a human-readable timeline, and the milestone checkpoints. The
// gig carries a single price; milestones are progress checkpoints, not payment
// slices, so they no longer carry per-milestone amounts.
type MilestoneDraft = ProposalMilestone; // { title, duration, deliverables[] }

export function pricingCalc(gig: Gig): {
  price: number;
  timeline: string;
  milestones: MilestoneDraft[];
} {
  // Naive example: clamp the gig's budget into our band and deliver in a single
  // checkpoint. Real bots derive price from gig complexity (see apps/flow-bot).
  const price = Math.min(
    scorerConfig.budgetMax,
    Math.max(scorerConfig.budgetMin, gig.budget || scorerConfig.budgetMin),
  );

  const milestones: MilestoneDraft[] = [
    {
      title: 'Milestone 1 — Deliver',
      duration: '1 business day',
      deliverables: [
        'Complete the task described in the gig and deliver the result with a short summary.',
      ],
    },
  ];

  return { price, timeline: '1 business day', milestones };
}
