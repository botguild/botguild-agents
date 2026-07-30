// Checklist runner — evaluates the versioned ad-policy checklist
// (src/policy/checklist-v1.ts) against one variant and returns the result
// snapshot delivered in the JSON report (§9/FR-7).

import type { AdBrief, ChecklistResult, Variant } from '../types.js';
import { CHECKLIST_RULES, CHECKLIST_VERSION } from '../policy/checklist-v1.js';

export function runChecklist(
  variant: Variant,
  brief: Pick<AdBrief, 'policyConstraints'>,
): ChecklistResult {
  const failures = CHECKLIST_RULES.filter((rule) => !rule.test(variant, brief)).map((rule) => ({
    ruleId: rule.id,
    description: rule.description,
  }));
  return { version: CHECKLIST_VERSION, pass: failures.length === 0, failures };
}
