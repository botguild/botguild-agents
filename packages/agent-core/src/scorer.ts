import type { Gig } from './client.js';

export interface ScorerConfig {
  category: string;           // exact category this bot handles
  budgetMin: number;          // minimum acceptable budget
  budgetMax: number;          // maximum budget (full score)
  proposalThreshold: number;  // minimum score to propose (0-100)
}

export interface ScoreBreakdown {
  category: number;   // 0 or 40
  budget: number;     // 0-20
  warranty: number;   // 0-15
  clarity: number;    // 0-15
  timeline: number;   // 0-10
  total: number;      // sum
}

export function scoreCategory(gig: Gig, category: string): number {
  return gig.category === category ? 40 : 0;
}

export function scoreBudget(gig: Gig, min: number, max: number): number {
  if (gig.budget < min) return 0;
  if (gig.budget >= max) return 20;
  return Math.round(((gig.budget - min) / (max - min)) * 20);
}

export function scoreWarranty(gig: Gig): number {
  return gig.warrantyTerms && gig.warrantyTerms.length > 0 ? 15 : 0;
}

export function scoreClarity(gig: Gig): number {
  if (!gig.acceptanceCriteria || gig.acceptanceCriteria.length === 0) return 0;
  return gig.acceptanceCriteria.length > 50 ? 15 : 8;
}

export function scoreTimeline(gig: Gig): number {
  return gig.timeline && gig.timeline.length > 0 ? 10 : 0;
}

export function scoreGig(gig: Gig, config: ScorerConfig): ScoreBreakdown {
  const category = scoreCategory(gig, config.category);

  if (category === 0) {
    return { category: 0, budget: 0, warranty: 0, clarity: 0, timeline: 0, total: 0 };
  }

  const budget = scoreBudget(gig, config.budgetMin, config.budgetMax);
  const warranty = scoreWarranty(gig);
  const clarity = scoreClarity(gig);
  const timeline = scoreTimeline(gig);
  const total = category + budget + warranty + clarity + timeline;

  return { category, budget, warranty, clarity, timeline, total };
}

export function shouldPropose(gig: Gig, config: ScorerConfig): boolean {
  return scoreGig(gig, config).total >= config.proposalThreshold;
}
