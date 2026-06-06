import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreGig, shouldPropose, scoreCategory, scoreBudget, scoreRelevance } from './scorer.js';
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
    payerId: 'payer-1',
    payerName: 'Acme Co',
    payerAvatar: '',
    category: 'web-development',
    subcategory: '',
    deliverables: [],
    acceptanceCriteria: [
      { kind: 'text', text: 'All pages load within 2 seconds' },
      { kind: 'text', text: 'mobile-responsive' },
      { kind: 'text', text: 'passes accessibility audit' },
    ],
    budget: 5000,
    timeline: '4 weeks',
    urgency: 'medium',
    warrantyRequired: true,
    warrantyMinDuration: '30 days',
    dataConstraints: [],
    status: 'open',
    proposalCount: 0,
    postedDate: '2026-05-03T00:00:00Z',
    tags: [],
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
test('empty acceptanceCriteria → clarity score 0', () => {
  const gig = makeGig({ acceptanceCriteria: [] });
  const breakdown = scoreGig(gig, baseConfig);

  assert.equal(breakdown.clarity, 0);
  assert.equal(breakdown.total, 85); // 40 + 20 + 15 + 0 + 10
});

// 5. shouldPropose respects threshold
test('score below threshold → shouldPropose false', () => {
  const strictConfig = { ...baseConfig, proposalThreshold: 90 };
  // Remove warranty and timeline to drop score below 90
  const gig = makeGig({ warrantyRequired: false, timeline: '' });
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

// scoreRelevance — keyword/"near description" matching
const kwConfig = {
  categories: ['monitoring'],
  keywords: ['uptime', 'alert', 'scrape', 'watch'],
  keywordsForFullScore: 3,
  budgetMin: 1,
  budgetMax: 400,
  proposalThreshold: 40,
};

test('scoreRelevance: exact category match earns full 40 regardless of keywords', () => {
  const gig = makeGig({ category: 'monitoring', title: 'x', description: 'y' });
  assert.equal(scoreRelevance(gig, kwConfig), 40);
});

test('scoreRelevance: non-matching category but enough keyword hits earns full 40', () => {
  // 3 distinct hits (uptime, alert, scrape) == keywordsForFullScore → 40
  const gig = makeGig({
    category: 'general',
    title: 'Need uptime alerting',
    description: 'Also scrape a page for changes.',
  });
  assert.equal(scoreRelevance(gig, kwConfig), 40);
});

test('scoreRelevance: a single keyword hit scores 0 — below the minimum (#60)', () => {
  // One stray keyword is noise, not a near-match: hits(1) < minKeywordHits(2) → 0
  const gig = makeGig({
    category: 'general',
    title: 'Watch my service',
    description: 'no other matching terms here',
  });
  assert.equal(scoreRelevance(gig, kwConfig), 0);
  assert.equal(shouldPropose(gig, kwConfig), false);
});

test('scoreRelevance: two distinct hits clear the minimum and earn partial relevance', () => {
  // 2 of 3 needed → round(40 * 2/3) = 27
  const gig = makeGig({
    category: 'general',
    title: 'Watch my service uptime',
    description: 'no other matching terms here',
  });
  assert.equal(scoreRelevance(gig, kwConfig), 27);
});

test('scoreRelevance: minKeywordHits is configurable', () => {
  const strict = { ...kwConfig, minKeywordHits: 3 };
  const gig = makeGig({
    category: 'general',
    title: 'Watch my service uptime', // 2 hits
    description: 'no other matching terms here',
  });
  assert.equal(scoreRelevance(gig, strict), 0);
});

test('scoreRelevance: a keyword that appears only in deliverables still counts', () => {
  const gig = makeGig({
    category: 'general',
    title: 'Project help',
    description: 'See the breakdown.',
    deliverables: ['Set up uptime checks', 'Weekly alert summary', 'Scrape the status page'],
  });
  // hits: uptime, alert, scrape = 3 → full 40, sourced entirely from deliverables
  assert.equal(scoreRelevance(gig, kwConfig), 40);
});

test('scoreRelevance: zero hits and wrong category scores 0 (bot will not bid)', () => {
  const gig = makeGig({
    category: 'graphic-design',
    title: 'Design a logo',
    description: 'Brand identity work',
  });
  assert.equal(scoreRelevance(gig, kwConfig), 0);
  assert.equal(scoreGig(gig, kwConfig).total, 0);
  assert.equal(shouldPropose(gig, kwConfig), false);
});

test('scoreRelevance: near-description gig clears a lowered threshold via partial relevance', () => {
  // 2 hits → relevance 27, fit 0.675: budget(20) + warranty(round(15×.675)=10) +
  // clarity(10) + timeline(7) → 27 + 20 + 10 + 10 + 7 = 74 ≥ 40
  const gig = makeGig({
    category: 'general',
    title: 'Watch my checkout flow uptime',
    description: 'Tell me when it breaks.',
  });
  const breakdown = scoreGig(gig, kwConfig);
  assert.equal(breakdown.total, 74);
  assert.equal(shouldPropose(gig, kwConfig), true);
});

test('spec-quality factors scale with relevance — a well-written but barely-relevant gig cannot bid (#60)', () => {
  // Regression for issue #60: a beautifully-specified QA gig with one stray
  // sentinel keyword ("watch") used to score 13 + 40 spec-quality ≥ 40 → bid.
  // Now: 1 hit < minKeywordHits → relevance 0 → everything zeroed, no bid.
  const gig = makeGig({
    category: 'Testing & QA',
    title: 'QA smoke test and verification of web app',
    description: 'Verify every page and watch for console errors.',
    budget: 45,
  });
  const breakdown = scoreGig(gig, kwConfig);
  assert.equal(breakdown.total, 0);
  assert.equal(shouldPropose(gig, kwConfig), false);
});

test('spec-quality factors are scaled by fit on partial relevance, full at exact category match', () => {
  // Same gig, partial fit vs exact category: scaled vs unscaled spec quality.
  const partial = scoreGig(
    makeGig({
      category: 'general',
      title: 'Watch my service uptime', // 2 hits → fit 27/40
      description: 'Tell me when it breaks.',
    }),
    kwConfig,
  );
  assert.equal(partial.warranty, 10); // round(15 × 0.675)
  assert.equal(partial.clarity, 10);
  assert.equal(partial.timeline, 7); // round(10 × 0.675)

  const exact = scoreGig(makeGig({ category: 'monitoring' }), kwConfig);
  assert.equal(exact.warranty, 15);
  assert.equal(exact.clarity, 15);
  assert.equal(exact.timeline, 10);
});

test('scoreRelevance: no keywords configured falls back to exact-category only', () => {
  const noKw = { categories: ['monitoring'], budgetMin: 1, budgetMax: 400, proposalThreshold: 40 };
  assert.equal(scoreRelevance(makeGig({ category: 'general' }), noKw), 0);
  assert.equal(scoreRelevance(makeGig({ category: 'monitoring' }), noKw), 40);
});

// Short acceptanceCriteria scores 8
test('short acceptanceCriteria (≤50 chars total) → clarity score 8', () => {
  const gig = makeGig({ acceptanceCriteria: [{ kind: 'text', text: 'Must work on mobile' }] }); // 19 chars
  const breakdown = scoreGig(gig, baseConfig);
  assert.equal(breakdown.clarity, 8);
});
