// Deterministic angle-diversity floor (§9): ≥3 angle groups where every
// cross-group variant pair has word-bigram Jaccard similarity ≤ threshold,
// computed on normalized text (lowercased, punctuation stripped). The
// threshold value ships from config (0.5, PROVISIONAL until Phase 2
// calibration). Model-assigned angle tags are labels only — the pairwise
// check is what satisfies the gate. The recurring tier's differs-from-prior
// criterion reuses the same mechanism against the prior cycle's variants.

import type { Variant } from '../types.js';

/** Lowercase, strip punctuation/symbols, collapse whitespace. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word bigrams of the normalized text. Single-word texts yield the word itself. */
export function wordBigrams(text: string): Set<string> {
  const words = normalizeText(text).split(' ').filter((w) => w.length > 0);
  if (words.length === 0) return new Set();
  if (words.length === 1) return new Set([words[0] as string]);
  const bigrams = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.add(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1; // two empty texts are identical
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** The text a variant is compared on: all buyer-visible copy. */
function variantText(variant: Variant): string {
  return `${variant.headline} ${variant.primaryText} ${variant.description}`;
}

export interface PairScore {
  aId: string;
  bId: string;
  similarity: number;
}

export interface DiversityResult {
  pass: boolean;
  distinctAngles: number;
  requiredAngles: number;
  threshold: number;
  /** Every cross-group pair, for the report. */
  pairScores: PairScore[];
  /** Cross-group pairs exceeding the threshold. */
  violations: PairScore[];
}

/**
 * Batch diversity gate: passes when the variants span ≥ requiredAngles angle
 * groups AND no cross-group pair exceeds the similarity threshold (a pair AT
 * the threshold passes — the gate wording is "≤ threshold").
 */
export function evaluateDiversity(
  variants: Variant[],
  options: { threshold: number; requiredAngles: number },
): DiversityResult {
  const bigrams = new Map(variants.map((v) => [v.id, wordBigrams(variantText(v))]));
  const pairScores: PairScore[] = [];
  const violations: PairScore[] = [];

  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const a = variants[i] as Variant;
      const b = variants[j] as Variant;
      if (a.angle === b.angle) continue; // the floor constrains cross-group pairs
      const similarity = jaccardSimilarity(bigrams.get(a.id) as Set<string>, bigrams.get(b.id) as Set<string>);
      const score = { aId: a.id, bId: b.id, similarity };
      pairScores.push(score);
      if (similarity > options.threshold) violations.push(score);
    }
  }

  const distinctAngles = new Set(variants.map((v) => v.angle)).size;
  return {
    pass: distinctAngles >= options.requiredAngles && violations.length === 0,
    distinctAngles,
    requiredAngles: options.requiredAngles,
    threshold: options.threshold,
    pairScores,
    violations,
  };
}

export interface PriorCycleResult {
  pass: boolean;
  threshold: number;
  violations: PairScore[];
}

/**
 * Recurring-tier differs-from-prior-cycle gate (FR-10): every new variant must
 * sit at or below the threshold against every prior-cycle variant.
 */
export function differsFromPriorCycle(
  current: Variant[],
  prior: Variant[],
  threshold: number,
): PriorCycleResult {
  const violations: PairScore[] = [];
  const priorBigrams = prior.map((p) => ({ id: p.id, bigrams: wordBigrams(variantText(p)) }));
  for (const variant of current) {
    const currentBigrams = wordBigrams(variantText(variant));
    for (const p of priorBigrams) {
      const similarity = jaccardSimilarity(currentBigrams, p.bigrams);
      if (similarity > threshold) {
        violations.push({ aId: variant.id, bId: p.id, similarity });
      }
    }
  }
  return { pass: violations.length === 0, threshold, violations };
}
