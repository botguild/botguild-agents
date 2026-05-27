import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestBudget } from './budget.js';
import type { BotProfile } from './catalog.js';

// Synthetic bot with a clean band (span 100) so the arithmetic is predictable.
const bot = {
  id: 'test-bot',
  name: 'TestBot',
  tagline: 't',
  scorer: { categories: ['X'], budgetMin: 100, budgetMax: 200, proposalThreshold: 50 },
  canDo: [],
  cantDo: [],
  keywords: [],
} as BotProfile;

test('positions the total within the band and scales with scope', () => {
  // total = ROUND(min + span*fraction): small .25 → 125, medium .55 → 155, large .9 → 190.
  assert.equal(suggestBudget(bot, 'small').total, 125);
  assert.equal(suggestBudget(bot, 'medium').total, 155);
  assert.equal(suggestBudget(bot, 'large').total, 190);
});

test('small/medium scopes split into two milestones that sum to the total', () => {
  for (const scope of ['small', 'medium'] as const) {
    const s = suggestBudget(bot, scope);
    assert.equal(s.milestones.length, 2);
    assert.equal(
      s.milestones.reduce((sum, m) => sum + m.amount, 0),
      s.total,
    );
  }
});

test('large scope splits into three milestones that sum to the total', () => {
  const s = suggestBudget(bot, 'large');
  assert.equal(s.milestones.length, 3);
  assert.equal(
    s.milestones.reduce((sum, m) => sum + m.amount, 0),
    s.total,
  );
});

test('milestone amounts are rounded to the nearest 5', () => {
  const s = suggestBudget(bot, 'large');
  for (const m of s.milestones.slice(0, -1)) {
    assert.equal(m.amount % 5, 0, `${m.title} should be a multiple of 5`);
  }
});

test('total never drops below the budget floor and rationale cites the band', () => {
  const s = suggestBudget(bot, 'small');
  assert.ok(s.total >= bot.scorer.budgetMin);
  assert.match(s.rationale, /\$100–\$200/);
  assert.match(s.rationale, /TestBot/);
});
