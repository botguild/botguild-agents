import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreGig, shouldPropose, scoreCategory, scoreBudget } from './scorer.js';
import type { Gig } from './client.js';

const baseConfig = {
  categories: ['web-development'],
  budgetMin: 500,
  budgetMax: 5000,
  proposalThreshold: 70,
};

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: 'gig-1',
    title: 'Build a website',
    description: 'Need a full-stack web app built.',
    category: 'web-development',
    budget: 5000,
    warrantyTerms: '30 days of bug fixes included',
    acceptanceCriteria:
      'All pages load within 2 seconds, mobile-responsive, passes accessibility audit',
    timeline: '4 weeks',
    status: 'open',
    payerId: 'payer-1',
    createdAt: '2026-05-03T00:00:00Z',
    ...overrides,
  };
}

// 1. Perfect match: all factors score at maximum
test('perfect match scores 100', () => {
  const gig = makeGig();
  const breakdown = scoreGig(gig, baseConfig);

  assert.equal(breakdown.category, 40);
  assert.equal(breakdown.budget, 20);
  assert.equal(breakdown.warranty, 15);
  assert.equal(breakdown.clarity, 15);
  assert.equal(breakdown.timeline, 10);
  assert.equal(breakdown.total, 100);
});

// 2. Category miss: different category forces total to 0
test('category miss → total 0 and shouldPropose false', () => {
  const gig = makeGig({ category: 'graphic-design' });
  const breakdown = scoreGig(gig, baseConfig);

  assert.equal(breakdown.category, 0);
  assert.equal(breakdown.budget, 0);
  assert.equal(breakdown.warranty, 0);
  assert.equal(breakdown.clarity, 0);
  assert.equal(breakdown.timeline, 0);
  assert.equal(breakdown.total, 0);
  assert.equal(shouldPropose(gig, baseConfig), false);
});

// 3. Budget miss: budget below min → budget score 0, other factors still count
test('budget below min → budget score 0, other factors score normally', () => {
  const gig = makeGig({ budget: 100 });
  const breakdown = scoreGig(gig, baseConfig);

  assert.equal(breakdown.category, 40);
  assert.equal(breakdown.budget, 0);
  assert.equal(breakdown.warranty, 15);
  assert.equal(breakdown.clarity, 15);
  assert.equal(breakdown.timeline, 10);
  assert.equal(breakdown.total, 80);
});

// 4. No acceptance criteria → clarity = 0
test('no acceptanceCriteria → clarity score 0', () => {
  const gig = makeGig({ acceptanceCriteria: undefined });
  const breakdown = scoreGig(gig, baseConfig);

  assert.equal(breakdown.clarity, 0);
  assert.equal(breakdown.total, 85); // 40 + 20 + 15 + 0 + 10
});

// 5. shouldPropose respects threshold
test('score below threshold → shouldPropose false', () => {
  const strictConfig = { ...baseConfig, proposalThreshold: 90 };
  // Remove warranty and timeline to drop score below 90
  const gig = makeGig({ warrantyTerms: undefined, timeline: undefined });
  const breakdown = scoreGig(gig, strictConfig);

  assert.equal(breakdown.total, 75); // 40 + 20 + 0 + 15 + 0
  assert.equal(shouldPropose(gig, strictConfig), false);
});

test('score at or above threshold → shouldPropose true', () => {
  const gig = makeGig();
  assert.equal(shouldPropose(gig, baseConfig), true);
});

// scoreCategory unit tests
test('scoreCategory returns 40 for exact match', () => {
  const gig = makeGig({ category: 'web-development' });
  assert.equal(scoreCategory(gig, ['web-development']), 40);
});

test('scoreCategory returns 0 for mismatch', () => {
  const gig = makeGig({ category: 'seo' });
  assert.equal(scoreCategory(gig, ['web-development']), 0);
});

test('scoreCategory returns 40 when gig category matches any entry in the list', () => {
  const gig = makeGig({ category: 'monitoring' });
  assert.equal(scoreCategory(gig, ['Ops & Automation', 'monitoring', 'web-scraping']), 40);
});

test('scoreCategory returns 0 for empty list', () => {
  const gig = makeGig({ category: 'monitoring' });
  assert.equal(scoreCategory(gig, []), 0);
});

// scoreBudget unit tests
test('scoreBudget returns 0 when budget below min', () => {
  const gig = makeGig({ budget: 400 });
  assert.equal(scoreBudget(gig, 500, 5000), 0);
});

test('scoreBudget returns 20 when budget at max', () => {
  const gig = makeGig({ budget: 5000 });
  assert.equal(scoreBudget(gig, 500, 5000), 20);
});

test('scoreBudget returns 20 when budget exceeds max', () => {
  const gig = makeGig({ budget: 10000 });
  assert.equal(scoreBudget(gig, 500, 5000), 20);
});

test('scoreBudget returns linear score for midpoint budget', () => {
  // midpoint of 500-5000 is 2750; (2750-500)/(5000-500)*20 = 2250/4500*20 = 10
  const gig = makeGig({ budget: 2750 });
  assert.equal(scoreBudget(gig, 500, 5000), 10);
});

// Short acceptanceCriteria scores 8
test('short acceptanceCriteria (1-50 chars) → clarity score 8', () => {
  const gig = makeGig({ acceptanceCriteria: 'Must work on mobile' }); // 19 chars
  const breakdown = scoreGig(gig, baseConfig);
  assert.equal(breakdown.clarity, 8);
});
