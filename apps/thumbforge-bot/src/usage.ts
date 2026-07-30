// ---------------------------------------------------------------------------
// FR-15 monthly render cap — a PURE decision (tested here) over a per-offer D1
// counter. Over-cap requests are HELD, never silently served and never
// "metered" (no metered-billing primitive exists on the platform, §10/§13):
// the response prompts a top-up gig or next-cycle queueing.
// ---------------------------------------------------------------------------

export interface UsageDecision {
  /** `serve` → render + increment the counter; `hold` → 429/held, prompt a top-up. */
  action: 'serve' | 'hold';
  used: number;
  cap: number;
  /** Remaining units in the current period (never negative). */
  remaining: number;
}

/**
 * Decide whether one more render may run this period. `used` is the count
 * already consumed; the render being decided would be the `used + 1`-th, so it
 * is served only while `used < cap`.
 */
export function decideUsage(used: number, cap: number): UsageDecision {
  const remaining = Math.max(0, cap - used);
  return used < cap
    ? { action: 'serve', used, cap, remaining }
    : { action: 'hold', used, cap, remaining: 0 };
}

/** The current billing period key for a per-offer counter: `YYYY-MM` (UTC). */
export function usagePeriod(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The held-over-cap message posted/returned when the monthly cap is reached (FR-15). */
export function overCapMessage(decision: UsageDecision): string {
  return (
    `This request would exceed the contracted monthly render cap (${decision.cap} images this cycle, all used). ` +
    `It is held — not rendered and not billed — because there is no metered-overage billing on the platform. ` +
    `To lift the cap this cycle, post a top-up gig; otherwise it queues for the next monthly cycle.`
  );
}
