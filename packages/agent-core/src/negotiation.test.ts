import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import {
  decideCounter,
  handleCounterOffers,
  type NegotiationMemory,
  type HandleCounterOffersConfig,
} from './negotiation.js';
import type { CostEstimator, CostResult } from './estimator.js';
import type { Gig, Proposal, ProposalMilestone } from './client.js';

const silentLogger = pino({ level: 'silent' });

// --- decideCounter (pure policy) -------------------------------------------

test('decideCounter accepts a counter at the floor', () => {
  assert.equal(
    decideCounter({ counterPrice: 1000, floorPrice: 1000, alreadyCountered: false }),
    'accept',
  );
});

test('decideCounter accepts a counter above the floor', () => {
  assert.equal(
    decideCounter({ counterPrice: 1200, floorPrice: 1000, alreadyCountered: false }),
    'accept',
  );
});

test('decideCounter counters back once when below floor and not yet countered', () => {
  assert.equal(
    decideCounter({ counterPrice: 800, floorPrice: 1000, alreadyCountered: false }),
    'counter',
  );
});

test('decideCounter declines a repeat below-floor counter once we already countered', () => {
  assert.equal(
    decideCounter({ counterPrice: 800, floorPrice: 1000, alreadyCountered: true }),
    'decline',
  );
});

// --- handleCounterOffers (orchestration over a stub client) -----------------

const MS: ProposalMilestone[] = [{ title: 'All', duration: '7 days', deliverables: ['x'] }];

function memory(seed: string[] = []): NegotiationMemory {
  const set = new Set(seed);
  return {
    hasCountered: (id) => set.has(id),
    markCountered: (id) => void set.add(id),
    clear: (id) => void set.delete(id),
  };
}

interface Recorder {
  accepted: string[];
  countered: Array<{ id: string; price?: number }>;
  declined: string[];
}

function stubClient(proposals: Proposal[], rec: Recorder): HandleCounterOffersConfig['client'] {
  return {
    async listProposals() {
      return proposals;
    },
    async getGig(gigId: string) {
      return { id: gigId, title: 'A gig', budget: 1000 } as Gig;
    },
    async acceptCounter(id: string) {
      rec.accepted.push(id);
      return { contractId: `contract_for_${id}` };
    },
    async counterProposal(id: string, data) {
      rec.countered.push({ id, price: data.price });
      return { proposal: {} as Proposal };
    },
    async declineCounter(id: string) {
      rec.declined.push(id);
    },
  };
}

function counteredProposal(over: Partial<Proposal>): Proposal {
  return {
    id: 'p1',
    gigId: 'g1',
    status: 'pending',
    negotiationStatus: 'countered',
    counterBy: 'payer',
    counterPrice: 800,
    ...over,
  } as Proposal;
}

const floorPricing = () => ({ price: 1000, timeline: '7 days', milestones: MS });

test('accepts a payer counter at/above the floor', async () => {
  const rec: Recorder = { accepted: [], countered: [], declined: [] };
  const p = counteredProposal({ counterPrice: 1000 });
  await handleCounterOffers({
    client: stubClient([p], rec),
    pricingCalc: floorPricing,
    memory: memory(),
    logger: silentLogger,
  });
  assert.deepEqual(rec.accepted, ['p1']);
  assert.equal(rec.countered.length, 0);
  assert.equal(rec.declined.length, 0);
});

test('counters back once at the firm floor price when below floor', async () => {
  const rec: Recorder = { accepted: [], countered: [], declined: [] };
  const mem = memory();
  const p = counteredProposal({ counterPrice: 800 });
  await handleCounterOffers({
    client: stubClient([p], rec),
    pricingCalc: floorPricing,
    memory: mem,
    logger: silentLogger,
  });
  assert.deepEqual(rec.countered, [{ id: 'p1', price: 1000 }]);
  assert.equal(mem.hasCountered('p1'), true, 'marks the proposal as countered for next round');
});

