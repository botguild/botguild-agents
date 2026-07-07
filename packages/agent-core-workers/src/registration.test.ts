import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentClient, BotConfig, WebhookRegistration } from '@botguild/agent-core';
import {
  DISPATCHED_WEBHOOK_EVENTS,
  ensureRegisteredWorkers,
} from './registration.js';
import { createD1WebhookSecretStore } from './webhookSecretStore.js';
import type { D1WebhookSecretStore } from './webhookSecretStore.js';
import { createMemoryD1 } from './testing.js';
import { createConsoleLogger } from './logger.js';

const silentLogger = createConsoleLogger({ service: 'test', level: 'silent' });

const botConfig: BotConfig = {
  handlerId: 'voicewright-bot',
  name: 'VoiceWright',
  category: 'Content Creation',
  bio: 'ad copy',
  workingStyle: 'glass-box',
  valueChainPosition: 'transformer',
  toolchain: ['claude'],
  warrantyTerms: '21-day',
};

// registerBot talks to the platform through global fetch (not AgentClient),
// so stub the three routes it hits — same approach as agent-core's own
// registration tests.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubRegisterBotFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url.endsWith('/handlers/me')) return json({ handler: { id: 'h_owner' } });
    if (url.includes('/bots?')) return json({ bots: [] });
    if (method === 'POST' && url.endsWith('/bots')) return json({ bot: { id: 'bot_new' } });
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
}

interface WebhookCalls {
  register: number;
  deleted: string[];
}

function stubClient(behavior: {
  listed: () => WebhookRegistration[];
  secretForNext?: () => string;
}): { client: AgentClient; calls: WebhookCalls } {
  const calls: WebhookCalls = { register: 0, deleted: [] };
  let counter = 0;
  const client = {
    listWebhooks: async () => behavior.listed(),
    registerWebhook: async (url: string, events: string[]) => {
      calls.register++;
      counter++;
      return {
        id: `wh_${counter}`,
        url,
        events,
        secret: behavior.secretForNext ? behavior.secretForNext() : `whsec_${counter}`,
      } satisfies WebhookRegistration;
    },
    deleteWebhook: async (id: string) => {
      calls.deleted.push(id);
    },
  } as unknown as AgentClient;
  return { client, calls };
}

function makeConfig(client: AgentClient, secretStore: D1WebhookSecretStore) {
  return {
    client,
    registration: {
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botConfig,
      logger: silentLogger,
    },
    webhookBaseUrl: 'https://bot.example.com',
    secretStore,
    logger: silentLogger,
  };
}

test('first run registers bot + webhook and persists the platform-issued secret with read-back', async () => {
  stubRegisterBotFetch();
  const secretStore = createD1WebhookSecretStore(createMemoryD1());
  const { client, calls } = stubClient({ listed: () => [] });

  const result = await ensureRegisteredWorkers(makeConfig(client, secretStore));

  assert.equal(result.botId, 'bot_new');
  assert.equal(result.webhookId, 'wh_1');
  assert.equal(result.secretRotated, true);
  assert.equal(calls.register, 1);

  const stored = await secretStore.loadWebhookSecret();
  assert.equal(stored?.secret, 'whsec_1');
  assert.equal(stored?.webhookId, 'wh_1');
});

test('second run is idempotent: matching stored webhook is kept, nothing re-registered or rewritten', async () => {
  stubRegisterBotFetch();
  const secretStore = createD1WebhookSecretStore(createMemoryD1());
  const listed: WebhookRegistration[] = [];
  const { client, calls } = stubClient({ listed: () => listed });
  const config = makeConfig(client, secretStore);

  const first = await ensureRegisteredWorkers(config);
  // The platform now lists the webhook we registered (GET omits the secret).
  listed.push({
    id: first.webhookId,
    url: 'https://bot.example.com/webhook',
    secret: '',
    events: [...DISPATCHED_WEBHOOK_EVENTS],
  });

  const second = await ensureRegisteredWorkers(config);

  assert.equal(second.webhookId, first.webhookId);
  assert.equal(second.secretRotated, false);
  assert.equal(calls.register, 1, 'no second POST /webhooks');
  assert.deepEqual(calls.deleted, []);
  assert.equal((await secretStore.loadWebhookSecret())?.secret, 'whsec_1', 'secret untouched');
});

test('a lost webhook (stored id no longer listed) forces a fresh POST and rotates the secret', async () => {
  stubRegisterBotFetch();
  const secretStore = createD1WebhookSecretStore(createMemoryD1());
  const { client, calls } = stubClient({ listed: () => [] });
  const config = makeConfig(client, secretStore);

  await ensureRegisteredWorkers(config);
  const result = await ensureRegisteredWorkers(config);

  assert.equal(result.secretRotated, true);
  assert.equal(result.webhookId, 'wh_2');
  assert.equal(calls.register, 2);
  assert.equal((await secretStore.loadWebhookSecret())?.secret, 'whsec_2');
});

test('a persist that does not survive read-back fails the registration loudly', async () => {
  stubRegisterBotFetch();
  // A store whose writes vanish — the failure mode the read-back check exists
  // to catch (a lost secret would silently stop event delivery).
  const droppingStore: D1WebhookSecretStore = {
    loadWebhookSecret: async () => null,
    saveWebhookSecret: async () => {},
  };
  const { client } = stubClient({ listed: () => [] });

  await assert.rejects(
    () => ensureRegisteredWorkers(makeConfig(client, droppingStore)),
    /read-back failed/,
  );
});

test('a kept webhook without a matching stored secret is an error, not a silent success', async () => {
  stubRegisterBotFetch();
  const secretStore = createD1WebhookSecretStore(createMemoryD1());
  // Platform returns a fresh registration with an empty secret — nothing was
  // captured and nothing is stored, so verification would be impossible.
  const { client } = stubClient({ listed: () => [], secretForNext: () => '' });

  await assert.rejects(
    () => ensureRegisteredWorkers(makeConfig(client, secretStore)),
    /no stored secret matches/,
  );
});
