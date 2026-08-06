import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import {
  applyRateCard,
  bidPrice,
  createCostEstimator,
  type RateCard,
  type ResourceEstimate,
} from './estimator.js';
import type { Gig } from './client.js';

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;

const card: RateCard = {
  perClaudeCall: 0.5,
  perKToken: 0.25,
  perBrowserMinute: 1.5,
  perComputeMinute: 0.4,
  perRun: 2,
  fixedOverhead: 15,
};

const fallback: ResourceEstimate = {
  claudeCalls: 4,
  claudeKTokens: 20,
  browserMinutes: 0,
  computeMinutes: 15,
  runs: 1,
};

// --- applyRateCard (deterministic cost) ------------------------------------

test('applyRateCard sums quantities × rates plus fixed overhead', () => {
  const est: ResourceEstimate = {
    claudeCalls: 12,
    claudeKTokens: 60,
    browserMinutes: 60,
    computeMinutes: 60,
    runs: 8,
  };
  // 15 + 12*0.5 + 60*0.25 + 60*1.5 + 60*0.4 + 8*2 = 15+6+15+90+24+16 = 166
  assert.equal(applyRateCard(est, card), 166);
});

test('applyRateCard has no minimum: an empty estimate costs only the fixed overhead', () => {
  const tiny: ResourceEstimate = {
    claudeCalls: 0,
    claudeKTokens: 0,
    browserMinutes: 0,
    computeMinutes: 0,
    runs: 0,
  };
  assert.equal(applyRateCard(tiny, card), 15);
});

test('a no-browser job costs less than the same job with browser minutes', () => {
  const base: ResourceEstimate = {
    claudeCalls: 6,
    claudeKTokens: 40,
    browserMinutes: 0,
    computeMinutes: 30,
    runs: 1,
  };
  const withBrowser: ResourceEstimate = { ...base, browserMinutes: 30 };
  assert.ok(applyRateCard(withBrowser, card) > applyRateCard(base, card));
});

// --- bidPrice (the pure 1.5× rule) -----------------------------------------

test('bidPrice: target is round(1.5 × cost) with no floor or clamp', () => {
  assert.deepEqual(bidPrice(122.5, 0), { target: 184, price: 184 });
});

test('bidPrice: gig priced below target → bid the 1.5× target', () => {
  // cost 100 → target 150; gig only budgets 90 → still bid 150
  assert.deepEqual(bidPrice(100, 90), { target: 150, price: 150 });
});

test('bidPrice: gig priced at/above target → bid aligns up to the gig amount', () => {
  // cost 100 → target 150; gig budgets 400 → bid 400 (target unchanged)
  assert.deepEqual(bidPrice(100, 400), { target: 150, price: 400 });
});

test('bidPrice: a tiny cost yields a tiny bid — no floor pulls it up', () => {
  assert.deepEqual(bidPrice(15, 10), { target: 23, price: 23 });
});

test('bidPrice: respects a custom markup', () => {
  assert.deepEqual(bidPrice(100, 0, 2), { target: 200, price: 200 });
});

// --- createCostEstimator (real estimator, fetch-stubbed) -------------------
//
// The estimator builds its own Anthropic client over the global fetch. Stubbing
// fetch drives the tool-use, error, and caching branches with no network.

function toolUseBody(input: Record<string, number>) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'report_resource_estimate', input }],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: 'gig-1',
    title: 'Watch my status page',
    category: 'Ops & Automation',
    budget: 120,
    description: 'Monitor uptime and alert on downtime.',
    deliverables: ['Weekly watch report'],
    acceptanceCriteria: [{ kind: 'text', text: 'alert fires on a test trigger' }],
    timeline: '1 week',
    ...overrides,
  } as Gig;
}

function makeEstimator(overrides: Partial<Parameters<typeof createCostEstimator>[0]> = {}) {
  return createCostEstimator({
    apiKey: 'test-key',
    botName: 'TestBot',
    botDescription: 'Monitors pages and alerts on change.',
    rateCard: card,
    fallbackEstimate: fallback,
    logger: silentLogger,
    ...overrides,
  });
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('createCostEstimator: prices from the model estimate via the rate card', async () => {
  globalThis.fetch = (async () =>
    jsonResponse(
      toolUseBody({
        claudeCalls: 12,
        claudeKTokens: 60,
        browserMinutes: 60,
        computeMinutes: 60,
        runs: 8,
      }),
    )) as typeof globalThis.fetch;

  // gig budget 120 is below target, so price == target
  const result = await makeEstimator().estimate(makeGig({ budget: 120 }));
  assert.equal(result.source, 'claude');
  assert.equal(result.cost, 166); // deterministic from the rate card
  assert.equal(result.target, 249); // round(1.5 * 166)
  assert.equal(result.price, 249); // max(249, 120)
});

test('createCostEstimator: bid aligns up to a gig budget above target', async () => {
  globalThis.fetch = (async () =>
    jsonResponse(
      toolUseBody({
        claudeCalls: 0,
        claudeKTokens: 0,
        browserMinutes: 0,
        computeMinutes: 0,
        runs: 0,
      }),
    )) as typeof globalThis.fetch;

  // cost 15 → target 23; gig budgets 400 → bid 400
  const result = await makeEstimator().estimate(makeGig({ budget: 400 }));
  assert.equal(result.cost, 15);
  assert.equal(result.target, 23);
  assert.equal(result.price, 400);
});

test('createCostEstimator: caches per gig id (one model call for repeated estimates)', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(
      toolUseBody({
        claudeCalls: 4,
        claudeKTokens: 20,
        browserMinutes: 0,
        computeMinutes: 15,
        runs: 1,
      }),
    );
  }) as typeof globalThis.fetch;

  const estimator = makeEstimator();
  const gig = makeGig();
  const first = await estimator.estimate(gig);
  const second = await estimator.estimate(gig);
  assert.equal(calls, 1, 'second estimate is served from cache');
  assert.deepEqual(first, second);
});

