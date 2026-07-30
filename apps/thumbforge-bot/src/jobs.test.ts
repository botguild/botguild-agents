// D1 store tests against real in-memory SQLite (the shim's node:sqlite double):
// the FR-15 atomic cap reservation, the §9 atomic completion claim, and the
// bounded gate-audit retention prune.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { applyMigrations } from './dbTestSupport.js';
import {
  createAuditStore,
  createRenderJobStore,
  createUsageStore,
  type RenderJobStore,
} from './jobs.js';
import type { RenderPlan } from './jobs.js';

async function freshDb(): Promise<ReturnType<typeof createMemoryD1>> {
  const db = createMemoryD1();
  await applyMigrations(db);
  return db;
}

const plan: RenderPlan = {
  kind: 'social_pack',
  graphics: [
    {
      graphicId: 'g1',
      templateId: 'social-feed',
      format: 'feed',
      brandKit: { palette: ['#000'], swatchRegions: [] },
      inputs: { headline: 'hi' },
    },
  ],
};

// --- FR-15 atomic usage reservation (#4/#10) ---------------------------------

test('reserve claims one slot per call and holds at the cap (atomic, no read-then-write race)', async () => {
  const usage = createUsageStore(await freshDb());
  assert.deepEqual(await usage.reserve('offer', '2026-07', 3), { reserved: true, used: 1 });
  assert.deepEqual(await usage.reserve('offer', '2026-07', 3), { reserved: true, used: 2 });
  assert.deepEqual(await usage.reserve('offer', '2026-07', 3), { reserved: true, used: 3 });
  // At cap: the conditional increment is a no-op, so nothing is served or counted.
  assert.deepEqual(await usage.reserve('offer', '2026-07', 3), { reserved: false, used: 3 });
  assert.equal(await usage.getUsed('offer', '2026-07'), 3);
});

test('release compensates a reserved-but-failed render and never drops below zero', async () => {
  const usage = createUsageStore(await freshDb());
  await usage.reserve('offer', '2026-07', 5);
  await usage.reserve('offer', '2026-07', 5);
  await usage.release('offer', '2026-07');
  assert.equal(await usage.getUsed('offer', '2026-07'), 1);
  await usage.release('offer', '2026-07');
  await usage.release('offer', '2026-07'); // extra release is clamped
  assert.equal(await usage.getUsed('offer', '2026-07'), 0);
});

test('a zero cap reserves nothing', async () => {
  const usage = createUsageStore(await freshDb());
  assert.deepEqual(await usage.reserve('offer', '2026-07', 0), { reserved: false, used: 0 });
});

// --- §9 atomic completion claim (#9) -----------------------------------------

async function inProgressJob(): Promise<{ store: RenderJobStore; jobKey: string }> {
  const store = createRenderJobStore(await freshDb());
  await store.claim('job-1', 'c1');
  await store.savePlan('job-1', { kind: 'social_pack', milestoneId: 'm1', plan });
  return { store, jobKey: 'job-1' };
}

test('claimForDelivery lets exactly one concurrent invocation win the completion', async () => {
  const { store, jobKey } = await inProgressJob();
  assert.equal(await store.claimForDelivery(jobKey), true, 'first caller wins');
  assert.equal(
    await store.claimForDelivery(jobKey),
    false,
    'second caller loses (already delivered)',
  );
});

test('reopenForDelivery undoes an unfinished claim so a retry can re-deliver', async () => {
  const { store, jobKey } = await inProgressJob();
  assert.equal(await store.claimForDelivery(jobKey), true);
  await store.reopenForDelivery(jobKey);
  assert.equal((await store.get(jobKey))?.status, 'in_progress');
  assert.equal(await store.claimForDelivery(jobKey), true, 'the reopened job can be claimed again');
});

test('reopenForDelivery never resurrects a truly-finished delivery', async () => {
  const { store, jobKey } = await inProgressJob();
  await store.claimForDelivery(jobKey);
  await store.markDelivered(jobKey, 'delivered');
  await store.reopenForDelivery(jobKey); // outcome is set → guarded no-op
  assert.equal((await store.get(jobKey))?.status, 'delivered');
});

// --- Bounded gate-audit retention (#13) --------------------------------------

test('pruneOlderThan deletes only rows older than the cutoff', async () => {
  let clock = new Date('2026-04-01T00:00:00Z');
  const db = await freshDb();
  const audit = createAuditStore(db, () => clock);
  await audit.record({ scope: 'old', gate: 'render-gates', result: 'pass' });
  clock = new Date('2026-07-01T00:00:00Z');
  await audit.record({ scope: 'new', gate: 'render-gates', result: 'pass' });

  const deleted = await audit.pruneOlderThan(new Date('2026-06-01T00:00:00Z'));
  assert.equal(deleted, 1);
  const { results } = await db.prepare('SELECT scope FROM gate_audit').all<{ scope: string }>();
  assert.deepEqual(
    results.map((r) => r.scope),
    ['new'],
  );
});
