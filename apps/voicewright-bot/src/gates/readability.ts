// Advisory readability signal (FR-6) and the FREE readability gig's scoring
// (Story B). Different JS libs' syllable heuristics disagree, so the score is
// meaningful only with the lib pinned — the name + version ship with every
// score, and READABILITY_LIB.version must match the exact pin in package.json.

import readability from 'text-readability';
import type { ReadabilityScore } from '../types.js';

export const READABILITY_LIB = {
  name: 'text-readability',
  version: '1.1.1', // exact pin in package.json — keep in sync
} as const;

/** FK grade ≤ this is "already at plain-language floor" (Story B). */
export const PLAIN_LANGUAGE_FLOOR_GRADE = 5;

export function scoreReadability(text: string): ReadabilityScore {
  return {
    lib: READABILITY_LIB.name,
    version: READABILITY_LIB.version,
    fleschKincaidGrade: readability.fleschKincaidGrade(text),
  };
}

export interface RewriteCheck {
  inputGrade: number;
  rewriteGrade: number;
  atFloor: boolean;
  pass: boolean;
  lib: string;
  version: string;
}

/**
 * Story B acceptance: the rewrite must land at a grade ≤ the input's. When the
 * input is already at the plain-language floor (FK ≤ 5) the delivery states so
 * and the rewrite must merely not raise the grade — which is the same
 * numerical condition, so `atFloor` only changes the delivery wording.
 */
export function checkRewrite(input: string, rewrite: string): RewriteCheck {
  const inputGrade = scoreReadability(input).fleschKincaidGrade;
  const rewriteGrade = scoreReadability(rewrite).fleschKincaidGrade;
  return {
    inputGrade,
    rewriteGrade,
    atFloor: inputGrade <= PLAIN_LANGUAGE_FLOOR_GRADE,
    pass: rewriteGrade <= inputGrade,
    lib: READABILITY_LIB.name,
    version: READABILITY_LIB.version,
  };
}
