import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import type { Gig } from '@botguild/agent-core';
import { createGigParser } from './parser.js';

// The parser asks Claude (Haiku) to extract a WatchJobConfig as JSON. We stub
// global fetch — the path the Anthropic SDK uses — to return canned messages.
const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: 'gig-1',
    title: 'Monitor my status page',
    description: 'Alert me when it changes.',
    category: 'Ops & Automation',
    budget: 200,
    acceptanceCriteria: ['alert on change'],
    ...overrides,
  } as Gig;
}

// Wrap an arbitrary text payload as an Anthropic Messages API response.
function messageResponse(text: string): Response {
  const body = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(): Response {
  const body = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 0 },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const goodExtraction = {
  targets: ['https://example.com/status'],
  watchType: 'change',
  schedule: '0 9 * * *',
  requiresJs: false,
  selectors: ['#status'],
  screenshot: false,
  deliveryChannelHint: 'report',
  reportFormat: 'summary',
  confidence: 0.9,
  clarificationQuestion: null,
};

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('parses a high-confidence extraction into a WatchJobConfig with no clarification', async () => {
  globalThis.fetch = (async () =>
    messageResponse(JSON.stringify(goodExtraction))) as typeof globalThis.fetch;

  const parser = createGigParser({ apiKey: 'test-key', logger: silentLogger });
  const result = await parser.parse(makeGig(), 'contract-1');

  assert.equal(result.needsClarification, false);
  assert.equal(result.clarificationQuestion, undefined);
  assert.deepEqual(result.config.targets, ['https://example.com/status']);
  assert.equal(result.config.watchType, 'change');
  assert.equal(result.config.schedule, '0 9 * * *');
  assert.equal(result.config.confidence, 0.9);
  // Wiring the parser doesn't fill in: ids come from the caller, milestones later.
  assert.equal(result.config.gigId, 'gig-1');
  assert.equal(result.config.contractId, 'contract-1');
  assert.deepEqual(result.config.milestoneIds, []);
});

test('flags clarification and surfaces the question when confidence is below threshold', async () => {
  globalThis.fetch = (async () =>
    messageResponse(
      JSON.stringify({
        ...goodExtraction,
        confidence: 0.5,
        clarificationQuestion: 'Which URLs should I watch?',
      }),
    )) as typeof globalThis.fetch;

  const parser = createGigParser({ apiKey: 'test-key', logger: silentLogger });
  const result = await parser.parse(makeGig(), 'contract-1');

  assert.equal(result.needsClarification, true);
  assert.equal(result.clarificationQuestion, 'Which URLs should I watch?');
});

test('throws when Claude returns no text content', async () => {
  globalThis.fetch = (async () => emptyResponse()) as typeof globalThis.fetch;
  const parser = createGigParser({ apiKey: 'test-key', logger: silentLogger });
  await assert.rejects(() => parser.parse(makeGig(), 'contract-1'), /no text content/);
});

test('throws when Claude returns invalid JSON', async () => {
  globalThis.fetch = (async () => messageResponse('not json at all {')) as typeof globalThis.fetch;
  const parser = createGigParser({ apiKey: 'test-key', logger: silentLogger });
  await assert.rejects(() => parser.parse(makeGig(), 'contract-1'), /JSON parse failed/);
});
