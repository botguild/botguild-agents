import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { ensureWebhookRegistered } from './webhookregistration.js';
import type { AgentClient, WebhookRegistration } from './client.js';

const silentLogger = pino({ level: 'silent' });

interface StubCalls {
  list: number;
  register: Array<{ url: string; events: string[]; secret: string }>;
  delete: string[];
}

interface StubBehavior {
  listResponse?: WebhookRegistration[];
  deleteThrows?: boolean;
  registerResponse?: (url: string, events: string[], secret: string) => WebhookRegistration;
}

function stubClient(behavior: StubBehavior = {}): { client: AgentClient; calls: StubCalls } {
  const calls: StubCalls = { list: 0, register: [], delete: [] };
  const client = {
    listWebhooks: async () => {
      calls.list++;
      return behavior.listResponse ?? [];
    },
    registerWebhook: async (url: string, events: string[], secret: string) => {
      calls.register.push({ url, events, secret });
      const defaultResp: WebhookRegistration = {
        id: 'wh_new_' + calls.register.length,
        botId: 'bot_x',
        url,
        secret: 'whsec_platform_generated_' + calls.register.length,
        events,
        createdAt: new Date().toISOString(),
      };
      return behavior.registerResponse?.(url, events, secret) ?? defaultResp;
    },
    deleteWebhook: async (id: string) => {
      calls.delete.push(id);
      if (behavior.deleteThrows) throw new Error('platform DELETE 500');
    },
  } as unknown as AgentClient;
  return { client, calls };
}

const baseConfig = {
  webhookBaseUrl: 'https://bot.example.com',
  webhookSecret: 'env_var_secret_ignored_by_platform',
  events: ['proposal.accepted', 'milestone.funded'],
  logger: silentLogger,
};

test('no existing webhook → POST and captures secret', async () => {
  const { client, calls } = stubClient({ listResponse: [] });
  const captured: Array<{ secret: string; webhookId: string }> = [];

  await ensureWebhookRegistered({
    ...baseConfig,
    client,
    onSecretCaptured: (secret, webhookId) => captured.push({ secret, webhookId }),
  });

  assert.equal(calls.list, 1);
  assert.equal(calls.register.length, 1);
  assert.equal(calls.delete.length, 0);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.secret, 'whsec_platform_generated_1');
});

test('hasStoredSecret=true + events match existing → NOOP, no POST', async () => {
  const existing: WebhookRegistration = {
    id: 'wh_existing',
    botId: 'bot_x',
    url: 'https://bot.example.com/webhook',
    secret: '', // platform GET omits this
    events: ['proposal.accepted', 'milestone.funded'],
    createdAt: new Date().toISOString(),
  };
  const { client, calls } = stubClient({ listResponse: [existing] });
  const captured: Array<{ secret: string; webhookId: string }> = [];

  await ensureWebhookRegistered({
    ...baseConfig,
    client,
    hasStoredSecret: true,
    onSecretCaptured: (secret, webhookId) => captured.push({ secret, webhookId }),
  });

  assert.equal(calls.register.length, 0, 'must not POST a new webhook');
  assert.equal(calls.delete.length, 0, 'must not delete the existing webhook');
  assert.equal(captured.length, 0, 'onSecretCaptured must not fire');
});

test('hasStoredSecret=false + events match → forces POST to capture secret', async () => {
  const existing: WebhookRegistration = {
    id: 'wh_existing',
    botId: 'bot_x',
    url: 'https://bot.example.com/webhook',
    secret: '',
    events: ['proposal.accepted', 'milestone.funded'],
    createdAt: new Date().toISOString(),
  };
  const { client, calls } = stubClient({ listResponse: [existing] });
  const captured: Array<{ secret: string; webhookId: string }> = [];

  await ensureWebhookRegistered({
    ...baseConfig,
    client,
    hasStoredSecret: false,
    onSecretCaptured: (secret, webhookId) => captured.push({ secret, webhookId }),
  });

  assert.equal(calls.register.length, 1, 'must POST to capture a fresh secret');
  assert.equal(calls.delete.length, 1, 'attempts to delete the stale registration');
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.secret, 'whsec_platform_generated_1');
});

