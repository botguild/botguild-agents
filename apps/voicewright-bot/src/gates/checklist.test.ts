import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecklist } from './checklist.js';
import { CHECKLIST_VERSION, constraintTerms } from '../policy/checklist-v1.js';
import type { Variant } from '../types.js';

const variant = (overrides: Partial<Variant> = {}): Variant => ({
  id: 'v1',
  angle: 'value',
  headline: 'Better mornings, smaller prices',
  primaryText: 'Coffee that tastes like a treat without the boutique markup.',
  description: 'Shop roasts',
  ...overrides,
});

const noConstraints = { policyConstraints: [] as string[] };

test('clean copy passes every rule and reports the checklist version', () => {
  const result = runChecklist(variant(), noConstraints);
  assert.equal(result.pass, true);
  assert.equal(result.failures.length, 0);
  assert.equal(result.version, CHECKLIST_VERSION);
});

test('personal-attribute call-outs fail', () => {
  const result = runChecklist(
    variant({ primaryText: 'Are you overweight? We can help.' }),
    noConstraints,
  );
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.ruleId === 'no-personal-attribute-callouts'));

  const suffering = runChecklist(
    variant({ headline: 'Do you suffer from back pain' }),
    noConstraints,
  );
  assert.ok(suffering.failures.some((f) => f.ruleId === 'no-personal-attribute-callouts'));
});

test('miracle/guaranteed-outcome claims fail', () => {
  const result = runChecklist(
    variant({ primaryText: 'A miracle serum with guaranteed results.' }),
    noConstraints,
  );
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.ruleId === 'no-prohibited-claims'));
});

test('repeated punctuation fails; single ! passes', () => {
  const shouting = runChecklist(variant({ headline: 'Sale ends tonight!!' }), noConstraints);
  assert.ok(shouting.failures.some((f) => f.ruleId === 'no-excessive-punctuation'));
  const single = runChecklist(variant({ headline: 'Sale ends tonight!' }), noConstraints);
  assert.equal(
    single.failures.some((f) => f.ruleId === 'no-excessive-punctuation'),
    false,
  );
});

test('ALL-CAPS words of 4+ letters fail; short acronyms pass', () => {
  const caps = runChecklist(variant({ headline: 'HUGE savings this week' }), noConstraints);
  assert.ok(caps.failures.some((f) => f.ruleId === 'no-all-caps-shouting'));
  const acronym = runChecklist(variant({ headline: 'Ships free across the USA' }), noConstraints);
  assert.equal(
    acronym.failures.some((f) => f.ruleId === 'no-all-caps-shouting'),
    false,
  );
});

test("buyer policy constraints ban the constraint's significant terms", () => {
  const brief = { policyConstraints: ['no weight-loss or body-transformation claims'] };
  const offending = runChecklist(
    variant({ primaryText: 'Kickstart your weight-loss journey today.' }),
    brief,
  );
  assert.equal(offending.pass, false);
  assert.ok(offending.failures.some((f) => f.ruleId === 'buyer-policy-constraints'));

  const clean = runChecklist(variant(), brief);
  assert.equal(clean.pass, true);
});

test('constraintTerms drops stopwords and short words', () => {
  const terms = constraintTerms('no weight-loss or body-transformation claims');
  assert.ok(terms.includes('weight-loss'));
  assert.ok(terms.includes('body-transformation'));
  assert.equal(terms.includes('claims'), false);
  assert.equal(terms.includes('no'), false);
});
