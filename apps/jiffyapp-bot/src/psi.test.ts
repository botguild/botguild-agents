import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { createPsiClient } from './psi.js';

const silentLogger = pino({ level: 'silent' });

function lighthouseBody(performance: number, accessibility: number) {
  return {
    lighthouseResult: {
      categories: {
        performance: { score: performance },
        accessibility: { score: accessibility },
      },
      audits: { 'first-contentful-paint': { numericValue: 1200 } },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

/** Replays canned Response/throw results in order — one entry per expected fetchImpl call. */
function queueFetch(...items: Array<Response | { throw: Error }>): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const item = items[Math.min(i, items.length - 1)];
    i += 1;
    if (item && typeof item === 'object' && 'throw' in item) {
      throw (item as { throw: Error }).throw;
    }
    return item as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function sleepSpy(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    },
  };
}

test('successful run extracts rounded scores and retains raw lighthouseResult', async () => {
  const { fetchImpl, calls } = queueFetch(jsonResponse(lighthouseBody(0.955, 0.978)));
  const { sleep } = sleepSpy();
  const client = createPsiClient({ apiKey: 'psi-key', fetchImpl, sleep, logger: silentLogger });

  const result = await client.run('https://example.jiffyapp.dev/');

  assert.equal(calls.length, 1);
  const url = calls[0];
  assert.match(url, /^https:\/\/www\.googleapis\.com\/pagespeedonline\/v5\/runPagespeed\?/);
  assert.ok(url.includes(`url=${encodeURIComponent('https://example.jiffyapp.dev/')}`));
  assert.ok(url.includes('key=psi-key'));
  assert.ok(url.includes('category=PERFORMANCE'));
  assert.ok(url.includes('category=ACCESSIBILITY'));
  assert.ok(url.includes('strategy=mobile'));

  assert.equal(result.ok, true);
  assert.equal(result.performance, 96);
  assert.equal(result.accessibility, 98);
  assert.deepEqual(result.raw, lighthouseBody(0.955, 0.978).lighthouseResult);
});

test('500 then 200 retries exactly once (sleep spy records the backoff)', async () => {
  const { fetchImpl, calls } = queueFetch(
    textResponse('server error', 500),
    jsonResponse(lighthouseBody(0.8, 0.9)),
  );
  const { sleep, calls: sleepCalls } = sleepSpy();
  const client = createPsiClient({ apiKey: 'k', fetchImpl, sleep, logger: silentLogger });

  const result = await client.run('https://example.jiffyapp.dev/');

  assert.equal(calls.length, 2);
  assert.deepEqual(sleepCalls, [1000]);
  assert.equal(result.ok, true);
  assert.equal(result.performance, 80);
  assert.equal(result.accessibility, 90);
});

test('double 5xx fails ok:false after the single retry', async () => {
  const { fetchImpl, calls } = queueFetch(
    textResponse('server error', 500),
    textResponse('still broken', 502),
  );
  const { sleep, calls: sleepCalls } = sleepSpy();
  const client = createPsiClient({ apiKey: 'k', fetchImpl, sleep, logger: silentLogger });

  const result = await client.run('https://example.jiffyapp.dev/');

  assert.equal(calls.length, 2);
  assert.equal(sleepCalls.length, 1);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error?.includes('502'));
});

test('network throw then 200 succeeds (retry absorbs the transient failure)', async () => {
  const { fetchImpl, calls } = queueFetch(
    { throw: new Error('connect timeout') },
    jsonResponse(lighthouseBody(0.7, 0.85)),
  );
  const { sleep, calls: sleepCalls } = sleepSpy();
  const client = createPsiClient({ apiKey: 'k', fetchImpl, sleep, logger: silentLogger });

  const result = await client.run('https://example.jiffyapp.dev/');

  assert.equal(calls.length, 2);
  assert.equal(sleepCalls.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.performance, 70);
});

test('double network throw fails ok:false', async () => {
  const { fetchImpl } = queueFetch(
    { throw: new Error('dns failure') },
    { throw: new Error('dns failure again') },
  );
  const client = createPsiClient({
    apiKey: 'k',
    fetchImpl,
    sleep: async () => {},
    logger: silentLogger,
  });

  const result = await client.run('https://example.jiffyapp.dev/');

  assert.equal(result.ok, false);
});

test('a 4xx response fails immediately with no retry', async () => {
  const { fetchImpl, calls } = queueFetch(textResponse('bad request', 400));
  const client = createPsiClient({
    apiKey: 'k',
    fetchImpl,
    sleep: async () => {},
    logger: silentLogger,
  });

  const result = await client.run('https://example.jiffyapp.dev/');

  assert.equal(calls.length, 1);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error?.includes('400'));
});

test('missing accessibility category in the response fails ok:false', async () => {
  const { fetchImpl } = queueFetch(
    jsonResponse({
      lighthouseResult: {
        categories: { performance: { score: 0.9 } },
      },
    }),
  );
  const client = createPsiClient({
    apiKey: 'k',
    fetchImpl,
    sleep: async () => {},
    logger: silentLogger,
  });

  const result = await client.run('https://example.jiffyapp.dev/');

  assert.equal(result.ok, false);
});

test('unparseable JSON body fails ok:false', async () => {
  const { fetchImpl } = queueFetch(textResponse('not json', 200));
  const client = createPsiClient({
    apiKey: 'k',
    fetchImpl,
    sleep: async () => {},
    logger: silentLogger,
  });

  const result = await client.run('https://example.jiffyapp.dev/');

  assert.equal(result.ok, false);
});
