import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBot, rankBots, CATALOG } from './catalog.js';

test('getBot resolves by id and by case-insensitive name', () => {
  assert.equal(getBot('sentinel-bot')?.name, 'SentinelBot');
  assert.equal(getBot('SentinelBot')?.id, 'sentinel-bot');
  assert.equal(getBot('sentinelbot')?.id, 'sentinel-bot');
  assert.equal(getBot('nope'), undefined);
});

test('rankBots puts the best keyword match first for each domain', () => {
  assert.equal(rankBots('monitor my site for downtime and alert me')[0].bot.id, 'sentinel-bot');
  assert.equal(rankBots('clean and transform my csv data into a schema')[0].bot.id, 'flow-bot');
  assert.equal(rankBots('verify the build against acceptance criteria')[0].bot.id, 'verifier-bot');
});

test('rankBots scores by keyword-hit count, descending', () => {
  const ranked = rankBots('monitor uptime and alert on downtime');
  // sentinel keywords hit: monitor, uptime, alert, downtime → 4
  assert.equal(ranked[0].bot.id, 'sentinel-bot');
  assert.ok(ranked[0].score >= 4);
  // scores are sorted high → low
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score);
  }
});

test('rankBots returns every catalog entry, scoring 0 when nothing matches', () => {
  const ranked = rankBots('xyzzy plugh nothing relevant');
  assert.equal(ranked.length, CATALOG.length);
  assert.ok(ranked.every((r) => r.score === 0));
});
