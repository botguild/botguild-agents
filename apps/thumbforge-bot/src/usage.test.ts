import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideUsage, overCapMessage, usagePeriod } from './usage.js';

test('serve while under the cap; the Nth render is allowed only when used < cap', () => {
  assert.deepEqual(decideUsage(0, 20), { action: 'serve', used: 0, cap: 20, remaining: 20 });
  assert.deepEqual(decideUsage(19, 20), { action: 'serve', used: 19, cap: 20, remaining: 1 });
});

test('hold at the cap: the 21st request in a 20-cap month is held, not served (FR-15)', () => {
  const decision = decideUsage(20, 20);
  assert.deepEqual(decision, { action: 'hold', used: 20, cap: 20, remaining: 0 });
  assert.match(overCapMessage(decision), /held/i);
  assert.match(overCapMessage(decision), /top-up/i);
  // It explicitly disclaims metered billing rather than offering it (FR-15).
  assert.match(overCapMessage(decision), /no metered-overage billing/i);
});

test('hold clamps remaining to zero even if used somehow exceeds the cap', () => {
  assert.deepEqual(decideUsage(25, 20), { action: 'hold', used: 25, cap: 20, remaining: 0 });
});

test('usagePeriod is the zero-padded UTC YYYY-MM', () => {
  assert.equal(usagePeriod(new Date('2026-03-09T23:59:59Z')), '2026-03');
  assert.equal(usagePeriod(new Date('2026-11-01T00:00:00Z')), '2026-11');
});
