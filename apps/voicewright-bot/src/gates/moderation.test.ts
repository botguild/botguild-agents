import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODERATION_MODEL, createModerationClient } from './moderation.js';

// Stubbed fetch only — these tests must never call the live API.
const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch;
}

test('clean verdict: pass with the full response snapshotted', async () => {
  let requestBody: { model?: string; input?: string } = {};
  const vendorBody = {
    id: 'modr-1',
    model: MODERATION_MODEL,
    results: [{ flagged: false, categories: { hate: false }, category_scores: { hate: 0.0001 } }],
  };
  const client = createModerationClient({
    apiKey: 'test-key',
    now: () => new Date('2026-07-06T00:00:00Z'),
    fetchImpl: stubFetch((url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/moderations');
      assert.equal((init.headers as Record<string, string>)['Authorization'], 'Bearer test-key');
      requestBody = JSON.parse(String(init.body)) as typeof requestBody;
      return jsonResponse(200, vendorBody);
    }),
  });

  const outcome = await client.moderate('friendly ad copy');
  assert.equal(requestBody.model, MODERATION_MODEL); // pinned model on the wire
  assert.equal(requestBody.input, 'friendly ad copy');
  assert.ok(outcome.ok);
  assert.equal(outcome.verdict.flagged, false);
  assert.equal(outcome.verdict.vendor, 'openai');
  assert.equal(outcome.verdict.model, MODERATION_MODEL);
  assert.deepEqual(outcome.verdict.response, vendorBody); // full snapshot
  assert.equal(outcome.verdict.checkedAt, '2026-07-06T00:00:00.000Z');
});

test('flagged verdict comes back ok:true with flagged:true (a verdict, not an outage)', async () => {
  const client = createModerationClient({
    apiKey: 'k',
    fetchImpl: stubFetch(() => jsonResponse(200, { model: MODERATION_MODEL, results: [{ flagged: true }] })),
  });
  const outcome = await client.moderate('bad copy');
  assert.ok(outcome.ok);
  assert.equal(outcome.verdict.flagged, true);
});

test('429 fails CLOSED as an outage', async () => {
  const client = createModerationClient({
    apiKey: 'k',
    fetchImpl: stubFetch(() => jsonResponse(429, { error: 'rate limited' })),
  });
  const outcome = await client.moderate('copy');
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.kind === 'outage');
});

test('network failure fails CLOSED as an outage', async () => {
  const client = createModerationClient({
    apiKey: 'k',
    fetchImpl: (async () => {
      throw new Error('connect timeout');
    }) as typeof fetch,
  });
  const outcome = await client.moderate('copy');
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.detail.includes('connect timeout'));
});

test('malformed vendor response (no results) fails CLOSED', async () => {
  const client = createModerationClient({
    apiKey: 'k',
    fetchImpl: stubFetch(() => jsonResponse(200, { model: MODERATION_MODEL })),
  });
  const outcome = await client.moderate('copy');
  assert.equal(outcome.ok, false);
});
