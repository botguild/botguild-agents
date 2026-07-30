// Ad-policy checklist v1 — the versioned, in-repo half of the §9 policy gate.
// Deterministic rules only: every failure is reproducible from the variant
// text, so a delivered checklist result can be re-derived in a dispute. The
// human-readable companion is policy/checklist-v1.md; keep the two in sync and
// bump the version (new file, new id) rather than editing rules in place —
// delivered verdicts reference the version that judged them.
//
// Explicitly NOT promised: Meta ad approval. No API checks Meta policy; this
// checklist plus the 21-day warranty carry that risk (§9).

import type { AdBrief, Variant } from '../types.js';

export const CHECKLIST_VERSION = 'v1';

export interface ChecklistRule {
  id: string;
  description: string;
  /** True = pass. Deterministic; no I/O. */
  test(variant: Variant, brief: Pick<AdBrief, 'policyConstraints'>): boolean;
}

function allCopy(variant: Variant): string {
  return `${variant.headline} ${variant.primaryText} ${variant.description}`;
}

// Meta rejects ads that call out personal attributes ("Are you diabetic?").
const PERSONAL_ATTRIBUTE_PATTERNS = [
  /\bare you (?:overweight|obese|diabetic|depressed|anxious|bald(?:ing)?|in debt|broke|single|lonely|pregnant)\b/i,
  /\bdo you (?:suffer|struggle) (?:from|with)\b/i,
  /\byour (?:age|race|religion|sexual orientation|medical condition|disability|financial (?:status|situation))\b/i,
];

// Sensational/unsubstantiated claim language that trips ad review.
const PROHIBITED_CLAIM_PATTERNS = [
  /\bmiracle\b/i,
  /\bcures?\b/i,
  /\bguaranteed? (?:results?|weight loss|income|returns?|winnings?)\b/i,
  /\b100% (?:guaranteed|safe|effective|risk[- ]free)\b/i,
  /\bget rich\b/i,
  /\bno risk\b/i,
];

/** Words ≥4 letters written fully in caps (acronym-length words are allowed). */
function hasShoutingWord(text: string): boolean {
  return /\b[A-Z]{4,}\b/.test(text);
}

/**
 * Buyer-specified prohibitions (e.g. "no weight-loss or body-transformation
 * claims") are enforced as term checks: each constraint's significant words
 * (≥4 letters, stopwords dropped) must not appear in the copy. Deterministic
 * and conservative — the generation prompt carries the full constraint text,
 * this rule is the backstop.
 */
const CONSTRAINT_STOPWORDS = new Set([
  'claims',
  'claim',
  'language',
  'mention',
  'mentions',
  'about',
  'with',
  'without',
  'never',
  'avoid',
  'no',
  'not',
  'any',
  'anything',
  'please',
  'copy',
  'text',
  'words',
  'word',
  'terms',
  'term',
]);

export function constraintTerms(constraint: string): string[] {
  return constraint
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((word) => word.length >= 4 && !CONSTRAINT_STOPWORDS.has(word));
}

export const CHECKLIST_RULES: ChecklistRule[] = [
  {
    id: 'no-personal-attribute-callouts',
    description:
      "Copy must not assert or imply the reader's personal attributes (health, finances, identity).",
    test: (variant) => !PERSONAL_ATTRIBUTE_PATTERNS.some((re) => re.test(allCopy(variant))),
  },
  {
    id: 'no-prohibited-claims',
    description: 'No miracle/cure/guaranteed-outcome or get-rich claim language.',
    test: (variant) => !PROHIBITED_CLAIM_PATTERNS.some((re) => re.test(allCopy(variant))),
  },
  {
    id: 'no-excessive-punctuation',
    description: 'No repeated exclamation or question marks (!!, ??) or !?/?! combinations.',
    test: (variant) => !/[!?]{2,}/.test(allCopy(variant)),
  },
  {
    id: 'no-all-caps-shouting',
    description: 'No fully-capitalized words of 4+ letters (FREE!! style shouting).',
    test: (variant) => !hasShoutingWord(allCopy(variant)),
  },
  {
    id: 'buyer-policy-constraints',
    description: 'Copy must not use the significant terms of any buyer-specified prohibition.',
    test: (variant, brief) => {
      const copy = allCopy(variant).toLowerCase();
      return !brief.policyConstraints.some((constraint) =>
        constraintTerms(constraint).some((term) => copy.includes(term)),
      );
    },
  },
];
