import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import { createAlerter } from './alerting.js';

// A logger that records warn() calls so we can assert the failure paths log
// without throwing.
function recordingLogger() {
  const warns: unknown[][] = [];
  const logger = {
    warn: (...args: unknown[]) => warns.push(args),
    info() {},
    error() {},
    debug() {},
  } as unknown as Logger;
  return { logger, warns };
}

// Captures Telegram calls (url + parsed body) instead of hitting the network.
function captureFetch() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
    });
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return calls;
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('sendStartupAlert posts to the Telegram bot endpoint with chat id and text', async () => {
  const calls = captureFetch();
  const { logger } = recordingLogger();

  const alerter = createAlerter({ botToken: 'TOKEN', chatId: 'CHAT', logger });
  await alerter.sendStartupAlert('SentinelBot', 'bot-123');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/botTOKEN/sendMessage');
  assert.equal(calls[0].body.chat_id, 'CHAT');
  assert.match(String(calls[0].body.text), /SentinelBot/);
  assert.match(String(calls[0].body.text), /bot-123/);
});

test('sendFatalAlert includes the error message', async () => {
  const calls = captureFetch();
  const { logger } = recordingLogger();

  const alerter = createAlerter({ botToken: 'TOKEN', chatId: 'CHAT', logger });
  await alerter.sendFatalAlert('FlowBot', 'bot-9', 'disk full');

  assert.equal(calls.length, 1);
  assert.match(String(calls[0].body.text), /disk full/);
  assert.match(String(calls[0].body.text), /FlowBot/);
});

test('sendDisputeAlert includes the contract id and the reason when given', async () => {
  const calls = captureFetch();
  const { logger } = recordingLogger();

  const alerter = createAlerter({ botToken: 'TOKEN', chatId: 'CHAT', logger });
  await alerter.sendDisputeAlert('VerifierBot', 'contract-7', 'criteria not met');

  assert.match(String(calls[0].body.text), /contract-7/);
  assert.match(String(calls[0].body.text), /criteria not met/);
});

test('sendDisputeAlert omits the reason clause when no reason is given', async () => {
  const calls = captureFetch();
  const { logger } = recordingLogger();

  const alerter = createAlerter({ botToken: 'TOKEN', chatId: 'CHAT', logger });
  await alerter.sendDisputeAlert('VerifierBot', 'contract-7');

  const text = String(calls[0].body.text);
  assert.match(text, /contract-7/);
  assert.doesNotMatch(text, / — /, 'no trailing reason clause');
});

test('no-ops (no fetch) when botToken or chatId is missing', async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}');
  }) as typeof globalThis.fetch;
  const { logger } = recordingLogger();

  await createAlerter({ botToken: '', chatId: 'CHAT', logger }).sendStartupAlert('Bot', 'id');
  await createAlerter({ botToken: 'TOKEN', chatId: '', logger }).sendFatalAlert('Bot', 'id', 'err');

  assert.equal(called, false, 'fetch must not be called without credentials');
});

test('swallows a network error and logs a warning instead of throwing', async () => {
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof globalThis.fetch;
  const { logger, warns } = recordingLogger();

  const alerter = createAlerter({ botToken: 'TOKEN', chatId: 'CHAT', logger });
  await assert.doesNotReject(() => alerter.sendStartupAlert('Bot', 'id'));
  assert.equal(warns.length, 1);
});

test('logs a warning on a non-ok Telegram response', async () => {
  globalThis.fetch = (async () =>
    new Response('forbidden', { status: 403 })) as typeof globalThis.fetch;
  const { logger, warns } = recordingLogger();

  const alerter = createAlerter({ botToken: 'TOKEN', chatId: 'CHAT', logger });
  await alerter.sendFatalAlert('Bot', 'id', 'boom');

  assert.equal(warns.length, 1);
  assert.equal((warns[0][0] as { status: number }).status, 403);
});
