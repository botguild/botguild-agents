import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  differsFromPriorCycle,
  evaluateDiversity,
  jaccardSimilarity,
  normalizeText,
  wordBigrams,
} from './diversity.js';
import type { Variant } from '../types.js';

const v = (id: string, angle: string, text: string): Variant => ({
  id,
  angle,
  headline: text,
  primaryText: '',
  description: '',
});

test('normalizeText lowercases, strips punctuation, collapses whitespace', () => {
  assert.equal(normalizeText('Save 20%, Today!!  Don’t wait…'), 'save 20 today don t wait');
});

test('wordBigrams builds adjacent word pairs', () => {
  assert.deepEqual([...wordBigrams('save big today')], ['save big', 'big today']);
  assert.deepEqual([...wordBigrams('solo')], ['solo']);
  assert.equal(wordBigrams('').size, 0);
});

test('jaccardSimilarity: identical=1, disjoint=0, half-overlap computed', () => {
  const a = new Set(['x y', 'y z']);
  assert.equal(jaccardSimilarity(a, new Set(a)), 1);
  assert.equal(jaccardSimilarity(a, new Set(['p q'])), 0);
  // {x y, y z} vs {x y, q r}: intersection 1, union 3
  assert.equal(jaccardSimilarity(a, new Set(['x y', 'q r'])), 1 / 3);
});

test('a cross-group pair exactly AT the threshold passes (gate is ≤)', () => {
  // Construct two variants whose similarity is exactly 0.5:
  // bigrams A = {a b, b c}, B = {a b, b d} → intersection 1, union 3 → 1/3… so
  // craft instead: A={a b}, B={a b, b c}? sim=1/2. Use single/two-bigram texts.
  const a = v('v1', 'angle-1', 'alpha beta');
  const b = v('v2', 'angle-2', 'alpha beta gamma');
  const pair = jaccardSimilarity(wordBigrams('alpha beta'), wordBigrams('alpha beta gamma'));
  assert.equal(pair, 0.5);
  const result = evaluateDiversity([a, b, v('v3', 'angle-3', 'totally different words here')], {
    threshold: 0.5,
    requiredAngles: 3,
  });
  assert.equal(result.pass, true);
  assert.equal(result.violations.length, 0);
});

test('a cross-group pair ABOVE the threshold fails the gate', () => {
  const result = evaluateDiversity(
    [
      v('v1', 'angle-1', 'save big on shoes today only'),
      v('v2', 'angle-2', 'save big on shoes today only friends'),
      v('v3', 'angle-3', 'completely unrelated angle copy'),
    ],
    { threshold: 0.5, requiredAngles: 3 },
  );
  assert.equal(result.pass, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]?.aId, 'v1');
  assert.equal(result.violations[0]?.bId, 'v2');
});

test('near-identical copy within the SAME angle group does not violate the floor', () => {
  const result = evaluateDiversity(
    [
      v('v1', 'urgency', 'act now before the sale ends'),
      v('v2', 'urgency', 'act now before the sale ends tonight'),
      v('v3', 'value', 'more quality for less money'),
      v('v4', 'social-proof', 'ten thousand happy customers agree'),
    ],
    { threshold: 0.5, requiredAngles: 3 },
  );
  assert.equal(result.pass, true);
});

test('fewer distinct angles than required fails even with dissimilar copy', () => {
  const result = evaluateDiversity(
    [v('v1', 'a', 'one two three'), v('v2', 'b', 'four five six')],
    { threshold: 0.5, requiredAngles: 3 },
  );
  assert.equal(result.pass, false);
  assert.equal(result.distinctAngles, 2);
});

test('differsFromPriorCycle flags a recycled variant and passes fresh copy', () => {
  const prior = [v('p1', 'urgency', 'act now before the sale ends tonight')];
  const recycled = differsFromPriorCycle(
    [v('n1', 'urgency', 'act now before the sale ends tonight')],
    prior,
    0.5,
  );
  assert.equal(recycled.pass, false);
  assert.equal(recycled.violations[0]?.aId, 'n1');
  assert.equal(recycled.violations[0]?.bId, 'p1');

  const fresh = differsFromPriorCycle(
    [v('n1', 'urgency', 'entirely new framing with different vocabulary')],
    prior,
    0.5,
  );
  assert.equal(fresh.pass, true);
});
