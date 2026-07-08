import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentClient, Gig } from '@botguild/agent-core';
import { createKVSeenStore, createMemorySeenStore, runGigPollSweep } from './pollSweep.js';
import { createMemoryKV } from './testing.js';
import { createConsoleLogger } from './logger.js';

const silentLogger = createConsoleLogger({ service: 'test', level: 'silent' });

function gig(id: string): Gig {
  return { id, title: `gig ${id}` } as Gig;
}

function stubClient(gigs: Gig[] | (() => Gig[])): Pick<AgentClient, 'listGigs'> & {
  calls: Array<{ status?: string }>;
} {
  const calls: Array<{ status?: string }> = [];
  return {
    calls,
    listGigs: async (params?: { status?: string }) => {
      calls.push({ status: params?.status });
      return typeof gigs === 'function' ? gigs() : gigs;
    },
  };
}

test('one sweep processes new gigs, marks them seen, and lists open gigs only', async () => {
  const client = stubClient([gig('g_1'), gig('g_2')]);
  const seen = createMemorySeenStore();
  const processed: string[] = [];

  const result = await runGigPollSweep({
    client,
    seen,
    onGig: async (g) => {
      processed.push(g.id);
    },
    logger: silentLogger,
  });

  assert.deepEqual(client.calls, [{ status: 'open' }]);
  assert.deepEqual(processed, ['g_1', 'g_2']);
  assert.deepEqual(result, { listed: 2, processed: 2, skipped: 0, failed: 0 });
  assert.equal(seen.size(), 2);
});

test('already-seen gigs are skipped on the next sweep (cross-invocation dedupe)', async () => {
  const client = stubClient([gig('g_1'), gig('g_2')]);
  const seen = createMemorySeenStore();
  const processed: string[] = [];
  const config = {
    client,
    seen,
    onGig: async (g: Gig) => {
      processed.push(g.id);
    },
    logger: silentLogger,
  };

  await runGigPollSweep(config);
  const second = await runGigPollSweep(config);

  assert.deepEqual(processed, ['g_1', 'g_2'], 'no gig processed twice');
  assert.deepEqual(second, { listed: 2, processed: 0, skipped: 2, failed: 0 });
});

test('a failing gig does not abort the sweep and is retried next sweep', async () => {
  const client = stubClient([gig('g_bad'), gig('g_good')]);
  const seen = createMemorySeenStore();
  let failOnce = true;
  const processed: string[] = [];
  const config = {
    client,
    seen,
    onGig: async (g: Gig) => {
      if (g.id === 'g_bad' && failOnce) {
        failOnce = false;
        throw new Error('proposal submit failed');
      }
      processed.push(g.id);
    },
    logger: silentLogger,
  };

  const first = await runGigPollSweep(config);
  assert.deepEqual(first, { listed: 2, processed: 1, skipped: 0, failed: 1 });
  assert.deepEqual(processed, ['g_good'], 'error isolated to the failing gig');

  const second = await runGigPollSweep(config);
  assert.deepEqual(second, { listed: 2, processed: 1, skipped: 1, failed: 0 });
  assert.deepEqual(processed, ['g_good', 'g_bad'], 'failed gig retried, not marked seen');
});

test('listGigs failure skips the sweep without throwing', async () => {
  const client: Pick<AgentClient, 'listGigs'> = {
    listGigs: async () => {
      throw new Error('platform 500');
    },
  };

  const result = await runGigPollSweep({
    client,
    seen: createMemorySeenStore(),
    onGig: async () => {},
    logger: silentLogger,
  });

  assert.deepEqual(result, { listed: 0, processed: 0, skipped: 0, failed: 0 });
});

test('createKVSeenStore round-trips through KV with prefix and TTL', async () => {
  const kv = createMemoryKV();
  const seen = createKVSeenStore(kv, { prefix: 'p:', ttlSeconds: 3600 });

  assert.equal(await seen.has('g_1'), false);
  await seen.add('g_1');
  assert.equal(await seen.has('g_1'), true);
  assert.deepEqual(kv.store.get('p:g_1'), { value: '1', expirationTtl: 3600 });
});

test('createKVSeenStore defaults: seen-gig: prefix, 30-day TTL', async () => {
  const kv = createMemoryKV();
  const seen = createKVSeenStore(kv);
  await seen.add('g_1');
  assert.deepEqual(kv.store.get('seen-gig:g_1'), { value: '1', expirationTtl: 30 * 24 * 60 * 60 });
});
