// Golden-set schema validation + proposal-block formatting (Task 9 brief, Step 1).
// Verbatim tests from the task-9 brief, plus the formatGoldenBlock rights-attestation check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGoldenSet, formatGoldenBlock } from './goldens.js';

const CONTRACT = {
  exact: ['input-hours', 'calc-submit', 'result', 'footer'],
  prefixes: ['breakdown-'],
};
const good = {
  goldens: [
    {
      title: 'a',
      steps: [
        { do: 'fill', fields: { 'input-hours': '10' } },
        { do: 'click', testid: 'calc-submit' },
      ],
      expect: [{ testid: 'result', equals: '$1.00' }],
    },
    { title: 'b', steps: [], expect: [{ titleEquals: 'X' }] },
    { title: 'c', steps: [], expect: [{ testid: 'result', visible: true }] },
  ],
};

test('accepts a valid canonical set', () => {
  const r = validateGoldenSet(good, CONTRACT);
  assert.equal(r.ok, true);
});

test('rejects off-contract testids, bad vocab, and wrong counts; accepts prefix matches', () => {
  const off = structuredClone(good);
  (off.goldens[0].expect[0] as { testid: string }).testid = 'nope';
  assert.equal(validateGoldenSet(off, CONTRACT).ok, false);
  const pfx = structuredClone(good);
  (pfx.goldens[0].expect[0] as { testid: string }).testid = 'breakdown-base';
  assert.equal(validateGoldenSet(pfx, CONTRACT).ok, true);
  const vocab = structuredClone(good);
  (vocab.goldens[0].expect[0] as any).matches = '/re/';
  assert.equal(validateGoldenSet(vocab, CONTRACT).ok, false);
  assert.equal(validateGoldenSet({ goldens: good.goldens.slice(0, 2) }, CONTRACT).ok, false); // <3
});

test('normalizes the PRD §8 single-action shorthand', () => {
  const shorthand = {
    goldens: [
      {
        action: 'fill',
        inputs: { 'input-hours': '10' },
        expect: [{ testid: 'result', equals: '$1.00' }],
      },
      { action: 'load', expect: [{ testid: 'result', visible: true }] },
      { action: 'load', expect: [{ titleEquals: 'X' }] },
    ],
  };
  const r = validateGoldenSet(shorthand, CONTRACT);
  assert.equal(r.ok, true);
  if (r.ok)
    assert.deepEqual(r.set.goldens[0].steps[0], { do: 'fill', fields: { 'input-hours': '10' } });
});

test('rejects upload steps referencing missing fixtures', () => {
  const s = {
    goldens: [
      ...good.goldens.slice(0, 2),
      {
        title: 'u',
        steps: [{ do: 'upload', testid: 'input-hours', fixture: 'f.csv' }],
        expect: [{ testid: 'result', visible: true }],
      },
    ],
  };
  assert.equal(validateGoldenSet(s, CONTRACT).ok, false);
});

test('formatGoldenBlock names the template, embeds fenced JSON, and states the warranty scope', () => {
  const r = validateGoldenSet(good, CONTRACT);
  assert.ok(r.ok);
  const block = formatGoldenBlock({
    templateId: 'calculator',
    templateVersion: '1.0.0',
    set: (r as any).set,
  });
  assert.match(block, /`calculator` v1\.0\.0/);
  assert.match(block, /```json/);
  assert.match(block, /acceptance criteria/i);
  assert.match(block, /excluded/i);
  assert.match(block, /rights to all copy/i); // §12 buyer rights attestation
});
