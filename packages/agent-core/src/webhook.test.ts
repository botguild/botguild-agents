import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import pino from 'pino';
import { processWebhookRequest, type WebhookEvent, type WebhookHandler } from './webhook.js';

const silentLogger = pino({ level: 'silent' });
const SECRET = 'test-secret';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

function makeHandlers(handler?: WebhookHandler): Map<string, WebhookHandler> {
  const map = new Map<string, WebhookHandler>();
  if (handler) {
    map.set('proposal.accepted', handler);
  }
  return map;
}

test('valid signature + known event invokes the handler and returns 200', async () => {
  const body = JSON.stringify({
    event: 'proposal.accepted',
    timestamp: '2026-05-23T10:00:00Z',
    data: { contractId: 'c_1', proposalId: 'p_1' },
  });
  let received: WebhookEvent | undefined;
  const handlers = makeHandlers(async (e) => {
    received = e;
  });

  const result = await processWebhookRequest({
    rawBody: body,
    signature: sign(body),
    secret: SECRET,
    deliveryId: 'd_99',
    handlers,
    logger: silentLogger,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { status: 'ok' });
  assert.equal(received?.eventType, 'proposal.accepted');
  assert.equal(received?.timestamp, '2026-05-23T10:00:00Z');
  assert.equal(received?.deliveryId, 'd_99');
  assert.deepEqual(received?.payload, { contractId: 'c_1', proposalId: 'p_1' });
});

test('missing signature returns 401 and does not invoke handler', async () => {
  const body = JSON.stringify({ event: 'proposal.accepted', data: {} });
  let invoked = false;
  const handlers = makeHandlers(async () => {
    invoked = true;
  });

  const result = await processWebhookRequest({
    rawBody: body,
    signature: '',
    secret: SECRET,
    handlers,
    logger: silentLogger,
  });

  assert.equal(result.status, 401);
  assert.equal(invoked, false);
});

test('wrong signature returns 401 (timing-safe compare)', async () => {
  const body = JSON.stringify({ event: 'proposal.accepted', data: {} });
  const handlers = makeHandlers(async () => {});

  const result = await processWebhookRequest({
    rawBody: body,
    signature: 'sha256=' + 'a'.repeat(64),
    secret: SECRET,
    handlers,
    logger: silentLogger,
  });

  assert.equal(result.status, 401);
});

test('malformed JSON returns 400, not silent 200', async () => {
  const body = 'not-json';
  const result = await processWebhookRequest({
    rawBody: body,
    signature: sign(body),
    secret: SECRET,
    handlers: makeHandlers(),
    logger: silentLogger,
  });

  assert.equal(result.status, 400);
});

test('missing event field returns 400, not silent 200', async () => {
  const body = JSON.stringify({ timestamp: 'now', data: {} });
  const result = await processWebhookRequest({
    rawBody: body,
    signature: sign(body),
    secret: SECRET,
    handlers: makeHandlers(),
    logger: silentLogger,
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Missing event field');
});

test('unknown event type returns 200 with handler not invoked', async () => {
  const body = JSON.stringify({ event: 'milestone.something_unknown', data: {} });
  let invoked = false;
  const handlers = makeHandlers(async () => {
    invoked = true;
  });

  const result = await processWebhookRequest({
    rawBody: body,
    signature: sign(body),
    secret: SECRET,
    handlers,
    logger: silentLogger,
  });

  assert.equal(result.status, 200);
  assert.equal(invoked, false);
});

test('handler throwing returns 500', async () => {
  const body = JSON.stringify({ event: 'proposal.accepted', data: {} });
  const handlers = makeHandlers(async () => {
    throw new Error('boom');
  });

  const result = await processWebhookRequest({
    rawBody: body,
    signature: sign(body),
    secret: SECRET,
    handlers,
    logger: silentLogger,
  });

  assert.equal(result.status, 500);
});

test('ready=false returns 503 even with valid signature + known event', async () => {
  const body = JSON.stringify({ event: 'proposal.accepted', data: {} });
  let invoked = false;
  const handlers = makeHandlers(async () => {
    invoked = true;
  });

  const result = await processWebhookRequest({
    rawBody: body,
    signature: sign(body),
    secret: SECRET,
    handlers,
    ready: false,
    logger: silentLogger,
  });

  assert.equal(result.status, 503);
  assert.equal(invoked, false, 'handler must not run when server is not ready');
});

test('ready=false still rejects bad signatures with 401 (security first)', async () => {
  const body = JSON.stringify({ event: 'proposal.accepted', data: {} });

  const result = await processWebhookRequest({
    rawBody: body,
    signature: 'sha256=' + 'a'.repeat(64),
    secret: SECRET,
    handlers: makeHandlers(),
    ready: false,
    logger: silentLogger,
  });

  assert.equal(result.status, 401);
});

test('ready defaults to true so existing call sites still dispatch', async () => {
  const body = JSON.stringify({ event: 'proposal.accepted', data: {} });
  let invoked = false;
  const handlers = makeHandlers(async () => {
    invoked = true;
  });

  const result = await processWebhookRequest({
    rawBody: body,
    signature: sign(body),
    secret: SECRET,
    handlers,
    logger: silentLogger,
  });

  assert.equal(result.status, 200);
  assert.equal(invoked, true);
});
