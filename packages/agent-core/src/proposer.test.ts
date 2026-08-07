import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import { createProposer, type BotProfile } from './proposer.js';
import type { CostEstimator, CostResult } from './estimator.js';
import type { Gig, ProposalMilestone } from './client.js';

// The proposer constructs its own Anthropic client, which talks over the
// runtime's global fetch. Stubbing fetch lets us drive every branch — success,
// empty response, API error — with no network and no module-mock flag.
const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;

const botProfile: BotProfile = {
  name: 'TestBot',
  category: 'Ops & Automation',
  capabilities: ['uptime monitoring'],
  workingStyle: 'checkpoints',
  warrantyTerms: '14-day selector-fix window.',
};

const milestones: ProposalMilestone[] = [
  { title: 'M1 — Deliver', duration: '2 days', deliverables: ['the thing'] },
];

// Records the gig it was called with so we can assert pricing is deterministic
// and driven by the gig, never by Claude.
let pricedGig: Gig | null = null;
function pricingCalc(gig: Gig) {
  pricedGig = gig;
  return { price: 100, timeline: '2 business days', milestones };
}

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: 'gig-1',
    title: 'Watch my status page',
    category: 'Ops & Automation',
    budget: 120,
    description: 'Monitor uptime and alert on downtime.',
    acceptanceCriteria: [{ kind: 'text', text: 'alert fires on a test trigger' }],
    timeline: '1 week',
    ...overrides,
  } as Gig;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Minimal Anthropic Messages API response. `text: null` yields empty content.
function messageBody(text: string | null) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: text === null ? [] : [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  pricedGig = null;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('uses the Claude cover note when generation succeeds', async () => {
  const captured: { url: string; body: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: typeof input === 'string' ? input : input.toString(),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return jsonResponse(
      messageBody('I will poll your status page every minute and alert on downtime.'),
    );
  }) as typeof globalThis.fetch;

  const proposer = createProposer({
    apiKey: 'test-key',
    botProfile,
    pricingCalc,
    logger: silentLogger,
  });
  // warrantyRequired: the profile-sourced offer below only applies to gigs
  // that ask for a warranty.
  const draft = await proposer.generateProposal(makeGig({ warrantyRequired: true }));

  assert.deepEqual(draft.assumptions, [
    'I will poll your status page every minute and alert on downtime.',
  ]);
  // Pricing fields come straight from pricingCalc / the profile.
  assert.equal(draft.price, 100);
  assert.equal(draft.timeline, '2 business days');
  assert.deepEqual(draft.milestones, milestones);
  assert.equal(draft.warrantyOffer, '14-day selector-fix window.');
  assert.equal(pricedGig?.id, 'gig-1', 'pricingCalc receives the gig');

  // Request shape: Haiku, capped tokens, and the system prompt cached (the
  // documented cost-control decision).
  assert.equal(captured.length, 1, 'fetch was called once');
  assert.match(captured[0].url, /\/v1\/messages$/);
  const sent = JSON.parse(captured[0].body);
  assert.equal(sent.model, 'claude-haiku-4-5');
  assert.equal(sent.max_tokens, 200);
  assert.equal(sent.system[0].cache_control.type, 'ephemeral');
});

test('falls back to a deterministic cover note when Claude returns empty', async () => {
  globalThis.fetch = (async () => jsonResponse(messageBody(null))) as typeof globalThis.fetch;

  const proposer = createProposer({
    apiKey: 'test-key',
    botProfile,
    pricingCalc,
    logger: silentLogger,
  });
  const draft = await proposer.generateProposal(makeGig({ title: 'Watch my status page' }));

  assert.equal(draft.assumptions?.length, 1);
  assert.match(draft.assumptions![0], /Watch my status page/);
  assert.match(draft.assumptions![0], /Ops & Automation/);
  // The proposal is still valid — pricing is unaffected by the cover-note failure.
  assert.equal(draft.price, 100);
  assert.deepEqual(draft.milestones, milestones);
});

