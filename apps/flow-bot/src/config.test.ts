import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Gig } from '@botguild/agent-core';
import { pricingCalc, flowPricing } from './config.js';

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: 'gig-1',
    title: 'Clean my data',
    description: 'Normalize a csv file.',
    category: 'Ops & Automation',
    budget: 200,
    ...overrides,
  } as Gig;
}

// pricingCalc = baseRate(inputType) * multiplier(rowSize), clamped to
// [budgetMin, budgetMax], then split 30/40/30 across 3 milestones.

test('defaults to csv input at small size when no source keyword matches', () => {
  // No csv/pdf/api/sheet keyword anywhere → falls back to the csv base rate.
  const { price } = pricingCalc(
    makeGig({ title: 'Clean my records', description: 'tidy up my exported data file' }),
  );
  assert.equal(price, flowPricing.baseRates.csv * flowPricing.complexityMultipliers.small); // 75
});

test('detects api input and scales with an explicit large row count', () => {
  const { price } = pricingCalc(
    makeGig({ title: 'Sync API data', description: 'pull 50000 records from a REST endpoint' }),
  );
  assert.equal(
    price,
    Math.round(flowPricing.baseRates.api * flowPricing.complexityMultipliers.large),
  ); // 192
});

test('detects multi input when more than one source keyword is present', () => {
  const { price } = pricingCalc(
    makeGig({ title: 'Merge sources', description: 'combine csv files and pdf invoices' }),
  );
  assert.equal(price, flowPricing.baseRates.multi * flowPricing.complexityMultipliers.small); // 150
});

test('row-size tiers from explicit counts: <1000 small, <=10000 medium, >10000 large', () => {
  const at = (rows: number) =>
    pricingCalc(makeGig({ title: 'Clean data', description: `normalize a csv with ${rows} rows` }))
      .price;
  assert.equal(at(500), 75); // small x1.0
  assert.equal(at(5000), Math.round(75 * 1.3)); // medium → 98
  assert.equal(at(20000), Math.round(75 * 1.6)); // large → 120
});

test('parses comma-separated row counts', () => {
  // "25,000 records" → 25000 → large.
  const { price } = pricingCalc(
    makeGig({ title: 'Clean data', description: 'normalize a csv with 25,000 records' }),
  );
  assert.equal(price, Math.round(75 * 1.6)); // 120
});

test('returns three milestone checkpoints', () => {
  const { timeline, milestones } = pricingCalc(
    makeGig({ title: 'Sync API data', description: 'pull 50000 records from a REST endpoint' }),
  );
  assert.equal(timeline, '3–5 business days');
  assert.equal(milestones.length, 3);
});

test('price stays within the configured budget band', () => {
  const { price } = pricingCalc(
    makeGig({ title: 'Merge everything', description: 'combine csv, pdf, api with 99999 records' }),
  );
  assert.ok(price >= flowPricing.budgetMin && price <= flowPricing.budgetMax);
});
