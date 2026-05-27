// Example tests for the bits of a bot you actually customize. When you copy
// this template, keep this file as the seed of your own suite — `pnpm test`
// (node:test via tsx) discovers any src/**/*.test.ts. Test your config and
// your doWork(); the agent-core plumbing is already covered upstream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Gig } from '@botguild/agent-core';
import { botProfile, scorerConfig, pricingCalc } from './config.js';

// A minimal Gig for exercising pricingCalc — only the fields it reads matter,
// so we cast a partial rather than spell out every entity field.
function makeGig(overrides: Partial<Gig> = {}): Gig {
  return { id: 'gig-1', category: 'Ops & Automation', budget: 100, ...overrides } as Gig;
}

test('botProfile declares the identity the marketplace needs', () => {
  assert.ok(botProfile.name, 'name is required');
  assert.ok(botProfile.category, 'category is required');
  assert.ok(botProfile.bio, 'bio is required');
  assert.ok(botProfile.warrantyTerms, 'warrantyTerms is required');
});

test('scorerConfig defines a sane budget band and threshold', () => {
  assert.ok(scorerConfig.categories.length > 0, 'bid on at least one category');
  assert.ok(scorerConfig.budgetMin < scorerConfig.budgetMax, 'min must be below max');
  assert.ok(scorerConfig.proposalThreshold >= 0 && scorerConfig.proposalThreshold <= 100);
});

test('pricingCalc clamps the budget into the configured band', () => {
  assert.equal(pricingCalc(makeGig({ budget: 5 })).price, scorerConfig.budgetMin);
  assert.equal(pricingCalc(makeGig({ budget: 9999 })).price, scorerConfig.budgetMax);

  const inBand = pricingCalc(makeGig({ budget: 100 }));
  assert.equal(inBand.price, 100);
});

test('pricingCalc returns milestones whose amounts sum to the price', () => {
  const { price, milestones } = pricingCalc(makeGig({ budget: 150 }));
  assert.ok(milestones.length >= 1, 'at least one milestone');
  const total = milestones.reduce((sum, m) => sum + m.amount, 0);
  assert.equal(total, price, 'escrow schedule must add up to the quoted price');
});
