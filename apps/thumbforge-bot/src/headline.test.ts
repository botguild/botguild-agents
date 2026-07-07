import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideHeadline, headlineRejectionMessage } from './headline.js';

test('accept when the headline fits and the font size is at/above the floor (FR-6)', () => {
  assert.deepEqual(decideHeadline(true, 40, 32), { accept: true, fontPx: 40 });
  assert.deepEqual(decideHeadline(true, 32, 32), { accept: true, fontPx: 32 });
});

test('reject when the layout reports the headline does not fit', () => {
  const decision = decideHeadline(false, 40, 32);
  assert.equal(decision.accept, false);
  if (!decision.accept) {
    assert.equal(decision.minFontPx, 32);
    assert.match(headlineRejectionMessage(decision), /rejected rather than shrunk/i);
  }
});

test('reject when the settled font size is below the minimum — never shrink below the floor', () => {
  const decision = decideHeadline(true, 28, 32);
  assert.equal(decision.accept, false);
  if (!decision.accept) {
    assert.equal(decision.fontPx, 28);
    assert.match(decision.reason, /32px/);
  }
});
