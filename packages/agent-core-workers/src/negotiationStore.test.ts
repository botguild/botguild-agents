import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Gig, HandleCounterOffersConfig, Proposal } from '@botguild/agent-core';
import { createD1NegotiationStore, runNegotiationSweep } from './negotiationStore.js';
import { createMemoryD1 } from './testing.js';
import { createConsoleLogger } from './logger.js';

const silentLogger = createConsoleLogger({ service: 'test', level: 'silent' });

test('loadCounteredSet is empty on a fresh database', async () => {
  const store = createD1NegotiationStore(createMemoryD1());
  assert.deepEqual(await store.loadCounteredSet(), new Set());
});

test('markCountered mutations persist only after an awaited flush', async () => {
  const db = createMemoryD1();
  const store = createD1NegotiationStore(db);

  const { memory, flush } = await store.hydrate();
  memory.markCountered('p_1');
  memory.markCountered('p_2');
  assert.equal(memory.hasCountered('p_1'), true, 'visible in-memory immediately');
  assert.deepEqual(await store.loadCounteredSet(), new Set(), 'not in D1 before flush');

  await flush();
  assert.deepEqual(await store.loadCounteredSet(), new Set(['p_1', 'p_2']));

  // A second store over the same database hydrates the persisted set — the
  // redeploy-survival property the flat-file store had on Fly volumes.
  const rehydrated = await createD1NegotiationStore(db).hydrate();
  assert.equal(rehydrated.memory.hasCountered('p_1'), true);
});

test('clear removes a persisted id on flush', async () => {
  const db = createMemoryD1();
  const store = createD1NegotiationStore(db);

  const first = await store.hydrate();
  first.memory.markCountered('p_1');
  await first.flush();

  const second = await store.hydrate();
  second.memory.clear('p_1');
  assert.equal(second.memory.hasCountered('p_1'), false);
  await second.flush();

  assert.deepEqual(await store.loadCounteredSet(), new Set());
});

test('mark-then-clear within one sweep nets out; flush is idempotent', async () => {
  const db = createMemoryD1();
  const store = createD1NegotiationStore(db);

  const { memory, flush } = await store.hydrate();
  memory.markCountered('p_1');
  memory.clear('p_1');
  await flush();
  await flush();

  assert.deepEqual(await store.loadCounteredSet(), new Set());
});

// --- runNegotiationSweep against agent-core's real handleCounterOffers ------

function counteredProposal(id: string, counterPrice: number): Proposal {
  return {
    id,
    gigId: 'g_1',
    negotiationStatus: 'countered',
    counterBy: 'payer',
    counterPrice,
  } as unknown as Proposal;
}

function stubNegotiationClient(proposals: () => Proposal[]): {
  client: HandleCounterOffersConfig['client'];
  calls: { countered: string[]; accepted: string[]; declined: string[] };
} {
  const calls = { countered: [] as string[], accepted: [] as string[], declined: [] as string[] };
  const client: HandleCounterOffersConfig['client'] = {
    listProposals: async () => proposals(),
    getGig: async (gigId: string) => ({ id: gigId, budget: 50 }) as unknown as Gig,
    acceptCounter: async (proposalId: string) => {
      calls.accepted.push(proposalId);
      return { contractId: 'c_1' };
    },
    counterProposal: async (proposalId: string) => {
      calls.countered.push(proposalId);
      return { proposal: {} as Proposal };
    },
    declineCounter: async (proposalId: string) => {
      calls.declined.push(proposalId);
    },
  };
  return { client, calls };
}

const pricingCalc = () => ({ price: 100, timeline: '3 days', milestones: [] });

test('sweep counters once, persists the memory, then declines on the next sweep', async () => {
  const db = createMemoryD1();
  const store = createD1NegotiationStore(db);
  const { client, calls } = stubNegotiationClient(() => [counteredProposal('p_low', 40)]);
  const config = { client, pricingCalc, store, logger: silentLogger };

  // Sweep 1: below-floor counter, not yet countered → counter back once, and
  // the awaited write-back lands in D1 before the sweep resolves.
  await runNegotiationSweep(config);
  assert.deepEqual(calls.countered, ['p_low']);
  assert.deepEqual(await store.loadCounteredSet(), new Set(['p_low']));

  // Sweep 2 hydrates the persisted memory (fresh store = fresh invocation):
  // still below floor and already countered → decline and clear the id.
  const secondInvocationStore = createD1NegotiationStore(db);
  await runNegotiationSweep({ ...config, store: secondInvocationStore });
  assert.deepEqual(calls.declined, ['p_low']);
  assert.deepEqual(calls.countered, ['p_low'], 'never re-counters');
  assert.deepEqual(await store.loadCounteredSet(), new Set(), 'resolved id cleared from D1');
});

test('sweep accepts an at-floor counter and clears any remembered id', async () => {
  const db = createMemoryD1();
  const store = createD1NegotiationStore(db);
  const first = await store.hydrate();
  first.memory.markCountered('p_ok');
  await first.flush();

  const { client, calls } = stubNegotiationClient(() => [counteredProposal('p_ok', 120)]);
  await runNegotiationSweep({ client, pricingCalc, store, logger: silentLogger });

  assert.deepEqual(calls.accepted, ['p_ok']);
  assert.deepEqual(await store.loadCounteredSet(), new Set());
});

test('per-proposal failure does not lose the memory of counters already sent', async () => {
  const db = createMemoryD1();
  const store = createD1NegotiationStore(db);
  // p_low is countered successfully; p_crash fails at counterProposal time.
  // handleCounterOffers isolates the failure, and the flush still persists
  // the p_low mark — losing it would re-counter next sweep.
  const { client, calls } = stubNegotiationClient(() => [
    counteredProposal('p_low', 40),
    counteredProposal('p_crash', 40),
  ]);
  const failingClient: HandleCounterOffersConfig['client'] = {
    ...client,
    counterProposal: async (proposalId: string, data) => {
      if (proposalId === 'p_crash') throw new Error('platform 500');
      return client.counterProposal(proposalId, data);
    },
  };

  await runNegotiationSweep({ client: failingClient, pricingCalc, store, logger: silentLogger });

  assert.deepEqual(calls.countered, ['p_low']);
  assert.deepEqual(
    await store.loadCounteredSet(),
    new Set(['p_low']),
    'successful counter persisted; failed one retried next sweep',
  );
});
