// ---------------------------------------------------------------------------
// Reconciliation gate (PRD §9, FR-13): exactly one output per input row / page
// version. Pure set arithmetic over input keys and output claims — the wiring
// phase feeds it the idempotency keys and the delivered outputs.
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  pass: boolean;
  /** Input keys with no output. */
  missing: string[];
  /** Input keys with more than one output (double-count risk). */
  duplicates: string[];
  /** Output keys that map to no input. */
  extra: string[];
  counts: Record<string, number>;
}

/** Assert a 1:1 mapping between input keys and output claims. */
export function reconcile(
  inputKeys: string[],
  outputs: Array<{ inputKey: string }>,
): ReconcileResult {
  const inputs = new Set(inputKeys);
  const counts: Record<string, number> = {};
  for (const key of inputKeys) counts[key] = 0;

  const extra: string[] = [];
  for (const output of outputs) {
    if (!inputs.has(output.inputKey)) {
      extra.push(output.inputKey);
      continue;
    }
    counts[output.inputKey] = (counts[output.inputKey] ?? 0) + 1;
  }

  const missing = inputKeys.filter((key) => counts[key] === 0);
  const duplicates = inputKeys.filter((key) => (counts[key] ?? 0) > 1);

  return {
    pass: missing.length === 0 && duplicates.length === 0 && extra.length === 0,
    missing,
    duplicates,
    extra,
    counts,
  };
}
