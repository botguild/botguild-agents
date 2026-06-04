import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScorerConfig } from '@botguild/agent-core';
import { scoreDraft, type DraftGig } from './draft.js';

// Mirror of FlowBot's scorer so the numbers are concrete.
const cfg: ScorerConfig = {
  categories: ['Ops & Automation'],
  keywords: ['data', 'etl', 'transform', 'csv', 'pdf', 'normalize'],
  keywordsForFullScore: 3,
  budgetMin: 60,
  budgetMax: 350,
  proposalThreshold: 40,
};

function makeDraft(overrides: Partial<DraftGig> = {}): DraftGig {
  return {
    title: 'A gig',
    category: '',
    budget: 0,
    timeline: '',
    acceptanceCriteria: [],
    deliverables: [],
    ...overrides,
  } as DraftGig;
}

test('a complete, matching draft scores 100 and is fundable with no gaps', () => {
  const r = scoreDraft(
    makeDraft({
      category: 'Ops & Automation',
      budget: 350, // >= budgetMax → full 20
      warrantyRequired: true, // 15
      acceptanceCriteria: ['Output matches the target schema with no duplicate primary keys'], // >50 chars → 15
      timeline: '5 business days', // 10
      deliverables: ['Clean CSV'],
    }),
    cfg,
    'FlowBot',
  );

  assert.equal(r.breakdown.total, 100);
  assert.equal(r.fundable, true);
  assert.deepEqual(r.gaps, []);
  assert.match(r.verdict, /Fundable/);
});

test('an empty draft scores 0 (category gate) and is not fundable', () => {
  const r = scoreDraft(makeDraft(), cfg, 'FlowBot');

  assert.equal(r.breakdown.total, 0);
  assert.equal(r.fundable, false);
  assert.match(r.verdict, /below .*bid threshold/);
  // Category gate zeroes everything, so the gaps cover the missing essentials.
  assert.ok(r.gaps.some((g) => /No category set/.test(g)));
  assert.ok(r.gaps.some((g) => /Add acceptanceCriteria/.test(g)));
  assert.ok(r.gaps.some((g) => /timeline/.test(g)));
  assert.ok(r.gaps.some((g) => /List deliverables/.test(g)));
});

test('names the offending category when one is set but unsupported', () => {
  const r = scoreDraft(makeDraft({ category: 'Marketing' }), cfg, 'FlowBot');
  assert.ok(r.gaps.some((g) => /Category "Marketing" isn't handled by FlowBot/.test(g)));
});

test('flags a low budget and thin acceptance criteria once the category matches', () => {
  const r = scoreDraft(
    makeDraft({
      category: 'Ops & Automation', // 40
      budget: 60, // == min → 0 budget points (< 20)
      acceptanceCriteria: ['done'], // <=50 chars → clarity 8
    }),
    cfg,
    'FlowBot',
  );

  assert.equal(r.breakdown.category, 40);
  assert.equal(r.breakdown.budget, 0);
  assert.equal(r.breakdown.clarity, 8);
  assert.equal(r.fundable, true); // 40 + 0 + 8 = 48 >= 40 threshold — fundable, but gaps remain
  assert.ok(r.gaps.some((g) => /sweet spot|full budget points/.test(g)));
  assert.ok(r.gaps.some((g) => /Expand acceptanceCriteria/.test(g)));
});

test('clarity reaches full marks once criteria exceed the detail threshold', () => {
  const r = scoreDraft(
    makeDraft({
      category: 'Ops & Automation',
      acceptanceCriteria: ['This is a sufficiently detailed acceptance criterion over fifty chars'],
    }),
    cfg,
    'FlowBot',
  );
  assert.equal(r.breakdown.clarity, 15);
  assert.ok(!r.gaps.some((g) => /acceptanceCriteria/.test(g)));
});
