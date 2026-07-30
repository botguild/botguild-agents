import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { applyMigrations } from './testSupport.js';
import {
  createJobStore,
  decideOnConflict,
  loadReputationSnapshot,
  saveReputationSnapshot,
  sha256Hex,
  type JobStore,
} from './jobs.js';
import type { JobCheckpoint } from './types.js';

const checkpoint: JobCheckpoint = { variants: [], batchRounds: 1, spendUsd: 0.25 };

async function freshStore(
  now?: () => Date,
): Promise<{ store: JobStore; db: ReturnType<typeof createMemoryD1> }> {
  const db = createMemoryD1();
  await applyMigrations(db);
  return { store: createJobStore(db, now), db };
}

test('sha256Hex produces the deterministic 64-hex idempotency key', async () => {
  const key = await sha256Hex('contract-123');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, await sha256Hex('contract-123'));
  assert.notEqual(key, await sha256Hex('contract-124'));
});

// --- Pure claim-conflict policy (§6 step 2 / §8) ------------------------------

test('decideOnConflict: delivered and parked skip; checkpointed skips; bare claim re-enqueues', () => {
  assert.deepEqual(decideOnConflict({ status: 'delivered', checkpoint: null }), {
    action: 'skip',
    reason: 'delivered',
  });
  assert.deepEqual(decideOnConflict({ status: 'parked', checkpoint: null }), {
    action: 'skip',
    reason: 'parked',
  });
  assert.deepEqual(decideOnConflict({ status: 'in_progress', checkpoint }), {
    action: 'skip',
    reason: 'in-progress',
  });
  // Claimed but never checkpointed: claim+send are not atomic, so a webhook
  // redelivery must re-enqueue rather than 200 into a permanent stall.
  assert.deepEqual(decideOnConflict({ status: 'claimed', checkpoint: null }), {
    action: 'enqueue',
    reason: 'claimed-not-checkpointed',
  });
  // But once a job reaches in_progress a consumer already holds a queue message,
  // so a redelivery must SKIP (even with no checkpoint yet) — never run a second
  // concurrent pipeline that would double-spend the cap / double-deliver (#7).
  assert.deepEqual(decideOnConflict({ status: 'in_progress', checkpoint: null }), {
    action: 'skip',
    reason: 'in-progress',
  });
});

// --- Claim against real SQLite unique-constraint semantics --------------------

test('first claim inserts; redelivery of an unstarted job re-enqueues', async () => {
  const { store } = await freshStore();
  assert.deepEqual(await store.claim('key-1', 'contract-1'), {
    action: 'enqueue',
    reason: 'fresh-claim',
  });
  assert.deepEqual(await store.claim('key-1', 'contract-1'), {
    action: 'enqueue',
    reason: 'claimed-not-checkpointed',
  });
});

test('redelivery skips once the job is checkpointed, parked, or delivered', async () => {
  const { store } = await freshStore();
  await store.claim('key-1', 'contract-1');
  await store.saveCheckpoint('key-1', checkpoint);
  assert.deepEqual(await store.claim('key-1', 'contract-1'), {
    action: 'skip',
    reason: 'in-progress',
  });

  await store.claim('key-2', 'contract-2');
  await store.park('key-2', 'moderation_outage');
  assert.deepEqual(await store.claim('key-2', 'contract-2'), { action: 'skip', reason: 'parked' });

  await store.claim('key-3', 'contract-3');
  await store.markDelivered('key-3', 'delivered');
  assert.deepEqual(await store.claim('key-3', 'contract-3'), {
    action: 'skip',
    reason: 'delivered',
  });
});

