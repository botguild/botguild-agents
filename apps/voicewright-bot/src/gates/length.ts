// Hard length gate (§9): grapheme-aware counting via Intl.Segmenter. Headline
// ≤40 / primary text ≤125 graphemes; when a line contains emoji or non-Latin
// (e.g. CJK) graphemes a conservative 10% margin applies (≤36 / ≤112).
// Over-limit lines are regenerated, never truncated. No pixel-width property
// is measured or warranted.

import type { LengthCheck, Variant } from '../types.js';

export const HEADLINE_LIMIT = 40;
export const PRIMARY_TEXT_LIMIT = 125;
export const HEADLINE_LIMIT_MARGIN = 36; // floor(40 × 0.9)
export const PRIMARY_TEXT_LIMIT_MARGIN = 112; // floor(125 × 0.9)

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Count user-perceived characters (grapheme clusters), not code units. */
export function graphemeLength(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const LETTER_RE = /\p{L}/u;
const LATIN_RE = /\p{Script=Latin}/u;

/**
 * True when the text contains an emoji or a non-Latin-script letter — the §9
 * trigger for the conservative 10% margin. Accented Latin (é, ü) does not
 * trigger it; CJK, Cyrillic, Arabic, and pictographs do.
 */
export function hasEmojiOrNonLatin(text: string): boolean {
  if (EMOJI_RE.test(text)) return true;
  for (const ch of text) {
    if (LETTER_RE.test(ch) && !LATIN_RE.test(ch)) return true;
  }
  return false;
}

export function checkLength(
  field: LengthCheck['field'],
  text: string,
  limit: number,
  marginLimit: number,
): LengthCheck {
  const marginApplied = hasEmojiOrNonLatin(text);
  const effectiveLimit = marginApplied ? marginLimit : limit;
  const graphemes = graphemeLength(text);
  return {
    field,
    graphemes,
    limit: effectiveLimit,
    marginApplied,
    pass: graphemes <= effectiveLimit,
  };
}

/** Run the fit gate over one variant's headline + primary text. */
export function checkVariantLength(
  variant: Pick<Variant, 'headline' | 'primaryText'>,
): LengthCheck[] {
  return [
    checkLength('headline', variant.headline, HEADLINE_LIMIT, HEADLINE_LIMIT_MARGIN),
    checkLength('primaryText', variant.primaryText, PRIMARY_TEXT_LIMIT, PRIMARY_TEXT_LIMIT_MARGIN),
  ];
}

export function lengthGatePasses(checks: LengthCheck[]): boolean {
  return checks.every((c) => c.pass);
}
