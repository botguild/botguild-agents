import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { registerBot, type BotConfig } from './registration.js';

const silentLogger = pino({ level: 'silent' });

const OWNER = 'C3y1VSaRXWTXt4pmiGaPrBm39d8P4oMv'; // handler the API key authenticates as
const OTHER = 'SdcMueTQx3jn7SM6PGV0r2fFzDsfJqRc'; // a different handler (e.g. pre-migration)

const botConfig: BotConfig = {
  handlerId: 'sentinel-bot',
  name: 'SentinelBot',
  category: 'Ops & Automation',
  bio: 'watches things',
  workingStyle: 'glass-box',
  valueChainPosition: 'monitoring',
  pricingModel: 'fixed',
  toolchain: ['playwright'],
  warrantyTerms: '7-day',
};

interface Recorded {
  method: string;
  url: string;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Route fetch by method+path. `bots` is the global (unfiltered) marketplace
 * list the platform returns for GET /bots regardless of `?name=`.
 */
function stubFetch(bots: Array<{ id: string; name: string; handler_id: string }>): {
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ method, url });

    if (url.endsWith('/handlers/me')) {
      return json({ handler: { id: OWNER, name: 'BotGuild' } });
    }
    if (url.includes('/bots?')) {
      return json({ bots });
    }
    if (method === 'PATCH') {
      const id = url.split('/bots/')[1];
      // Platform only lets us patch bots we own.
      const target = bots.find((b) => b.id === id);
      if (!target || target.handler_id !== OWNER) {
        return json({ error: { message: `Bot '${id}' not found`, code: 'NOT_FOUND' } }, 404);
      }
      return json(target);
    }
    if (method === 'POST') {
      return json({ bot: { id: '01NEWBOTGUILDID', name: botConfig.name, handler_id: OWNER } });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
  return { calls };
}

const baseArgs = {
  apiUrl: 'https://api.botguild.ai',
  apiKey: 'bg_test',
  botConfig,
  logger: silentLogger,
};

test('patches an existing bot owned by the current handler', async () => {
  const { calls } = stubFetch([{ id: '01MINE', name: 'SentinelBot', handler_id: OWNER }]);

  const id = await registerBot(baseArgs);

  assert.equal(id, '01MINE');
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/bots/01MINE')));
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

test('same-named bot owned by a DIFFERENT handler is not patched — creates a fresh profile', async () => {
  // Regression: pre-migration the global list contains a SentinelBot owned by
  // the old handler. Matching by name alone would PATCH it and 404.
  const { calls } = stubFetch([{ id: '01OLD', name: 'SentinelBot', handler_id: OTHER }]);

  const id = await registerBot(baseArgs);

  assert.equal(id, '01NEWBOTGUILDID');
  assert.ok(!calls.some((c) => c.url.includes('/bots/01OLD')), 'must not touch the other handler bot');
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/bots')));
});

test('no matching bot at all → creates a new profile', async () => {
  const { calls } = stubFetch([{ id: '01OTHER', name: 'Printabot', handler_id: OTHER }]);

  const id = await registerBot(baseArgs);

  assert.equal(id, '01NEWBOTGUILDID');
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/bots')));
});
