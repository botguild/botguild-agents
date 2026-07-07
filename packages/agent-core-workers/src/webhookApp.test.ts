import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createWorkersWebhookApp, type WebhookEvent, type WebhookHandler } from './webhookApp.js';
import { createConsoleLogger } from './logger.js';

const silentLogger = createConsoleLogger({ service: 'test', level: 'silent' });
const SECRET = 'test-secret';

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function makeApp(handlers: Record<string, WebhookHandler>, secret: WorkersSecret = SECRET) {
  return createWorkersWebhookApp({
    secret,
    botId: 'bot_1',
    logger: silentLogger,
    handlers,
  });
}
type WorkersSecret = string | (() => string | Promise<string>);

function post(app: ReturnType<typeof makeApp>, body: string, headers: Record<string, string>) {
  return app.request('/webhook', { method: 'POST', body, headers });
}

test('valid signature + known event invokes the handler and returns 200', async () => {
  const body = JSON.stringify({
    event: 'proposal.accepted',
    timestamp: '2026-07-06T10:00:00Z',
    data: { contractId: 'c_1', proposalId: 'p_1' },
  });
  let received: WebhookEvent | undefined;
  const app = makeApp({
    'proposal.accepted': async (event) => {
      received = event;
    },
  });

  const res = await post(app, body, {
    'X-BotGuild-Signature': sign(body),
    'X-BotGuild-Delivery': 'd_99',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
  assert.equal(received?.eventType, 'proposal.accepted');
  assert.equal(received?.timestamp, '2026-07-06T10:00:00Z');
  assert.equal(received?.deliveryId, 'd_99');
  assert.deepEqual(received?.payload, { contractId: 'c_1', proposalId: 'p_1' });
});

test('missing signature returns 401 and does not invoke handler', async () => {
  const body = JSON.stringify({ event: 'proposal.accepted', data: {} });
  let invoked = false;
  const app = makeApp({
    'proposal.accepted': async () => {
      invoked = true;
    },
  });

  const res = await post(app, body, {});
  assert.equal(res.status, 401);
  assert.equal(invoked, false);
});

test('wrong signature returns 401', async () => {
  const body = JSON.stringify({ event: 'proposal.accepted', data: {} });
  const app = makeApp({ 'proposal.accepted': async () => {} });

  const res = await post(app, body, { 'X-BotGuild-Signature': 'sha256=' + 'a'.repeat(64) });
  assert.equal(res.status, 401);
});

test('bare-hex signature (no sha256= prefix) still verifies, like agent-core', async () => {
  const body = JSON.stringify({ event: 'proposal.accepted', data: {} });
  let invoked = false;
  const app = makeApp({
    'proposal.accepted': async () => {
      invoked = true;
    },
  });

  const res = await post(app, body, {
    'X-BotGuild-Signature': createHmac('sha256', SECRET).update(body).digest('hex'),
  });
  assert.equal(res.status, 200);
  assert.equal(invoked, true);
});

test('malformed JSON returns 400, not silent 200', async () => {
  const body = 'not-json';
  const app = makeApp({});
  const res = await post(app, body, { 'X-BotGuild-Signature': sign(body) });
  assert.equal(res.status, 400);
});

test('missing event field returns 400', async () => {
  const body = JSON.stringify({ timestamp: 'now', data: {} });
  const app = makeApp({});
  const res = await post(app, body, { 'X-BotGuild-Signature': sign(body) });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Missing event field' });
});

test('unknown event type returns 200 with handler not invoked', async () => {
  const body = JSON.stringify({ event: 'milestone.something_unknown', data: {} });
  let invoked = false;
  const app = makeApp({
    'proposal.accepted': async () => {
      invoked = true;
    },
  });

  const res = await post(app, body, { 'X-BotGuild-Signature': sign(body) });
  assert.equal(res.status, 200);
  assert.equal(invoked, false);
});

test('handler throwing returns 500 so the platform redelivers', async () => {
  const body = JSON.stringify({ event: 'milestone.funded', data: {} });
  const app = makeApp({
    'milestone.funded': async () => {
      throw new Error('boom');
    },
  });

  const res = await post(app, body, { 'X-BotGuild-Signature': sign(body) });
  assert.equal(res.status, 500);
});

test('async secret getter resolves per request (the D1-loaded secret form)', async () => {
  const body = JSON.stringify({ event: 'proposal.accepted', data: {} });
  let invoked = false;
  const app = makeApp(
    {
      'proposal.accepted': async () => {
        invoked = true;
      },
    },
    async () => SECRET,
  );

  const res = await post(app, body, { 'X-BotGuild-Signature': sign(body) });
  assert.equal(res.status, 200);
  assert.equal(invoked, true);
});

test('empty secret (not yet captured) returns 503 so the platform retries', async () => {
  const body = JSON.stringify({ event: 'proposal.accepted', data: {} });
  const app = makeApp({ 'proposal.accepted': async () => {} }, () => '');

  const res = await post(app, body, { 'X-BotGuild-Signature': sign(body) });
  assert.equal(res.status, 503);
});

test('secret getter throwing returns 503, never a crash', async () => {
  const body = JSON.stringify({ event: 'proposal.accepted', data: {} });
  const app = makeApp({ 'proposal.accepted': async () => {} }, async () => {
    throw new Error('D1 unavailable');
  });

  const res = await post(app, body, { 'X-BotGuild-Signature': sign(body) });
  assert.equal(res.status, 503);
});

test('GET /health returns status + botId with extra fields merged underneath', async () => {
  const app = createWorkersWebhookApp({
    secret: SECRET,
    botId: 'bot_1',
    logger: silentLogger,
    handlers: {},
    healthExtra: async () => ({ reputationScore: 87, status: 'clobber-attempt' }),
  });

  const res = await app.request('/health');
  assert.equal(res.status, 200);
  const health = (await res.json()) as Record<string, unknown>;
  assert.equal(health['status'], 'ok', 'core fields always win over extras');
  assert.equal(health['botId'], 'bot_1');
  assert.equal(health['reputationScore'], 87);
});

test('GET /health never 500s when the extra provider throws', async () => {
  const app = createWorkersWebhookApp({
    secret: SECRET,
    botId: 'bot_1',
    logger: silentLogger,
    handlers: {},
    healthExtra: () => {
      throw new Error('cache read failed');
    },
  });

  const res = await app.request('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', botId: 'bot_1' });
});
