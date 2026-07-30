import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReputationSource } from '@botguild/agent-core';
import { refreshReputationOnce } from './reputation.js';
import { createConsoleLogger } from './logger.js';

const silentLogger = createConsoleLogger({ service: 'test', level: 'silent' });

function stubSource(overrides?: Partial<ReputationSource>): ReputationSource {
  return {
    getMyReputation: async () =>
      ({
        handler: { reputationScore: 87, disputeRate: 0.01 },
      }) as Awaited<ReturnType<ReputationSource['getMyReputation']>>,
    getMyEarnings: async () =>
      ({
        summary: { totalEarned: 120 },
      }) as unknown as Awaited<ReturnType<ReputationSource['getMyEarnings']>>,
    ...overrides,
  };
}

test('returns the snapshot from a single awaited refresh (no timer)', async () => {
  const snapshot = await refreshReputationOnce({ source: stubSource(), logger: silentLogger });

  assert.equal(snapshot?.reputationScore, 87);
  assert.equal(snapshot?.disputeRate, 0.01);
  assert.ok(!Number.isNaN(Date.parse(snapshot!.updatedAt)));
});

test('returns null instead of throwing when the reputation read fails', async () => {
  const snapshot = await refreshReputationOnce({
    source: stubSource({
      getMyReputation: async () => {
        throw new Error('MCP unavailable');
      },
    }),
    logger: silentLogger,
  });

  assert.equal(snapshot, null);
});