test('each claimed job gets a distinct, unguessable 64-hex deliverable token (§12)', async () => {
  const { store } = await freshStore();
  await store.claim('key-1', 'contract-1');
  await store.claim('key-2', 'contract-2');
  const a = await store.get('key-1');
  const b = await store.get('key-2');
  assert.match(a?.deliverableToken ?? '', /^[0-9a-f]{64}$/);
  assert.match(b?.deliverableToken ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(
    a?.deliverableToken,
    b?.deliverableToken,
    'the token is per-job random, not derived from the contract id',
  );
  // The token is NOT the (public, recomputable) job key.
  assert.notEqual(a?.deliverableToken, 'key-1');
  // Stable across reads.
  assert.equal((await store.get('key-1'))?.deliverableToken, a?.deliverableToken);
});

test('checkpoint round-trips with spend accounting mirrored to columns', async () => {
  const { store } = await freshStore();
  await store.claim('key-1', 'contract-1');
  const cp: JobCheckpoint = {
    variants: [
      {
        variant: { id: 'v1', angle: 'value', headline: 'h', primaryText: 'p', description: 'd' },
        status: 'passed',
        regenAttempts: 2,
        evidence: {},
      },
    ],
    batchRounds: 2,
    spendUsd: 1.25,
  };
  await store.saveCheckpoint('key-1', cp);
  const row = await store.get('key-1');
  assert.deepEqual(row?.checkpoint, cp);
  assert.equal(row?.spentUsd, 1.25);
  assert.equal(row?.batchRounds, 2);
});

test('park / unpark lifecycle and parked listing by reason', async () => {
  const { store } = await freshStore();
  await store.claim('key-1', 'contract-1');
  await store.claim('key-2', 'contract-2');
  await store.park('key-1', 'moderation_outage');
  await store.park('key-2', 'brief_invalid');

  const outages = await store.listParked('moderation_outage');
  assert.deepEqual(
    outages.map((j) => j.jobKey),
    ['key-1'],
  );
  assert.equal((await store.listParked()).length, 2);

  await store.unpark('key-1');
  const row = await store.get('key-1');
  assert.equal(row?.status, 'claimed');
  assert.equal(row?.parkReason, null);
  assert.equal((await store.listParked()).length, 1);
});

test('moderation attempts increment across parks (FR-2 notice threshold)', async () => {
  const { store } = await freshStore();
  await store.claim('key-1', 'contract-1');
  assert.equal(await store.incrementModerationAttempts('key-1'), 1);
  assert.equal(await store.incrementModerationAttempts('key-1'), 2);
  assert.equal(await store.incrementModerationAttempts('key-1'), 3);
});

test('listStuckClaims finds only old, checkpoint-less claimed jobs', async () => {
  let clock = new Date('2026-07-06T00:00:00Z');
  const { store } = await freshStore(() => clock);
  await store.claim('old-bare', 'c1');
  await store.claim('old-checkpointed', 'c2');
  await store.saveCheckpoint('old-checkpointed', checkpoint);

  clock = new Date('2026-07-06T01:00:00Z');
  await store.claim('fresh', 'c3');

  const cutoff = new Date('2026-07-06T00:30:00Z');
  const stuck = await store.listStuckClaims(cutoff);
  assert.deepEqual(
    stuck.map((j) => j.jobKey),
    ['old-bare'],
  );
});

test('gate audit rows persist decisions with JSON detail', async () => {
  const { store, db } = await freshStore();
  await store.claim('key-1', 'contract-1');
  await store.recordGateAudit({
    jobKey: 'key-1',
    variantId: 'v1',
    gate: 'moderation',
    result: 'pass',
    detail: { vendor: 'openai', flagged: false },
  });
  const { results } = await db
    .prepare('SELECT gate, result, detail_json FROM gate_audit WHERE job_key = ?')
    .bind('key-1')
    .all<{ gate: string; result: string; detail_json: string }>();
  assert.equal(results.length, 1);
  assert.equal(results[0]?.gate, 'moderation');
  assert.equal(JSON.parse(results[0]?.detail_json ?? '{}').vendor, 'openai');
});

test('reputation snapshot cache upserts and reads back', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  assert.equal(await loadReputationSnapshot(db), null);
  await saveReputationSnapshot(db, { reputationScore: 71, disputeRate: 0 });
  await saveReputationSnapshot(db, { reputationScore: 74, disputeRate: 0 });
  assert.deepEqual(await loadReputationSnapshot(db), { reputationScore: 74, disputeRate: 0 });
});
