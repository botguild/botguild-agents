import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDimensions } from './dimensions.js';

test('passes on an exact dimension match', () => {
  const result = checkDimensions({ width: 1200, height: 630 }, { width: 1200, height: 630 });
  assert.equal(result.pass, true);
  assert.deepEqual(result.actual, { width: 1200, height: 630 });
});

test('fails when either axis is off by a pixel', () => {
  assert.equal(
    checkDimensions({ width: 1200, height: 629 }, { width: 1200, height: 630 }).pass,
    false,
  );
  assert.equal(
    checkDimensions({ width: 1201, height: 630 }, { width: 1200, height: 630 }).pass,
    false,
  );
});
