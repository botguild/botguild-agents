import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import type { Gig } from '@botguild/agent-core';
import { createGigParser } from './parser.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: 'gig-1',
    title: 'Verify my API',
    description: 'Check status and latency.',
    category: 'Testing & QA',
    budget: 200,
    acceptanceCriteria: ['returns 200', 'responds under 1s'],
    ...overrides,
  } as Gig;
}

function messageResponse(text: string): Response {
  const body = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
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
    model: 'claude-sonnet-4-6',
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
  checkType: 'api-contract',
  targets: ['https://api.example.com/health'],
  criteriaList: [
    { id: 'status-200', description: 'returns 200', expected: 'status 200', checkMethod: 'http' },
  ],
  evidenceRequired: { screenshot: false, responseLog: true, sampleRows: false },
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

test('parses a high-confidence extraction into a CheckPlan, passing milestoneIds through', async () => {
  globalThis.fetch = (async () =>
    messageResponse(JSON.stringify(goodExtraction))) as typeof globalThis.fetch;

  const parser = createGigParser({ apiKey: 'test-key', logger: silentLogger });
  const result = await parser.parse(makeGig(), 'contract-1', ['ms-1', 'ms-2']);

  assert.equal(result.needsClarification, false);
  assert.equal(result.clarificationQuestion, undefined);
  assert.equal(result.plan.checkType, 'api-contract');
  assert.deepEqual(result.plan.targets, ['https://api.example.com/health']);
  assert.equal(result.plan.criteriaList.length, 1);
  assert.equal(result.plan.evidenceRequired.responseLog, true);
  assert.equal(result.plan.gigId, 'gig-1');
  assert.equal(result.plan.contractId, 'contract-1');
  assert.deepEqual(result.plan.milestoneIds, ['ms-1', 'ms-2']);
});

test('flags clarification with the question when confidence is below threshold', async () => {
  globalThis.fetch = (async () =>
    messageResponse(
      JSON.stringify({
        ...goodExtraction,
        confidence: 0.4,
        clarificationQuestion: 'Which endpoints should I check?',
      }),
    )) as typeof globalThis.fetch;

  const parser = createGigParser({ apiKey: 'test-key', logger: silentLogger });
  const result = await parser.parse(makeGig(), 'contract-1', []);

  assert.equal(result.needsClarification, true);
  assert.equal(result.clarificationQuestion, 'Which endpoints should I check?');
});

test('throws when Claude returns no text content', async () => {
  globalThis.fetch = (async () => emptyResponse()) as typeof globalThis.fetch;
  const parser = createGigParser({ apiKey: 'test-key', logger: silentLogger });
  await assert.rejects(() => parser.parse(makeGig(), 'contract-1', []), /no text content/);
});

test('throws when Claude returns invalid JSON', async () => {
  globalThis.fetch = (async () => messageResponse('not json {')) as typeof globalThis.fetch;
  const parser = createGigParser({ apiKey: 'test-key', logger: silentLogger });
  await assert.rejects(() => parser.parse(makeGig(), 'contract-1', []), /JSON parse failed/);
});
