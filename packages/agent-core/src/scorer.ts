import type { Gig } from './client.js';
import { criterionText } from './client.js';

export interface ScorerConfig {
  categories: string[]; // category strings this bot handles; an exact match scores full relevance
  keywords?: string[]; // description keywords; a gig "near our description" matches some of these
  keywordsForFullScore?: number; // how many distinct keyword hits earn the full 40 (default 3)
  budgetMin: number; // minimum acceptable budget
  budgetMax: number; // maximum budget (full score)
  proposalThreshold: number; // minimum score to propose (0-100)
}

export interface ScoreBreakdown {
  category: number; // relevance, 0-40 (kept as `category` for back-compat)
  budget: number; // 0-20
  warranty: number; // 0-15
  clarity: number; // 0-15
  timeline: number; // 0-10
  total: number; // sum
}

export function scoreCategory(gig: Gig, categories: string[]): number {
  return categories.includes(gig.category) ? 40 : 0;
}

// Relevance, 0-40. An exact category match earns the full 40. Otherwise we treat
// the gig as a fuzzy/text match against the bot's description: count how many of
// the bot's `keywords` appear in the gig's text, and scale toward 40. This is
// what lets a bot bid on "any job near its description" rather than only gigs
// whose category string matches exactly. A gig that shares zero keywords (and
// isn't an exact category match) scores 0 — and scoreGig zeroes the rest, so we
// never bid on something unrelated.
export function scoreRelevance(gig: Gig, config: ScorerConfig): number {
  if (config.categories.includes(gig.category)) return 40;

  const keywords = config.keywords ?? [];
  if (keywords.length === 0) return 0;

  const haystack = [
    gig.title,
    gig.description,
    gig.category,
    gig.subcategory ?? '',
    ...(gig.tags ?? []),
    ...(gig.deliverables ?? []),
    ...(gig.acceptanceCriteria?.map(criterionText) ?? []),
  ]
    .join(' ')
    .toLowerCase();

  const hits = new Set(
    keywords.map((k) => k.toLowerCase().trim()).filter((k) => k.length > 0 && haystack.includes(k)),
  ).size;

  if (hits === 0) return 0;

  const needed = config.keywordsForFullScore ?? 3;
  const fraction = Math.min(1, hits / Math.max(1, needed));
  return Math.round(40 * fraction);
}

export function scoreBudget(gig: Gig, min: number, max: number): number {
  if (gig.budget < min) return 0;
  if (gig.budget >= max) return 20;
  return Math.round(((gig.budget - min) / (max - min)) * 20);
}

export function scoreWarranty(gig: Gig): number {
  // The live API models warranty as a boolean flag (+ optional min duration),
  // not a free-text `warrantyTerms` field. The old code read a field that
  // never existed on real gigs, so warranty silently scored 0 for everything.
  return gig.warrantyRequired ? 15 : 0;
}

export function scoreClarity(gig: Gig): number {
  // acceptanceCriteria is a structured AcceptanceCriterion[] (SDK 0.3.0). Score
  // on the total text the buyer wrote across all criteria — more detail =
  // clearer spec. (The old code treated it as a single string and compared its
  // length to a 50-char threshold, which against an array measured criteria
  // *count*.)
  if (!gig.acceptanceCriteria || gig.acceptanceCriteria.length === 0) return 0;
  const totalChars = gig.acceptanceCriteria.map(criterionText).join(' ').trim().length;
  return totalChars > 50 ? 15 : 8;
}

export function scoreTimeline(gig: Gig): number {
  return gig.timeline && gig.timeline.length > 0 ? 10 : 0;
}

export function scoreGig(gig: Gig, config: ScorerConfig): ScoreBreakdown {
  const category = scoreRelevance(gig, config);

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
