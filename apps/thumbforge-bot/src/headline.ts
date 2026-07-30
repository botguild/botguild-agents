// ---------------------------------------------------------------------------
// FR-6 headline-fit decision (PURE, tested here). The render core reports
// whether the headline fit its safe zone (`headlineFits`) and the font size it
// settled on (`headlineFontPx`); this decides accept vs reject/renegotiate. A
// headline that cannot render at or above the declared floor is REJECTED —
// never silently shrunk (§9). No Workers globals, so the wiring test drives it
// directly with numbers.
// ---------------------------------------------------------------------------

export type HeadlineDecision =
  | { accept: true; fontPx: number }
  | { accept: false; reason: string; fontPx: number; minFontPx: number };

/**
 * Accept only when the layout reported the headline fits AND the settled font
 * size is at or above the layout's minimum. Either failure rejects.
 */
export function decideHeadline(
  headlineFits: boolean,
  headlineFontPx: number,
  minFontPx: number,
): HeadlineDecision {
  if (headlineFits && headlineFontPx >= minFontPx) {
    return { accept: true, fontPx: headlineFontPx };
  }
  return {
    accept: false,
    fontPx: headlineFontPx,
    minFontPx,
    reason:
      `The headline cannot render at or above the ${minFontPx}px minimum font size inside its safe zone ` +
      `(it would need ${headlineFontPx}px). Per the gig terms it is rejected rather than shrunk below the floor: ` +
      `please shorten the headline or approve a smaller safe-zone layout.`,
  };
}

/** The buyer-facing reject/renegotiate message for a failed headline fit (FR-6). */
export function headlineRejectionMessage(
  decision: Extract<HeadlineDecision, { accept: false }>,
): string {
  return decision.reason;
}
