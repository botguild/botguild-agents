import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Gig } from '@botguild/agent-core';
import { pricingCalc, verifierPricing } from './config.js';

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: 'gig-1',
    title: 'Verify my deliverable',
    description: 'Run checks.',
    category: 'Testing & QA',
    budget: 200,
    ...overrides,
  } as Gig;
}

// pricingCalc picks a flat base rate per detected check type, clamps to
// [budgetMin, budgetMax], and splits it 50/50 across two milestones.

test('detects check type from keywords and prices at the matching base rate', () => {
  const priceFor = (title: string, description: string) =>
    pricingCalc(makeGig({ title, description })).price;

  assert.equal(
    priceFor('Smoke test suite', 'run regression checks'),
    verifierPricing.baseRates.smoke,
  ); // 100
  assert.equal(
    priceFor('Data audit', 'validate data quality'),
    verifierPricing.baseRates.dataQuality,
  ); // 80
  assert.equal(
    priceFor('API checks', 'verify the contract'),
    verifierPricing.baseRates.apiContract,
  ); // 90
  assert.equal(
    priceFor('Acceptance review', 'audit the acceptance criteria'),
    verifierPricing.baseRates.acceptanceAudit,
  ); // 60
});

test('defaults to a smoke check when no keyword matches', () => {
  assert.equal(pricingCalc(makeGig({ title: 'Check it', description: 'have a look' })).price, 100);
});

test('detection priority: data beats api when both keywords appear', () => {
  // detectCheckType tests dataQuality before apiContract.
  const { price } = pricingCalc(makeGig({ title: 'Check API', description: 'validate the data' }));
  assert.equal(price, verifierPricing.baseRates.dataQuality); // 80, not 90
});

test('splits the price 50/50 across two milestones that sum exactly', () => {
  const { price, timeline, milestones } = pricingCalc(
    makeGig({ title: 'API checks', description: 'verify the contract' }),
  );
  assert.equal(timeline, '1–2 business days');
  assert.equal(milestones.length, 2);
  assert.equal(milestones[0].amount, Math.round(price * 0.5));
  assert.equal(milestones[0].amount + milestones[1].amount, price);
});

test('price stays within the configured budget band', () => {
  const { price } = pricingCalc(makeGig());
  assert.ok(price >= verifierPricing.budgetMin && price <= verifierPricing.budgetMax);
});
