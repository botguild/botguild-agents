import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import { createProposer, type BotProfile } from './proposer.js';
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
  { title: 'M1 — Deliver', amount: 100, duration: '2 days', deliverables: ['the thing'] },
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
    acceptanceCriteria: ['alert fires on a test trigger'],
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
  const draft = await proposer.generateProposal(makeGig());

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
  const draft = await proposer.generateProposal(makeGig());

  assert.equal(draft.assumptions?.length, 1);
  assert.match(draft.assumptions![0], /Ops & Automation/);
  assert.equal(draft.price, 100);
  assert.equal(draft.warrantyOffer, '14-day selector-fix window.');
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
