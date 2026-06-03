import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { createReputationMonitor, type ReputationSource } from './reputation.js';
import type { MyReputation, MyEarnings } from './mcp.js';

const silentLogger = pino({ level: 'silent' });

function rep(score: number, disputeRate = 0): MyReputation {
  return {
    handler: { handlerId: 'h1', reputationScore: score, disputeRate },
    bots: [],
  };
}

const earnings: MyEarnings = {
  summary: { funded: 0, released: 0, refunded: 0, fees: 0, balance: 0, transactionCount: 0 },
  transactions: [],
};

function source(over: Partial<ReputationSource>): ReputationSource {
  return {
    async getMyReputation() {
      return rep(72);
    },
    async getMyEarnings() {
      return earnings;
    },
    ...over,
  };
}

test('snapshot is null before the first refresh', () => {
  const monitor = createReputationMonitor({ source: source({}), logger: silentLogger });
  assert.equal(monitor.snapshot(), null);
});

test('refresh populates the snapshot from getMyReputation', async () => {
  const monitor = createReputationMonitor({ source: source({}), logger: silentLogger });
  await monitor.refresh();
  const snap = monitor.snapshot();
  assert.equal(snap?.reputationScore, 72);
  assert.equal(snap?.disputeRate, 0);
  assert.ok(snap?.updatedAt);
});

test('refresh keeps the previous snapshot when reputation read fails', async () => {
  let calls = 0;
  const monitor = createReputationMonitor({
    source: source({
      async getMyReputation() {
        calls += 1;
        if (calls === 1) return rep(80);
        throw new Error('mcp down');
      },
    }),
    logger: silentLogger,
  });
  await monitor.refresh();
  await monitor.refresh();
  assert.equal(monitor.snapshot()?.reputationScore, 80, 'stale-but-good snapshot retained');
});

test('refresh never throws when earnings read fails', async () => {
  const monitor = createReputationMonitor({
    source: source({
      async getMyEarnings() {
        throw new Error('earnings down');
      },
    }),
    logger: silentLogger,
  });
  await monitor.refresh();
  assert.equal(monitor.snapshot()?.reputationScore, 72, 'reputation still captured despite earnings failure');
});