test('falls back when the Claude request errors', async () => {
  // 400 is non-retryable, so the SDK throws immediately rather than backing off.
  globalThis.fetch = (async () =>
    jsonResponse(
      { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
      400,
    )) as typeof globalThis.fetch;

  const proposer = createProposer({
    apiKey: 'test-key',
    botProfile,
    pricingCalc,
    logger: silentLogger,
  });
  const draft = await proposer.generateProposal(makeGig({ warrantyRequired: true }));

  assert.equal(draft.assumptions?.length, 1);
  assert.match(draft.assumptions![0], /Ops & Automation/);
  assert.equal(draft.price, 100);
  assert.equal(draft.warrantyOffer, '14-day selector-fix window.');
});

// --- cost-estimator pricing branch -----------------------------------------

function fakeEstimator(price: number): CostEstimator {
  return {
    async estimate(_gig: Gig): Promise<CostResult> {
      return {
        resources: {
          claudeCalls: 1,
          claudeKTokens: 1,
          browserMinutes: 0,
          computeMinutes: 1,
          runs: 1,
        },
        cost: price / 1.5,
        target: price,
        price,
        markup: 1.5,
        source: 'claude',
      };
    },
  };
}

test('uses the estimator price (not the pricingCalc baseline) when an estimator is wired', async () => {
  globalThis.fetch = (async () => jsonResponse(messageBody('On it.'))) as typeof globalThis.fetch;

  const proposer = createProposer({
    apiKey: 'test-key',
    botProfile,
    pricingCalc, // baseline price 100
    costEstimator: fakeEstimator(250),
    logger: silentLogger,
  });
  const draft = await proposer.generateProposal(makeGig());

  assert.equal(draft.price, 250, 'estimator price overrides the baseline');
  // timeline + milestones still come from pricingCalc
  assert.equal(draft.timeline, '2 business days');
  assert.deepEqual(draft.milestones, milestones);
});

test('falls back to the pricingCalc baseline price when the estimator throws', async () => {
  globalThis.fetch = (async () => jsonResponse(messageBody('On it.'))) as typeof globalThis.fetch;

  const throwingEstimator: CostEstimator = {
    async estimate(): Promise<CostResult> {
      throw new Error('estimator boom');
    },
  };

  const proposer = createProposer({
    apiKey: 'test-key',
    botProfile,
    pricingCalc, // baseline price 100
    costEstimator: throwingEstimator,
    logger: silentLogger,
  });
  const draft = await proposer.generateProposal(makeGig());

  assert.equal(draft.price, 100, 'a failed estimate does not block the proposal');
  assert.deepEqual(draft.milestones, milestones);
});

test('omits warrantyOffer when the profile has no warranty terms', async () => {
  globalThis.fetch = (async () => jsonResponse(messageBody('Done.'))) as typeof globalThis.fetch;

  const proposer = createProposer({
    apiKey: 'test-key',
    botProfile: { ...botProfile, warrantyTerms: '' },
    pricingCalc,
    logger: silentLogger,
  });
  const draft = await proposer.generateProposal(makeGig());

  assert.equal(draft.warrantyOffer, undefined);
});

// --- warranty gating on the gig's own requirement ----------------------------
// A warranty offer on a proposal makes the platform attach its standard
// (4-week) warrantyExpires window to the resulting contract — even when the
// gig said "warranty: not required" (observed live on contract
// 01KZBQE99RPWQ33Q9KK6JK2XHM). Offer the profile's terms only when the gig
// asks for a warranty; the cover-note prompt must not advertise one otherwise
// (the CACHED system prompt still contains the profile's warranty pitch, so
// the per-gig user message carries the suppression).

test('offers no warranty when the gig does not require one', async () => {
  const captured: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured.push(typeof init?.body === 'string' ? init.body : '');
    return jsonResponse(messageBody('A concrete note.'));
  }) as typeof globalThis.fetch;

  const proposer = createProposer({
    apiKey: 'test-key',
    botProfile,
    pricingCalc,
    logger: silentLogger,
  });
  const draft = await proposer.generateProposal(makeGig({ warrantyRequired: false }));

  assert.equal(draft.warrantyOffer, undefined);
  const userContent = (JSON.parse(captured[0]!) as { messages: { content: string }[] }).messages[0]!
    .content;
  assert.match(userContent, /does not require a warranty/i);
});

test('offers the profile warranty when the gig requires one', async () => {
  const captured: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured.push(typeof init?.body === 'string' ? init.body : '');
    return jsonResponse(messageBody('A concrete note.'));
  }) as typeof globalThis.fetch;

  const proposer = createProposer({
    apiKey: 'test-key',
    botProfile,
    pricingCalc,
    logger: silentLogger,
  });
  const draft = await proposer.generateProposal(makeGig({ warrantyRequired: true }));

  assert.equal(draft.warrantyOffer, '14-day selector-fix window.');
  const userContent = (JSON.parse(captured[0]!) as { messages: { content: string }[] }).messages[0]!
    .content;
  assert.doesNotMatch(userContent, /does not require a warranty/i);
});
