// ---------------------------------------------------------------------------
// Gig draft + the SCORER RUN IN REVERSE
//
// The worker bots use the 5-factor scorer to decide whether to bid. The
// concierge runs that exact scorer over a payer's draft and turns a low score
// into concrete, actionable gaps — so the payer ships a gig bots will compete
// for, with the clarity that prevents disputes.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { scoreGig, type ScorerConfig, type ScoreBreakdown, type Gig } from '@botguild/agent-core';

// Kept deliberately lenient so score_gig can critique an EARLY/incomplete draft
// and report what's missing — that's the point of the reverse scorer. Hard
// completeness is enforced in create_gig before anything is posted.
export const draftGigShape = {
  title: z.string().min(3).describe('Short, specific gig title'),
  category: z
    .string()
    .default('')
    .describe(
      'Marketplace category — must match the target bot (e.g. "Ops & Automation", "Testing & QA", "Monitoring")',
    ),
  budget: z.number().nonnegative().default(0).describe('Total budget in USD'),
  timeline: z.string().default('').describe('Human deadline, e.g. "5 business days"'),
  acceptanceCriteria: z
    .array(z.string())
    .default([])
    .describe('Concrete, checkable statements of what "done" means'),
  deliverables: z.array(z.string()).default([]).describe('What the buyer actually receives'),
  warrantyRequired: z
    .boolean()
    .optional()
    .describe('Require a re-delivery warranty (bounds buyer risk)'),
  description: z.string().optional().describe('Longer free-text brief'),
};

export const DraftGigSchema = z.object(draftGigShape);
export type DraftGig = z.infer<typeof DraftGigSchema>;

/**
 * The scorer only reads category / budget / warrantyRequired /
 * acceptanceCriteria / deliverables / timeline, so a draft shaped like a Gig is
 * sufficient. Cast through unknown because the full SDK Gig has many more
 * (irrelevant-to-scoring) fields.
 */
function toGig(d: DraftGig): Gig {
  return {
    category: d.category,
    budget: d.budget,
    warrantyRequired: d.warrantyRequired ?? false,
    acceptanceCriteria: d.acceptanceCriteria,
    deliverables: d.deliverables,
    timeline: d.timeline,
  } as unknown as Gig;
}

export interface DraftScore {
  breakdown: ScoreBreakdown;
  gaps: string[];
  fundable: boolean;
  verdict: string;
}

export function scoreDraft(d: DraftGig, cfg: ScorerConfig, botName: string): DraftScore {
  const breakdown = scoreGig(toGig(d), cfg);
  const gaps: string[] = [];

  if (breakdown.category === 0) {
    const lead = d.category
      ? `Category "${d.category}" isn't handled by ${botName}.`
      : 'No category set.';
    gaps.push(
      `${lead} Use one of: ${cfg.categories.join(', ')}. ` +
        `Category is worth 40 pts — without a match the gig scores 0.`,
    );
  }
  if (breakdown.category > 0 && breakdown.budget < 20) {
    gaps.push(
      `Budget $${d.budget} is below ${botName}'s sweet spot — full budget points (20) are earned at $${cfg.budgetMax} ` +
        `(minimum $${cfg.budgetMin}). Currently ${breakdown.budget}/20.`,
    );
  }
  if (breakdown.clarity === 0) {
    gaps.push(
      'Add acceptanceCriteria — concrete, checkable statements of "done". Worth 15 pts and the #1 way to avoid disputes.',
    );
  } else if (breakdown.clarity === 8) {
    gaps.push(
      'Expand acceptanceCriteria detail (aim for >50 chars total across criteria) to earn the full 15 clarity pts.',
    );
  }
  if (breakdown.timeline === 0) {
    gaps.push('Add a timeline / deadline (10 pts).');
  }
  if (breakdown.warranty === 0) {
    gaps.push(
      'Optional: set warrantyRequired — requiring a re-delivery warranty bounds your risk and earns 15 pts.',
    );
  }
  if (d.deliverables.length === 0) {
    gaps.push(
      'List deliverables — what the buyer receives. Not scored directly, but ambiguity here is the top dispute cause.',
    );
  }

  const fundable = breakdown.total >= cfg.proposalThreshold;
  const verdict = fundable
    ? `Fundable — scores ${breakdown.total}/100, at or above ${botName}'s bid threshold (${cfg.proposalThreshold}). ${botName} would compete for this gig.`
    : `Scores ${breakdown.total}/100 — below ${botName}'s bid threshold (${cfg.proposalThreshold}). Address the gaps so bots will bid.`;

  return { breakdown, gaps, fundable, verdict };
}