test('declines a below-floor counter we have already countered once', async () => {
  const rec: Recorder = { accepted: [], countered: [], declined: [] };
  const p = counteredProposal({ counterPrice: 800 });
  await handleCounterOffers({
    client: stubClient([p], rec),
    pricingCalc: floorPricing,
    memory: memory(['p1']),
    logger: silentLogger,
  });
  assert.deepEqual(rec.declined, ['p1']);
  assert.equal(rec.countered.length, 0);
});

test('skips proposals where it is the payer’s turn (counterBy=handler)', async () => {
  const rec: Recorder = { accepted: [], countered: [], declined: [] };
  const p = counteredProposal({ counterBy: 'handler' });
  await handleCounterOffers({
    client: stubClient([p], rec),
    pricingCalc: floorPricing,
    memory: memory(),
    logger: silentLogger,
  });
  assert.equal(rec.accepted.length + rec.countered.length + rec.declined.length, 0);
});

test('ignores pending proposals with no open counter', async () => {
  const rec: Recorder = { accepted: [], countered: [], declined: [] };
  const p = counteredProposal({ negotiationStatus: null, counterPrice: null });
  await handleCounterOffers({
    client: stubClient([p], rec),
    pricingCalc: floorPricing,
    memory: memory(),
    logger: silentLogger,
  });
  assert.equal(rec.accepted.length + rec.countered.length + rec.declined.length, 0);
});

// --- floor sourced from the cost estimator's target -------------------------
//
// When an estimator is wired, the firm floor is its `target` (1.5× cost), NOT
// the pricingCalc price and NOT the (possibly higher) bid price. These cases use
// pricingCalc price 1000 but an estimator target of 500 to prove which one wins.

function fakeEstimator(target: number, price = target): CostEstimator {
  return {
    async estimate(): Promise<CostResult> {
      return {
        resources: {
          claudeCalls: 1,
          claudeKTokens: 1,
          browserMinutes: 0,
          computeMinutes: 1,
          runs: 1,
        },
        cost: target / 1.5,
        target,
        price,
        markup: 1.5,
        source: 'claude',
      };
    },
  };
}

test('floor uses the estimator target: accepts a counter at/above target even below pricingCalc price', async () => {
  const rec: Recorder = { accepted: [], countered: [], declined: [] };
  // counter 600 is ≥ target 500 but < pricingCalc price 1000 and < bid price 900
  const p = counteredProposal({ counterPrice: 600 });
  await handleCounterOffers({
    client: stubClient([p], rec),
    pricingCalc: floorPricing, // price 1000
    costEstimator: fakeEstimator(500, 900),
    memory: memory(),
    logger: silentLogger,
  });
  assert.deepEqual(rec.accepted, ['p1'], 'accepted because floor is the 500 target, not 1000/900');
  assert.equal(rec.countered.length + rec.declined.length, 0);
});

test('floor uses the estimator target: counters back at the target when below it', async () => {
  const rec: Recorder = { accepted: [], countered: [], declined: [] };
  const p = counteredProposal({ counterPrice: 400 }); // below target 500
  await handleCounterOffers({
    client: stubClient([p], rec),
    pricingCalc: floorPricing,
    costEstimator: fakeEstimator(500, 900),
    memory: memory(),
    logger: silentLogger,
  });
  assert.deepEqual(
    rec.countered,
    [{ id: 'p1', price: 500 }],
    'counters at the 500 target, not the pricingCalc 1000',
  );
});

test('one failing proposal does not abort the sweep', async () => {
  const rec: Recorder = { accepted: [], countered: [], declined: [] };
  const bad = counteredProposal({ id: 'bad', counterPrice: 1000 });
  const good = counteredProposal({ id: 'good', gigId: 'g2', counterPrice: 1000 });
  const client = stubClient([bad, good], rec);
  const failing: HandleCounterOffersConfig['client'] = {
    ...client,
    async acceptCounter(id: string) {
      if (id === 'bad') throw new Error('boom');
      return client.acceptCounter(id);
    },
  };
  await handleCounterOffers({
    client: failing,
    pricingCalc: floorPricing,
    memory: memory(),
    logger: silentLogger,
  });
  assert.deepEqual(rec.accepted, ['good'], 'good proposal still processed after bad one threw');
});
