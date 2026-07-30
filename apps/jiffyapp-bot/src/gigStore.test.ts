import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { applyMigrations } from './testSupport.js';
import { createGigStore } from './gigStore.js';
import type { GoldenSet, JiffyBrief } from './types.js';

const brief: JiffyBrief = {
  template: 'calculator',
  name: 'Rate Calc',
  description: 'a rate calculator',
};
const goldens: GoldenSet = {
  goldens: [{ title: 'load', steps: [], expect: [{ titleEquals: 'Rate Calc' }] }],
};

test('saveBuild/get round-trip: brief + goldens JSON survive intact', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  const store = createGigStore(db, () => new Date('2026-07-07T00:00:00Z'));

  await store.saveBuild({
    gigId: 'g1',
    templateId: 'calculator',
    templateVersion: '1.0.0',
    brief,
    goldens,
  });

  const row = await store.get('g1');
  assert.ok(row);
  assert.equal(row?.gigId, 'g1');
  assert.equal(row?.kind, 'build');
  assert.equal(row?.templateId, 'calculator');
  assert.equal(row?.templateVersion, '1.0.0');
  assert.deepEqual(row?.brief, brief);
  assert.deepEqual(row?.goldens, goldens);
  assert.equal(row?.toolId, undefined);
  assert.equal(row?.compiledAt, '2026-07-07T00:00:00.000Z');
});

test('saveCycle/get round-trip: kind cycle carries toolId, no brief/goldens', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  const store = createGigStore(db, () => new Date('2026-07-07T00:00:00Z'));

  await store.saveCycle({ gigId: 'g2', toolId: 'tool-abc123' });

  const row = await store.get('g2');
  assert.ok(row);
  assert.equal(row?.kind, 'cycle');
  assert.equal(row?.toolId, 'tool-abc123');
  assert.equal(row?.brief, undefined);
  assert.equal(row?.goldens, undefined);
  assert.equal(row?.templateId, undefined);
});

test('get returns null for an unknown gig id', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  const store = createGigStore(db);
  assert.equal(await store.get('does-not-exist'), null);
});

test('saveBuild is an upsert: a second save for the same gig id overwrites, not duplicates', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  const store = createGigStore(db, () => new Date('2026-07-07T00:00:00Z'));

  await store.saveBuild({
    gigId: 'g3',
    templateId: 'landing',
    templateVersion: '1.0.0',
    brief,
    goldens,
  });

  const otherGoldens: GoldenSet = {
    goldens: [{ title: 'other', steps: [], expect: [{ titleEquals: 'Other' }] }],
  };
  await store.saveBuild({
    gigId: 'g3',
    templateId: 'calculator',
    templateVersion: '2.0.0',
    brief,
    goldens: otherGoldens,
  });

  const row = await store.get('g3');
  assert.equal(row?.templateId, 'calculator');
  assert.equal(row?.templateVersion, '2.0.0');
  assert.deepEqual(row?.goldens, otherGoldens);

  const { results } = await db.prepare('SELECT COUNT(*) as n FROM gig_briefs').all<{ n: number }>();
  assert.equal(results[0]?.n, 1);
});
