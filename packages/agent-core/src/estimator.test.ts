import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRateCard, type RateCard, type ResourceEstimate } from './estimator.js';

const card: RateCard = {
  perClaudeCall: 0.5,
  perKToken: 0.25,
  perBrowserMinute: 1.5,
  perComputeMinute: 0.4,
  perRun: 2,
  fixedOverhead: 15,
};

test('applyRateCard sums quantities × rates plus fixed overhead', () => {
  const est: ResourceEstimate = {
    claudeCalls: 12,
    claudeKTokens: 60,
    browserMinutes: 60,
    computeMinutes: 60,
    runs: 8,
  };
  // 15 + 12*0.5 + 60*0.25 + 60*1.5 + 60*0.4 + 8*2 = 15+6+15+90+24+16 = 166
  assert.equal(applyRateCard(est, card), 166);
});

test('applyRateCard has no minimum: an empty estimate costs only the fixed overhead', () => {
  const tiny: ResourceEstimate = {
    claudeCalls: 0,
    claudeKTokens: 0,
    browserMinutes: 0,
    computeMinutes: 0,
    runs: 0,
  };
  // overhead only, with no floor applied
  assert.equal(applyRateCard(tiny, card), 15);
});

test('a no-browser job costs less than the same job with browser minutes', () => {
  const base: ResourceEstimate = {
    claudeCalls: 6,
    claudeKTokens: 40,
    browserMinutes: 0,
    computeMinutes: 30,
    runs: 1,
  };
  const withBrowser: ResourceEstimate = { ...base, browserMinutes: 30 };
  assert.ok(applyRateCard(withBrowser, card) > applyRateCard(base, card));
});

// The bid rule the estimator applies: target = round(1.5 × cost); bid the
// target, but align up to the gig's budget when the gig already pays more.
function bidPrice(cost: number, gigBudget: number): number {
  const target = Math.round(1.5 * cost);
  return Math.max(target, gigBudget);
}

test('target is 1.5× cost with no minimum and no clamp', () => {
  const est: ResourceEstimate = {
    claudeCalls: 8,
    claudeKTokens: 40,
    browserMinutes: 45,
    computeMinutes: 45,
    runs: 4,
  };
  const cost = applyRateCard(est, card);
  // 15 + 4 + 10 + 67.5 + 18 + 8 = 122.5
  assert.equal(cost, 122.5);
  assert.equal(Math.round(1.5 * cost), 184);
});

test('gig priced below target → bid the 1.5× target', () => {
  // cost 100 → target 150; gig only budgets 90 → still bid 150
  assert.equal(bidPrice(100, 90), 150);
});

test('gig priced at/above target → bid aligns up to the gig amount', () => {
  // cost 100 → target 150; gig budgets 400 → bid 400
  assert.equal(bidPrice(100, 400), 400);
});

test('a tiny estimate yields a tiny bid — no floor pulls it up', () => {
  // cost 15 (overhead only) → target 23; gig budgets 10 → bid 23, not floored to any band min
  assert.equal(bidPrice(15, 10), 23);
});
