import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deterministicUrl,
  hmacSha256Hex,
  ogDeliverableKey,
  verifyCmsRequest,
  withinReplayWindow,
} from './cms.js';

const SECRET = 'per-offer-secret-abc';
const NOW_S = Math.floor(Date.parse('2026-07-06T12:00:00Z') / 1000);

async function sign(secret: string, timestamp: number, body: string): Promise<string> {
  return `hmac-sha256=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

test('valid signature within the replay window verifies', async () => {
  const body = JSON.stringify({ page_url: 'https://p', title: 'Hello' });
  const result = await verifyCmsRequest({
    secret: SECRET,
    rawBody: body,
    providedSignature: await sign(SECRET, NOW_S, body),
    timestamp: NOW_S,
    nowSeconds: NOW_S,
  });
  assert.deepEqual(result, { ok: true });
});

test('stale timestamp (outside ±5 min) is rejected before any HMAC work', async () => {
  const body = '{"page_url":"https://p"}';
  const staleTs = NOW_S - 600;
  const result = await verifyCmsRequest({
    secret: SECRET,
    rawBody: body,
    providedSignature: await sign(SECRET, staleTs, body),
    timestamp: staleTs,
    nowSeconds: NOW_S,
  });
  assert.deepEqual(result, { ok: false, reason: 'stale-timestamp' });
});

test('spoofed signature (wrong secret) is rejected', async () => {
  const body = '{"page_url":"https://p"}';
  const result = await verifyCmsRequest({
    secret: SECRET,
    rawBody: body,
    providedSignature: await sign('attacker-secret', NOW_S, body),
    timestamp: NOW_S,
    nowSeconds: NOW_S,
  });
  assert.deepEqual(result, { ok: false, reason: 'bad-signature' });
});

test('a tampered body fails even with a real signature over the original body', async () => {
  const original = '{"page_url":"https://p","title":"A"}';
  const tampered = '{"page_url":"https://p","title":"B"}';
  const result = await verifyCmsRequest({
    secret: SECRET,
    rawBody: tampered,
    providedSignature: await sign(SECRET, NOW_S, original),
    timestamp: NOW_S,
    nowSeconds: NOW_S,
  });
  assert.deepEqual(result, { ok: false, reason: 'bad-signature' });
});

test('missing signature is rejected', async () => {
  const result = await verifyCmsRequest({
    secret: SECRET,
    rawBody: '{}',
    providedSignature: null,
    timestamp: NOW_S,
    nowSeconds: NOW_S,
  });
  assert.deepEqual(result, { ok: false, reason: 'missing-signature' });
});

test('withinReplayWindow accepts ±window and rejects beyond it (and NaN)', () => {
  assert.equal(withinReplayWindow(NOW_S - 300, NOW_S, 300), true);
  assert.equal(withinReplayWindow(NOW_S + 300, NOW_S, 300), true);
  assert.equal(withinReplayWindow(NOW_S - 301, NOW_S, 300), false);
  assert.equal(withinReplayWindow(Number.NaN, NOW_S, 300), false);
});

test('deterministic URL derives purely from the idempotency key (mintable pre-render, §8)', () => {
  assert.equal(ogDeliverableKey('abc123'), 'og/abc123.png');
  assert.equal(
    deterministicUrl('https://tf.example.com/', 'abc123'),
    'https://tf.example.com/a/og/abc123.png',
  );
  // Trailing-slash normalized; same key → same URL.
  assert.equal(
    deterministicUrl('https://tf.example.com', 'abc123'),
    deterministicUrl('https://tf.example.com/', 'abc123'),
  );
});
