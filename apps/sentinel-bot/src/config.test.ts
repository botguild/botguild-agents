import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Gig } from '@botguild/agent-core';
import { pricingCalc, sentinelPricing } from './config.js';

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: 'gig-1',
    title: 'Monitor my site',
    description: 'Keep an eye on things.',
    category: 'Ops & Automation',
    budget: 200,
    ...overrides,
  } as Gig;
}

// pricingCalc = baseRate(watchType) * multiplier(complexity from target count),
// clamped to [budgetMin, budgetMax], then split across 4 weekly milestones.

test('detects uptime watch type from keywords and prices a single target as simple', () => {
  // "uptime"/"health"/"api" → uptime base 120; one target → simple x1.0.
  const { price } = pricingCalc(makeGig({ title: 'Uptime watch', description: 'monitor health' }));
  assert.equal(
    price,
    sentinelPricing.baseRates.uptime * sentinelPricing.complexityMultipliers.simple,
  );
});

test('detects scheduled watch type and a plural-but-uncounted target set as moderate', () => {
  // "scheduled" → base 100; plural "endpoints" with no number → 5 targets → moderate x1.3.
  const { price } = pricingCalc(
    makeGig({
      title: 'Scheduled checks',
      description: 'run scheduled checks across these endpoints',
    }),
  );
  assert.equal(price, Math.round(sentinelPricing.baseRates.scheduled * 1.3)); // 130
});

test('falls back to change watch type and scales price with an explicit target count', () => {
  // No uptime/scheduled keywords → change base 150; "12 pages" → 12 targets → complex x1.6.
  const { price } = pricingCalc(
    makeGig({ title: 'Track competitor pricing', description: 'watch changes on 12 pages daily' }),
  );
  assert.equal(
    price,
    Math.round(sentinelPricing.baseRates.change * sentinelPricing.complexityMultipliers.complex),
  ); // 240
});

test('complexity steps with target count: 3 simple, 8 moderate, 9 complex', () => {
  const at = (n: number) =>
    pricingCalc(makeGig({ title: 'change watch', description: `watch ${n} pages` })).price;
  assert.equal(at(3), 150); // simple x1.0
  assert.equal(at(8), Math.round(150 * 1.3)); // moderate → 195
  assert.equal(at(9), Math.round(150 * 1.6)); // complex → 240
});

test('returns four weekly milestone checkpoints', () => {
  const { timeline, milestones } = pricingCalc(
    makeGig({ title: 'Scheduled checks', description: 'monitor these endpoints' }),
  );
  assert.equal(timeline, '4 weeks');
  assert.equal(milestones.length, 4);
  for (const m of milestones) assert.equal(m.duration, '1 week');
});

test('price stays within the configured budget band', () => {
  const { price } = pricingCalc(makeGig({ title: 'watch', description: 'monitor 100 pages' }));
  assert.ok(price >= sentinelPricing.budgetMin && price <= sentinelPricing.budgetMax);
});