test('events differ from existing → re-registers and captures secret', async () => {
  const existing: WebhookRegistration = {
    id: 'wh_existing',
    botId: 'bot_x',
    url: 'https://bot.example.com/webhook',
    secret: '',
    events: ['old.event_name'],
    createdAt: new Date().toISOString(),
  };
  const { client, calls } = stubClient({ listResponse: [existing] });
  const captured: Array<{ secret: string; webhookId: string }> = [];

  await ensureWebhookRegistered({
    ...baseConfig,
    client,
    hasStoredSecret: true,
    onSecretCaptured: (secret, webhookId) => captured.push({ secret, webhookId }),
  });

  assert.equal(calls.register.length, 1);
  assert.equal(calls.register[0]!.events.length, 2);
  assert.equal(captured.length, 1, 'captures the new secret on re-register');
});

test('delete failure does NOT block re-registration', async () => {
  const existing: WebhookRegistration = {
    id: 'wh_existing',
    botId: 'bot_x',
    url: 'https://bot.example.com/webhook',
    secret: '',
    events: ['old.event_name'],
    createdAt: new Date().toISOString(),
  };
  const { client, calls } = stubClient({ listResponse: [existing], deleteThrows: true });
  const captured: Array<{ secret: string; webhookId: string }> = [];

  // Must not throw, even though platform DELETE 500s
  await ensureWebhookRegistered({
    ...baseConfig,
    client,
    hasStoredSecret: false,
    onSecretCaptured: (secret, webhookId) => captured.push({ secret, webhookId }),
  });

  assert.equal(calls.delete.length, 1, 'attempts the delete');
  assert.equal(calls.register.length, 1, 'still posts even when delete fails');
  assert.equal(captured.length, 1);
});

test('onSecretCaptured does not fire when platform returns empty secret', async () => {
  const { client, calls } = stubClient({
    listResponse: [],
    registerResponse: (url, events) => ({
      id: 'wh_no_secret',
      botId: 'bot_x',
      url,
      secret: '',
      events,
      createdAt: new Date().toISOString(),
    }),
  });
  const captured: Array<{ secret: string; webhookId: string }> = [];

  await ensureWebhookRegistered({
    ...baseConfig,
    client,
    onSecretCaptured: (secret, webhookId) => captured.push({ secret, webhookId }),
  });

  assert.equal(calls.register.length, 1);
  assert.equal(captured.length, 0, 'must not fire onSecretCaptured for empty secret');
});

test('onSecretCaptured throwing does not block registration', async () => {
  const { client, calls } = stubClient({ listResponse: [] });

  // Must not throw — even if the persistence callback fails (e.g., volume full)
  // we want webhook registration itself to succeed.
  await ensureWebhookRegistered({
    ...baseConfig,
    client,
    onSecretCaptured: () => {
      throw new Error('disk full');
    },
  });

  assert.equal(calls.register.length, 1, 'POST happened despite callback throw');
});

test('duplicate webhooks: keeps newest, attempts to delete others', async () => {
  const olderDate = new Date(Date.now() - 86400_000).toISOString();
  const newerDate = new Date().toISOString();
  const listing: WebhookRegistration[] = [
    {
      id: 'wh_older',
      botId: 'bot_x',
      url: 'https://bot.example.com/webhook',
      secret: '',
      events: ['proposal.accepted', 'milestone.funded'],
      createdAt: olderDate,
    },
    {
      id: 'wh_newer',
      botId: 'bot_x',
      url: 'https://bot.example.com/webhook',
      secret: '',
      events: ['proposal.accepted', 'milestone.funded'],
      createdAt: newerDate,
    },
  ];
  const { client, calls } = stubClient({ listResponse: listing });

  await ensureWebhookRegistered({
    ...baseConfig,
    client,
    hasStoredSecret: true,
  });

  // newer should be kept; older should be deleted
  assert.equal(calls.delete.length, 1);
  assert.equal(calls.delete[0], 'wh_older');
  assert.equal(calls.register.length, 0, 'newer matches events, no POST');
});
