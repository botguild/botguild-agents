import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from './reconcile.js';

test('exactly one output per input passes', () => {
  const result = reconcile(['k1', 'k2', 'k3'], [{ inputKey: 'k1' }, { inputKey: 'k2' }, { inputKey: 'k3' }]);
  assert.equal(result.pass, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.duplicates, []);
  assert.deepEqual(result.extra, []);
});

test('a missing output is reported', () => {
  const result = reconcile(['k1', 'k2'], [{ inputKey: 'k1' }]);
  assert.equal(result.pass, false);
  assert.deepEqual(result.missing, ['k2']);
});

test('a double-count (duplicate output for one input) is reported', () => {
  const result = reconcile(['k1'], [{ inputKey: 'k1' }, { inputKey: 'k1' }]);
  assert.equal(result.pass, false);
  assert.deepEqual(result.duplicates, ['k1']);
  assert.equal(result.counts.k1, 2);
});

test('an output with no matching input is reported as extra', () => {
  const result = reconcile(['k1'], [{ inputKey: 'k1' }, { inputKey: 'ghost' }]);
  assert.equal(result.pass, false);
  assert.deepEqual(result.extra, ['ghost']);
});
