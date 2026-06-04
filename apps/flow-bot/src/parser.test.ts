import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import type { Gig } from '@botguild/agent-core';
import { createGigParser } from './parser.js';

// Stub global fetch (the Anthropic SDK's transport) to drive each branch with
// canned extractions — no network.
const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: 'gig-1',
    title: 'Clean my CSV',
    description: 'Normalize and dedupe.',
    category: 'Ops & Automation',
    budget: 200,
    acceptanceCriteria: [{ kind: 'text', text: 'no duplicate ids' }],
    ...overrides,
  } as Gig;
}

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
  inputType: 'csv',
  inputSource: 'https://example.com/data.csv',
  targetSchema: [{ name: 'id', type: 'number' }],
  transformRules: { dedupKey: 'id', requiredFields: ['id'] },
  outputFormat: 'json',
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

test('parses a high-confidence extraction into a TransformJobConfig, passing milestoneIds through', async () => {
  globalThis.fetch = (async () =>
    messageResponse(JSON.stringify(goodExtraction))) as typeof globalThis.fetch;

  const parser = createGigParser({ apiKey: 'test-key', logger: silentLogger });
  const result = await parser.parse(makeGig(), 'contract-1', ['ms-1', 'ms-2', 'ms-3']);

  assert.equal(result.needsClarification, false);
  assert.equal(result.clarificationQuestion, undefined);
  assert.equal(result.config.inputType, 'csv');
  assert.equal(result.config.inputSource, 'https://example.com/data.csv');
  assert.equal(result.config.outputFormat, 'json');
  assert.equal(result.config.transformRules.dedupKey, 'id');
  assert.equal(result.config.gigId, 'gig-1');
  assert.equal(result.config.contractId, 'contract-1');
  assert.deepEqual(result.config.milestoneIds, ['ms-1', 'ms-2', 'ms-3']);
});

test('flags clarification with the question when confidence is below threshold', async () => {
  globalThis.fetch = (async () =>
    messageResponse(
      JSON.stringify({
        ...goodExtraction,
        confidence: 0.4,
        clarificationQuestion: 'What is the target schema?',
      }),
    )) as typeof globalThis.fetch;

  const parser = createGigParser({ apiKey: 'test-key', logger: silentLogger });
  const result = await parser.parse(makeGig(), 'contract-1', []);

  assert.equal(result.needsClarification, true);
  assert.equal(result.clarificationQuestion, 'What is the target schema?');
});

test('throws when Claude returns no text content', async () => {
  globalThis.fetch = (async () => emptyResponse()) as typeof globalThis.fetch;
  const parser = createGigParser({ apiKey: 'test-key', logger: silentLogger });
  await assert.rejects(() => parser.parse(makeGig(), 'contract-1', []), /no text content/);
});

test('throws when Claude returns invalid JSON', async () => {
  globalThis.fetch = (async () => messageResponse('}{ not json')) as typeof globalThis.fetch;
  const parser = createGigParser({ apiKey: 'test-key', logger: silentLogger });
  await assert.rejects(() => parser.parse(makeGig(), 'contract-1', []), /JSON parse failed/);
});