test('createCostEstimator: the per-gig cache is bounded (oldest entry is evicted)', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(
      toolUseBody({
        claudeCalls: 1,
        claudeKTokens: 1,
        browserMinutes: 0,
        computeMinutes: 1,
        runs: 1,
      }),
    );
  }) as typeof globalThis.fetch;

  const estimator = makeEstimator();
  // Fill the cache past its 500-entry cap with distinct gig ids; gig-0 is the
  // oldest and gets evicted once we exceed the cap.
  for (let i = 0; i < 501; i++) {
    await estimator.estimate(makeGig({ id: `gig-${i}` }));
  }
  assert.equal(calls, 501, 'one model call per distinct gig');

  // gig-500 is still cached (recent) → no new call.
  await estimator.estimate(makeGig({ id: 'gig-500' }));
  assert.equal(calls, 501, 'recent gig served from cache');

  // gig-0 was evicted → re-estimating re-calls the model.
  await estimator.estimate(makeGig({ id: 'gig-0' }));
  assert.equal(calls, 502, 'evicted gig is re-estimated');
});

test('createCostEstimator: falls back to the deterministic estimate when the call errors', async () => {
  // 400 is non-retryable, so the SDK throws immediately.
  globalThis.fetch = (async () =>
    jsonResponse(
      { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
      400,
    )) as typeof globalThis.fetch;

  const result = await makeEstimator().estimate(makeGig({ budget: 50 }));
  assert.equal(result.source, 'fallback');
  // fallback cost: 15 + 4*0.5 + 20*0.25 + 0 + 15*0.4 + 1*2 = 15+2+5+0+6+2 = 30
  assert.equal(result.cost, 30);
  assert.equal(result.target, 45); // round(1.5 * 30)
  assert.equal(result.price, 50); // max(45, 50) → gig budget wins
});

test('createCostEstimator: coerces missing/invalid quantities to the fallback value', async () => {
  globalThis.fetch = (async () =>
    // browserMinutes missing, runs negative → both replaced by fallback values
    jsonResponse(
      toolUseBody({ claudeCalls: 4, claudeKTokens: 20, computeMinutes: 15, runs: -3 }),
    )) as typeof globalThis.fetch;

  const result = await makeEstimator().estimate(makeGig());
  assert.equal(result.resources.browserMinutes, fallback.browserMinutes);
  assert.equal(result.resources.runs, fallback.runs);
  // valid fields are kept as reported
  assert.equal(result.resources.claudeCalls, 4);
});

// --- maxPriceUsd (platform bid cap) -----------------------------------------
// Marketplace preview only accepts bids inside a platform band (observed
// $0.10–$0.20; a $1 bid is 403-rejected). The cap bounds BOTH the bid price
// and the negotiation-floor target, so proposer and negotiation inherit one
// consistent ceiling.

test('bidPrice: maxPrice caps both target and price', () => {
  // cost 0.528 → raw target round(0.792) = 1, capped to the 0.20 band
  assert.deepEqual(bidPrice(0.528, 0.1, 1.5, 0.2), { target: 0.2, price: 0.2 });
});

test('bidPrice: a budget above the cap cannot push the price past it', () => {
  assert.deepEqual(bidPrice(100, 400, 1.5, 0.2), { target: 0.2, price: 0.2 });
});

test('bidPrice: bids already inside the cap are untouched', () => {
  // cost 0.1 → target round(0.15) = 0; budget 0.15 wins, still under the cap
  assert.deepEqual(bidPrice(0.1, 0.15, 1.5, 0.2), { target: 0, price: 0.15 });
});

test('bidPrice: without maxPrice behaviour is unchanged', () => {
  assert.deepEqual(bidPrice(100, 400), { target: 150, price: 400 });
});

test('createCostEstimator: maxPriceUsd caps the estimate price and target', async () => {
  globalThis.fetch = (async () =>
    jsonResponse(
      toolUseBody({
        claudeCalls: 12,
        claudeKTokens: 60,
        browserMinutes: 60,
        computeMinutes: 60,
        runs: 8,
      }),
    )) as typeof fetch;
  const estimator = makeEstimator({ maxPriceUsd: 0.2 });
  const result = await estimator.estimate(makeGig({ budget: 400 }));
  assert.equal(result.price, 0.2);
  assert.equal(result.target, 0.2);
});
