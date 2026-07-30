import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideIdempotency, deriveIdempotencyKey, type ClaimRow } from './idempotency.js';

test('deriveIdempotencyKey is deterministic and order-independent over content fields', async () => {
  const a = await deriveIdempotencyKey('https://p', 'Title', { b: 2, a: 1 });
  const b = await deriveIdempotencyKey('https://p', 'Title', { a: 1, b: 2 });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b, 'field order must not change the key');
});

test('deriveIdempotencyKey changes when any content field changes (republish-with-edits)', async () => {
  const base = await deriveIdempotencyKey('https://p', 'Title', { rev: 1 });
  assert.notEqual(base, await deriveIdempotencyKey('https://p', 'Title', { rev: 2 }));
  assert.notEqual(base, await deriveIdempotencyKey('https://p', 'New Title', { rev: 1 }));
  assert.notEqual(base, await deriveIdempotencyKey('https://other', 'Title', { rev: 1 }));
});

const NOW = Date.parse('2026-07-06T12:00:00Z');

test('fresh: no existing claim → render as a new usage unit', () => {
  assert.deepEqual(decideIdempotency(null, { now: NOW }), { action: 'render', reason: 'fresh' });
});

test('changed-hash-rerender: unseen key but the same page_url was delivered before', () => {
  assert.deepEqual(decideIdempotency(null, { now: NOW, priorVersionDelivered: true }), {
    action: 'render',
    reason: 'changed-hash-rerender',
  });
});

test('delivered-return: an already-delivered key returns its URL and counts nothing', () => {
  const row: ClaimRow = {
    status: 'delivered',
    url: 'https://x/a/og/k.png',
    claimedAt: '2026-07-06T11:59:00Z',
  };
  assert.deepEqual(decideIdempotency(row, { now: NOW }), {
    action: 'return',
    reason: 'delivered-return',
    url: 'https://x/a/og/k.png',
  });
});

test('pending-in-flight: a fresh pending claim (younger than the takeover TTL) waits', () => {
  const row: ClaimRow = {
    status: 'pending',
    url: null,
    claimedAt: new Date(NOW - 30_000).toISOString(),
  };
  assert.deepEqual(decideIdempotency(row, { now: NOW, takeoverMs: 120_000 }), {
    action: 'wait',
    reason: 'pending-in-flight',
  });
});

test('stale-pending-takeover: a pending claim older than the TTL is re-driven', () => {
  const row: ClaimRow = {
    status: 'pending',
    url: null,
    claimedAt: new Date(NOW - 5 * 60_000).toISOString(),
  };
  assert.deepEqual(decideIdempotency(row, { now: NOW, takeoverMs: 120_000 }), {
    action: 'render',
    reason: 'stale-pending-takeover',
  });
});

test('a delivered row missing its URL falls back to a takeover re-drive (never a bad return)', () => {
  const row: ClaimRow = { status: 'delivered', url: null, claimedAt: '2026-07-06T11:00:00Z' };
  assert.deepEqual(decideIdempotency(row, { now: NOW }), {
    action: 'render',
    reason: 'stale-pending-takeover',
  });
});
