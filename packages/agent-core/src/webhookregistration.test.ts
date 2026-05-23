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

function makeWebhook(id: string, events: string[]): WebhookRegistration {
  // createdAt intentionally omitted — mirrors the real platform response
  // (it returns created_at, so the camelCase field is absent). Selection
  // must NOT depend on this field.
  return {
    id,
    botId: 'bot_x',
    url: 'https://bot.example.com/webhook',
    secret: '', // platform GET omits this
    events,
  };
}

test('owned webhook (knownWebhookId) with matching events → keep, no POST', async () => {
  const existing = makeWebhook('wh_owned', ['proposal.accepted', 'milestone.funded']);
  const { client, calls } = stubClient({ listResponse: [existing] });
  const captured: Array<{ secret: string; webhookId: string }> = [];

  const result = await ensureWebhookRegistered({
    ...baseConfig,
    client,
    hasStoredSecret: true,
    knownWebhookId: 'wh_owned',
    onSecretCaptured: (secret, webhookId) => captured.push({ secret, webhookId }),
  });

  assert.equal(calls.register.length, 0, 'must not POST a new webhook');
  assert.equal(calls.delete.length, 0, 'nothing else to delete');
  assert.equal(captured.length, 0, 'onSecretCaptured must not fire');
  assert.equal(result.id, 'wh_owned');
});

test('owned webhook present but events differ → register fresh + delete the stale one', async () => {
  const existing = makeWebhook('wh_owned', ['old.event_name']);
  const { client, calls } = stubClient({ listResponse: [existing] });
  const captured: Array<{ secret: string; webhookId: string }> = [];

  await ensureWebhookRegistered({
    ...baseConfig,
    client,
    hasStoredSecret: true,
    knownWebhookId: 'wh_owned',
    onSecretCaptured: (secret, webhookId) => captured.push({ secret, webhookId }),
  });

  assert.equal(calls.register.length, 1, 'events differ → must re-register');
  assert.equal(calls.register[0]!.events.length, 2);
  assert.deepEqual(calls.delete, ['wh_owned'], 'deletes the stale registration');
  assert.equal(captured.length, 1);
});

test('knownWebhookId not in the list (webhook gone) → register fresh', async () => {
  const stranger = makeWebhook('wh_other', ['proposal.accepted', 'milestone.funded']);
  const { client, calls } = stubClient({ listResponse: [stranger] });

  await ensureWebhookRegistered({
    ...baseConfig,
    client,
    hasStoredSecret: true,
    knownWebhookId: 'wh_gone',
  });

  assert.equal(calls.register.length, 1, 'our webhook is gone → register fresh');
  assert.deepEqual(calls.delete, ['wh_other'], 'deletes the stranger we do not own');
});

test('hasStoredSecret=false → forces POST even if events match', async () => {
  const existing = makeWebhook('wh_existing', ['proposal.accepted', 'milestone.funded']);
  const { client, calls } = stubClient({ listResponse: [existing] });
  const captured: Array<{ secret: string; webhookId: string }> = [];

  await ensureWebhookRegistered({
    ...baseConfig,
    client,
    hasStoredSecret: false,
    knownWebhookId: 'wh_existing',
    onSecretCaptured: (secret, webhookId) => captured.push({ secret, webhookId }),
  });

  assert.equal(calls.register.length, 1, 'no stored secret → must POST to capture one');
  assert.deepEqual(calls.delete, ['wh_existing']);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.secret, 'whsec_platform_generated_1');
});

test('REGRESSION: never keeps a stale webhook just because createdAt is undefined', async () => {
  // The bug: createdAt-undefined made the sort a no-op, so the OLDEST
  // stale-event webhook was kept and re-registered forever. With keeper
  // selection by id+events (not time), an unmatched/unknown webhook is
  // always replaced, never kept.
  const stale = makeWebhook('wh_zombie', ['gig.created', 'contract.created', 'message.created']);
  const { client, calls } = stubClient({ listResponse: [stale] });

  const result = await ensureWebhookRegistered({
    ...baseConfig,
    client,
    hasStoredSecret: true,
    knownWebhookId: 'wh_zombie', // even if we "own" it, events don't match
  });

  assert.notEqual(result.id, 'wh_zombie', 'must not keep the stale-event webhook');
  assert.equal(calls.register.length, 1);
  assert.deepEqual(calls.delete, ['wh_zombie']);
});

test('delete failure does NOT block registration', async () => {
  const existing = makeWebhook('wh_existing', ['old.event_name']);
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

test('owned webhook with matching events is kept even when hasStoredSecret is omitted', async () => {
  // hasStoredSecret defaults to true; with a matching knownWebhookId the
  // owned webhook is kept (no churn) for callers that don't pass the flag.
  const existing = makeWebhook('wh_owned', ['proposal.accepted', 'milestone.funded']);
  const { client, calls } = stubClient({ listResponse: [existing] });

  await ensureWebhookRegistered({
    ...baseConfig,
    client,
    knownWebhookId: 'wh_owned',
  });

  assert.equal(calls.register.length, 0, 'must not POST when we own a matching webhook');
  assert.equal(calls.delete.length, 0, 'nothing else to delete');
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

test('multiple webhooks: keeps only the owned one, deletes the rest', async () => {
  const events = ['proposal.accepted', 'milestone.funded'];
  const listing = [
    makeWebhook('wh_zombie', ['gig.created']), // stale events
    makeWebhook('wh_owned', events), // the one we own
    makeWebhook('wh_dupe', events), // a duplicate with right events but not ours
  ];
  const { client, calls } = stubClient({ listResponse: listing });

  const result = await ensureWebhookRegistered({
    ...baseConfig,
    client,
    hasStoredSecret: true,
    knownWebhookId: 'wh_owned',
  });

  assert.equal(result.id, 'wh_owned', 'keeps the webhook we own + can verify');
  assert.equal(calls.register.length, 0, 'no POST — we own a matching webhook');
  assert.deepEqual(calls.delete.sort(), ['wh_dupe', 'wh_zombie'], 'deletes all others');
});
