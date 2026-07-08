// ---------------------------------------------------------------------------
// Headline auto-fit (PRD §9 minimum-font-size gate, FR-6).
//
// Pure, deterministic text-fit estimate: pick the LARGEST font size whose
// greedily word-wrapped headline fits the safe-zone box. The reported size is
// the real size the layout renders at, and the FR-6 gate compares it to the
// per-format floor — if the largest fitting size falls below the floor, the job
// is rejected/renegotiated, never silently shrunk.
//
// The estimate uses an average glyph-advance ratio rather than true Satori
// metrics so it stays a pure function (no wasm, node-testable). It is tuned
// conservative for Inter; the golden render test pins that real output agrees.
// ---------------------------------------------------------------------------

import type { Rect } from '../types.js';

/** Average glyph advance as a fraction of font px for Inter body/headline text. */
export const DEFAULT_CHAR_WIDTH_RATIO = 0.54;
/** Line box height as a fraction of font px (Satori default line-height ≈ 1.2). */
export const DEFAULT_LINE_HEIGHT_RATIO = 1.25;

export interface FitOptions {
  safeZone: Rect;
  maxPx: number;
  minPx: number;
  charWidthRatio?: number;
  lineHeightRatio?: number;
}

export interface FitResult {
  /** Largest font px whose wrapped text fits the box (may be below `minPx`). */
  fontPx: number;
  /** True iff `fontPx >= minPx` — the FR-6 pass condition. */
  fits: boolean;
  /** Wrapped line count at `fontPx`. */
  lines: number;
}

/** Greedy word-wrap: how many lines the text needs given a max chars-per-line. */
function wrappedLineCount(words: string[], charsPerLine: number): number {
  if (charsPerLine < 1) return Number.POSITIVE_INFINITY;
  let lines = 1;
  let current = 0;
  for (const word of words) {
    const add = current === 0 ? word.length : word.length + 1; // +1 for the space
    if (current + add <= charsPerLine) {
      current += add;
    } else {
      lines++;
      current = word.length;
      // A single word longer than the line still occupies (at least) one line;
      // its overflow is caught by the longest-word width check below.
    }
  }
  return lines;
}

/** True when even the longest single word overflows the box width at `px`. */
function longestWordOverflows(
  words: string[],
  px: number,
  ratio: number,
  boxWidth: number,
): boolean {
  const longest = words.reduce((m, w) => Math.max(m, w.length), 0);
  return longest * px * ratio > boxWidth;
}

/**
 * Find the largest font px in `[1, maxPx]` whose wrapped headline fits the safe
 * zone. `fits` reports whether that size clears `minPx` (the FR-6 floor).
 */
export function fitHeadline(text: string, options: FitOptions): FitResult {
  const charWidthRatio = options.charWidthRatio ?? DEFAULT_CHAR_WIDTH_RATIO;
  const lineHeightRatio = options.lineHeightRatio ?? DEFAULT_LINE_HEIGHT_RATIO;
  const words = text
    .trim()
    .split(/\s+/u)
    .filter((w) => w.length > 0);
  const { width, height } = options.safeZone;

  if (words.length === 0) {
    // Empty headline trivially "fits" at the max size; callers gate on content upstream.
    return { fontPx: options.maxPx, fits: options.maxPx >= options.minPx, lines: 0 };
  }

  for (let px = options.maxPx; px >= 1; px--) {
    if (longestWordOverflows(words, px, charWidthRatio, width)) continue;
    const charsPerLine = Math.floor(width / (px * charWidthRatio));
    const lines = wrappedLineCount(words, charsPerLine);
    const blockHeight = lines * px * lineHeightRatio;
    if (blockHeight <= height) {
      return { fontPx: px, fits: px >= options.minPx, lines };
    }
  }
  return { fontPx: 1, fits: false, lines: words.length };
}
