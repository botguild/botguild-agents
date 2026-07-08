import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { applyMigrations } from './testSupport.js';
import type { D1Like } from '@botguild/agent-core-workers';
import {
  createAuditStore,
  createBuildLogStore,
  createCycleStore,
  createEditRequestStore,
  createJobStore,
  createRelayStore,
  createToolStore,
  createUsageStore,
  decideOnConflict,
  dayPeriod,
  dlqDepth,
  jobKeyFor,
  loadReputationSnapshot,
  minutePeriod,
  monthPeriod,
  randomToken,
  recordAbuse,
  recordDlqEvent,
  saveReputationSnapshot,
  sha256Hex,
  type BuildCheckpoint,
  type JobStore,
  type ToolStore,
} from './jobs.js';
import type { GoldenSet, JiffyBrief } from './types.js';

async function freshDb(): Promise<D1Like> {
  const db = createMemoryD1();
  await applyMigrations(db);
  return db;
}

const brief: JiffyBrief = { name: 'Acme Calc', description: 'a calculator' };
const goldens: GoldenSet = { goldens: [{ title: 'loads', steps: [{ do: 'load' }], expect: [] }] };

const checkpoint: BuildCheckpoint = {
  slotValues: { title: 'Acme' },
  round: 2,
  spendUsd: 0.31,
  activeMs: 45_000,
  staged: true,
  lastFailures: ['assertion X failed once'],
  bankedRound: null,
};

// --- Shared helpers -----------------------------------------------------------

test('sha256Hex is deterministic and 64-hex', async () => {
  const key = await sha256Hex('contract-123');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, await sha256Hex('contract-123'));
  assert.notEqual(key, await sha256Hex('contract-124'));
});

test('randomToken is 64-hex and unique per call', () => {
  const a = randomToken();
  const b = randomToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.match(b, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('jobKeyFor composes hash:stage', () => {
  assert.equal(jobKeyFor('abc123', 'build'), 'abc123:build');
  assert.equal(jobKeyFor('abc123', 'edit:req-1'), 'abc123:edit:req-1');
});

test('decideOnConflict: delivered/parked/in-progress skip; checkpointed skips; bare claim re-enqueues', () => {
  assert.deepEqual(decideOnConflict({ status: 'delivered', checkpoint: null }), {
    action: 'skip',
    reason: 'delivered',
  });
  assert.deepEqual(decideOnConflict({ status: 'parked', checkpoint: null }), {
    action: 'skip',
    reason: 'parked',
  });
  assert.deepEqual(decideOnConflict({ status: 'in_progress', checkpoint: null }), {
    action: 'skip',
    reason: 'in-progress',
  });
  assert.deepEqual(decideOnConflict({ status: 'in_progress', checkpoint }), {
    action: 'skip',
    reason: 'in-progress',
  });
  assert.deepEqual(decideOnConflict({ status: 'claimed', checkpoint: null }), {
    action: 'enqueue',
    reason: 'claimed-not-checkpointed',
  });
  assert.deepEqual(decideOnConflict({ status: 'claimed', checkpoint }), {
    action: 'skip',
    reason: 'in-progress',
  });
});

// --- JobStore ------------------------------------------------------------------

async function freshJobStore(now?: () => Date): Promise<{ store: JobStore; db: D1Like }> {
  const db = await freshDb();
  return { store: createJobStore(db, now), db };
}

test('fresh claim enqueues and persists a 64-hex deliverable token', async () => {
  const { store } = await freshJobStore();
  const decision = await store.claim({ jobKey: 'k1', contractId: 'c1', kind: 'build' });
  assert.deepEqual(decision, { action: 'enqueue', reason: 'fresh-claim' });
  const row = await store.get('k1');
  assert.ok(row);
  assert.equal(row?.contractId, 'c1');
  assert.equal(row?.kind, 'build');
  assert.equal(row?.status, 'claimed');
  assert.match(row?.deliverableToken ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(row?.deliverableToken, 'k1');
});

test('each claim gets a distinct token; toolId/gigId persist when provided', async () => {
  const { store } = await freshJobStore();
  await store.claim({ jobKey: 'k1', contractId: 'c1', kind: 'cycle', toolId: 'tool-1' });
  await store.claim({
    jobKey: 'k2',
    contractId: 'c2',
    kind: 'edit',
    toolId: 'tool-1',
    gigId: 'g2',
  });
  const a = await store.get('k1');
  const b = await store.get('k2');
  assert.notEqual(a?.deliverableToken, b?.deliverableToken);
  assert.equal(a?.toolId, 'tool-1');
  assert.equal(a?.gigId, null);
  assert.equal(b?.gigId, 'g2');
});

test('redelivery of a bare claim re-enqueues; claim conflict branches skip appropriately', async () => {
  const { store } = await freshJobStore();
  await store.claim({ jobKey: 'k1', contractId: 'c1', kind: 'build' });
  assert.deepEqual(await store.claim({ jobKey: 'k1', contractId: 'c1', kind: 'build' }), {
    action: 'enqueue',
    reason: 'claimed-not-checkpointed',
  });

  // Checkpointed (still 'claimed' status) -> skip in-progress.
  await store.saveCheckpoint('k1', checkpoint);
  assert.deepEqual(await store.claim({ jobKey: 'k1', contractId: 'c1', kind: 'build' }), {
    action: 'skip',
    reason: 'in-progress',
  });

  // in_progress (via setInProgress) with no checkpoint still skips.
  await store.claim({ jobKey: 'k2', contractId: 'c2', kind: 'build' });
  await store.setInProgress('k2', {});
  assert.deepEqual(await store.claim({ jobKey: 'k2', contractId: 'c2', kind: 'build' }), {
    action: 'skip',
    reason: 'in-progress',
  });

  // Parked -> skip.
  await store.claim({ jobKey: 'k3', contractId: 'c3', kind: 'build' });
  await store.park('k3', 'moderation_outage');
  assert.deepEqual(await store.claim({ jobKey: 'k3', contractId: 'c3', kind: 'build' }), {
    action: 'skip',
    reason: 'parked',
  });

  // Delivered -> skip.
  await store.claim({ jobKey: 'k4', contractId: 'c4', kind: 'build' });
  await store.markDelivered('k4', 'delivered');
  assert.deepEqual(await store.claim({ jobKey: 'k4', contractId: 'c4', kind: 'build' }), {
    action: 'skip',
    reason: 'delivered',
  });
});

test('setInProgress sets status and only overwrites provided fields (COALESCE)', async () => {
  const { store } = await freshJobStore();
  await store.claim({ jobKey: 'k1', contractId: 'c1', kind: 'build' });
  await store.setInProgress('k1', { gigId: 'g1', briefJson: JSON.stringify(brief) });
  let row = await store.get('k1');
  assert.equal(row?.status, 'in_progress');
  assert.equal(row?.gigId, 'g1');
  assert.deepEqual(row?.brief, brief);
  assert.equal(row?.goldens, null);

  // A second call with only goldensJson must not clobber the already-set gigId/brief.
  await store.setInProgress('k1', { goldensJson: JSON.stringify(goldens) });
  row = await store.get('k1');
  assert.equal(row?.gigId, 'g1');
  assert.deepEqual(row?.brief, brief);
  assert.deepEqual(row?.goldens, goldens);
});

test('updateBrief overwrites brief_json without forcing status (unlike setInProgress)', async () => {
  const { store } = await freshJobStore();
  await store.claim({ jobKey: 'k1', contractId: 'c1', kind: 'build' });
  await store.park('k1', 'brief_invalid');

  const corrected: JiffyBrief = { name: 'Fixed Calc', description: 'a corrected calculator' };
  await store.updateBrief('k1', JSON.stringify(corrected));

  const row = await store.get('k1');
  assert.deepEqual(row?.brief, corrected);
  // Still parked — updateBrief must not touch status/park_reason (the sweep unparks separately).
  assert.equal(row?.status, 'parked');
  assert.equal(row?.parkReason, 'brief_invalid');
});

test('checkpoint round-trips including activeMs and denormalizes spent_usd/repair_rounds', async () => {
  const { store, db } = await freshJobStore();
  await store.claim({ jobKey: 'k1', contractId: 'c1', kind: 'build' });
  await store.saveCheckpoint('k1', checkpoint);
  const row = await store.get('k1');
  assert.deepEqual(row?.checkpoint, checkpoint);
  assert.equal(row?.spentUsd, checkpoint.spendUsd);
  assert.equal(row?.repairRounds, checkpoint.round);

  const raw = await db
    .prepare('SELECT spent_usd, repair_rounds FROM jobs WHERE job_key = ?')
    .bind('k1')
    .first<{ spent_usd: number; repair_rounds: number }>();
  assert.equal(raw?.spent_usd, 0.31);
  assert.equal(raw?.repair_rounds, 2);
});

test('park / unpark lifecycle and parked listing by reason', async () => {
  const { store } = await freshJobStore();
  await store.claim({ jobKey: 'k1', contractId: 'c1', kind: 'build' });
  await store.claim({ jobKey: 'k2', contractId: 'c2', kind: 'build' });
  await store.park('k1', 'moderation_outage');
  await store.park('k2', 'brief_invalid');

  const outages = await store.listParked('moderation_outage');
  assert.deepEqual(
    outages.map((j) => j.jobKey),
    ['k1'],
  );
  assert.equal((await store.listParked()).length, 2);

  await store.unpark('k1');
  const row = await store.get('k1');
  assert.equal(row?.status, 'claimed');
  assert.equal(row?.parkReason, null);
  assert.equal((await store.listParked()).length, 1);
});

test('incrementModerationAttempts returns the new count each call', async () => {
  const { store } = await freshJobStore();
  await store.claim({ jobKey: 'k1', contractId: 'c1', kind: 'build' });
  assert.equal(await store.incrementModerationAttempts('k1'), 1);
  assert.equal(await store.incrementModerationAttempts('k1'), 2);
  assert.equal(await store.incrementModerationAttempts('k1'), 3);
});

test('markDelivered records outcome and delivered_at', async () => {
  const { store } = await freshJobStore();
  await store.claim({ jobKey: 'k1', contractId: 'c1', kind: 'build' });
  await store.claim({ jobKey: 'k2', contractId: 'c2', kind: 'build' });
  await store.markDelivered('k1', 'delivered');
  await store.markDelivered('k2', 'rejected');
  const a = await store.get('k1');
  const b = await store.get('k2');
  assert.equal(a?.status, 'delivered');
  assert.equal(a?.outcome, 'delivered');
  assert.ok(a?.deliveredAt);
  assert.equal(b?.outcome, 'rejected');
});

test('listStuckClaims finds only old, checkpoint-less claimed jobs', async () => {
  let clock = new Date('2026-07-06T00:00:00Z');
  const { store } = await freshJobStore(() => clock);
  await store.claim({ jobKey: 'old-bare', contractId: 'c1', kind: 'build' });
  await store.claim({ jobKey: 'old-checkpointed', contractId: 'c2', kind: 'build' });
  await store.saveCheckpoint('old-checkpointed', checkpoint);

  clock = new Date('2026-07-06T01:00:00Z');
  await store.claim({ jobKey: 'fresh', contractId: 'c3', kind: 'build' });

  const cutoff = new Date('2026-07-06T00:30:00Z');
  const stuck = await store.listStuckClaims(cutoff);
  assert.deepEqual(
    stuck.map((j) => j.jobKey),
    ['old-bare'],
  );
});

// --- ToolStore -------------------------------------------------------------

async function freshToolStore(now?: () => Date): Promise<{ store: ToolStore; db: D1Like }> {
  const db = await freshDb();
  return { store: createToolStore(db, now), db };
}

const toolArgsBase = {
  templateId: 'calculator' as const,
  templateVersion: '1.0.0',
  buildContractId: 'contract-build-1',
  name: 'Acme Calc',
  brief,
  goldens,
};

test('create reserves the first free slug (acme taken -> acme-2)', async () => {
  const { store } = await freshToolStore();
  const slugA = await store.create({
    ...toolArgsBase,
    toolId: 'tool-a',
    slugCandidates: ['acme', 'acme-2'],
  });
  assert.equal(slugA, 'acme');

  const slugB = await store.create({
    ...toolArgsBase,
    toolId: 'tool-b',
    buildContractId: 'contract-build-2',
    slugCandidates: ['acme', 'acme-2'],
  });
  assert.equal(slugB, 'acme-2');

  const rowA = await store.get('tool-a');
  const rowB = await store.get('tool-b');
  assert.equal(rowA?.status, 'building');
  assert.equal(rowA?.slug, 'acme');
  assert.equal(rowB?.slug, 'acme-2');
  assert.deepEqual(rowA?.brief, brief);
  assert.deepEqual(rowA?.goldens, goldens);
});

test('create throws when every candidate is taken by a different tool', async () => {
  const { store } = await freshToolStore();
  await store.create({ ...toolArgsBase, toolId: 'tool-a', slugCandidates: ['x'] });
  await store.create({
    ...toolArgsBase,
    toolId: 'tool-b',
    buildContractId: 'contract-build-2',
    slugCandidates: ['x-2'],
  });
  await assert.rejects(
    store.create({
      ...toolArgsBase,
      toolId: 'tool-c',
      buildContractId: 'contract-build-3',
      slugCandidates: ['x', 'x-2'],
    }),
  );
});

test('create resumes cleanly on a redelivered claim for the same toolId (PK conflict, not slug)', async () => {
  const { store } = await freshToolStore();
  const first = await store.create({
    ...toolArgsBase,
    toolId: 'tool-a',
    slugCandidates: ['acme', 'acme-2'],
  });
  assert.equal(first, 'acme');
  // Same tool retried with the same candidate list (e.g. a queue redelivery).
  const resumed = await store.create({
    ...toolArgsBase,
    toolId: 'tool-a',
    slugCandidates: ['acme', 'acme-2'],
  });
  assert.equal(resumed, 'acme');
  const count = await store.get('tool-a');
  assert.equal(count?.slug, 'acme');
});

test('create resumes on a redelivered claim even with a single-candidate list (exact-duplicate row conflict)', async () => {
  const { store, db } = await freshToolStore();
  const first = await store.create({
    ...toolArgsBase,
    toolId: 'tool-a',
    slugCandidates: ['acme'],
  });
  assert.equal(first, 'acme');
  // Redelivery retries the exact same (tool_id, slug) pair — SQLite may
  // report this as a `slug` UNIQUE conflict even though it's a self-conflict.
  const resumed = await store.create({
    ...toolArgsBase,
    toolId: 'tool-a',
    slugCandidates: ['acme'],
  });
  assert.equal(resumed, 'acme');

  const row = await store.get('tool-a');
  assert.equal(row?.slug, 'acme');
  const { results } = await db
    .prepare('SELECT COUNT(*) AS n FROM tools WHERE tool_id = ?')
    .bind('tool-a')
    .all<{ n: number }>();
  assert.equal(results[0]?.n, 1);
});

test('getByBuildContract and getBySlug resolve the same row', async () => {
  const { store } = await freshToolStore();
  await store.create({ ...toolArgsBase, toolId: 'tool-a', slugCandidates: ['acme'] });
  const byContract = await store.getByBuildContract('contract-build-1');
  const bySlug = await store.getBySlug('acme');
  assert.equal(byContract?.toolId, 'tool-a');
  assert.equal(bySlug?.toolId, 'tool-a');
  assert.equal(await store.getByBuildContract('nope'), null);
  assert.equal(await store.getBySlug('nope'), null);
});

test('promote sets live + slots + hostedUntil and clears grace', async () => {
  const { store } = await freshToolStore();
  await store.create({ ...toolArgsBase, toolId: 'tool-a', slugCandidates: ['acme'] });
  await store.markGrace('tool-a', new Date('2026-07-01T00:00:00Z'));
  let row = await store.get('tool-a');
  assert.equal(row?.status, 'grace');
  assert.ok(row?.graceStartedAt);

  await store.promote('tool-a', { slots: { title: 'Acme' }, hostedUntil: '2026-08-01T00:00:00Z' });
  row = await store.get('tool-a');
  assert.equal(row?.status, 'live');
  assert.deepEqual(row?.slots, { title: 'Acme' });
  assert.equal(row?.hostedUntil, '2026-08-01T00:00:00Z');
  assert.equal(row?.graceStartedAt, null);
});

test('setStatus and setGoldens update independently', async () => {
  const { store } = await freshToolStore();
  await store.create({ ...toolArgsBase, toolId: 'tool-a', slugCandidates: ['acme'] });
  await store.setStatus('tool-a', 'suspended');
  assert.equal((await store.get('tool-a'))?.status, 'suspended');

  const newGoldens: GoldenSet = { goldens: [{ title: 'updated', steps: [], expect: [] }] };
  await store.setGoldens('tool-a', newGoldens);
  assert.deepEqual((await store.get('tool-a'))?.goldens, newGoldens);
});

test('extendHosting sets hosted_until + latest_hosting_contract_id, status live, clears grace', async () => {
  const { store } = await freshToolStore();
  await store.create({ ...toolArgsBase, toolId: 'tool-a', slugCandidates: ['acme'] });
  await store.markGrace('tool-a', new Date('2026-07-01T00:00:00Z'));
  await store.extendHosting('tool-a', {
    hostedUntil: '2026-09-01T00:00:00Z',
    hostingContractId: 'hc-1',
  });
  const row = await store.get('tool-a');
  assert.equal(row?.status, 'live');
  assert.equal(row?.hostedUntil, '2026-09-01T00:00:00Z');
  assert.equal(row?.latestHostingContractId, 'hc-1');
  assert.equal(row?.graceStartedAt, null);
});

test('listExpired respects the hosted_until boundary (strictly less than asOf)', async () => {
  const { store } = await freshToolStore();
  await store.create({ ...toolArgsBase, toolId: 'tool-a', slugCandidates: ['a'] });
  await store.create({
    ...toolArgsBase,
    toolId: 'tool-b',
    buildContractId: 'cb2',
    slugCandidates: ['b'],
  });
  await store.create({
    ...toolArgsBase,
    toolId: 'tool-c',
    buildContractId: 'cb3',
    slugCandidates: ['c'],
  });
  await store.promote('tool-a', { slots: {}, hostedUntil: '2026-07-01T00:00:00Z' }); // expired
  await store.promote('tool-b', { slots: {}, hostedUntil: '2026-07-10T00:00:00Z' }); // exactly asOf, not expired
  await store.setStatus('tool-c', 'suspended'); // not live, excluded regardless

  const expired = await store.listExpired(new Date('2026-07-10T00:00:00Z'));
  assert.deepEqual(
    expired.map((t) => t.toolId),
    ['tool-a'],
  );
});

test('listGraceElapsed respects the graceDays boundary with injected now', async () => {
  const { store } = await freshToolStore();
  await store.create({ ...toolArgsBase, toolId: 'tool-a', slugCandidates: ['a'] });
  await store.create({
    ...toolArgsBase,
    toolId: 'tool-b',
    buildContractId: 'cb2',
    slugCandidates: ['b'],
  });
  await store.markGrace('tool-a', new Date('2026-07-01T00:00:00Z')); // 7 days before asOf -> elapsed
  await store.markGrace('tool-b', new Date('2026-07-03T00:00:00Z')); // 5 days before asOf -> not yet

  const asOf = new Date('2026-07-08T00:00:00Z');
  const elapsed = await store.listGraceElapsed(asOf, 7);
  assert.deepEqual(
    elapsed.map((t) => t.toolId),
    ['tool-a'],
  );
});

test('countByStatus tallies tools per status', async () => {
  const { store } = await freshToolStore();
  await store.create({ ...toolArgsBase, toolId: 'tool-a', slugCandidates: ['a'] });
  await store.create({
    ...toolArgsBase,
    toolId: 'tool-b',
    buildContractId: 'cb2',
    slugCandidates: ['b'],
  });
  await store.create({
    ...toolArgsBase,
    toolId: 'tool-c',
    buildContractId: 'cb3',
    slugCandidates: ['c'],
  });
  await store.promote('tool-a', { slots: {}, hostedUntil: '2026-08-01T00:00:00Z' });
  await store.promote('tool-b', { slots: {}, hostedUntil: '2026-08-01T00:00:00Z' });

  const counts = await store.countByStatus();
  assert.equal(counts.live, 2);
  assert.equal(counts.building, 1);
});

// --- CycleStore ----------------------------------------------------------------

test('CycleStore create/get round-trips and is idempotent (INSERT OR IGNORE)', async () => {
  const db = await freshDb();
  const store = createCycleStore(db);
  await store.create({
    contractId: 'hc-1',
    toolId: 'tool-a',
    windowStart: '2026-07-01',
    windowEnd: '2026-07-31',
  });
  await store.create({
    contractId: 'hc-1',
    toolId: 'tool-a',
    windowStart: '2099-01-01',
    windowEnd: '2099-01-31',
  });
  const row = await store.get('hc-1');
  assert.equal(row?.toolId, 'tool-a');
  assert.equal(row?.windowStart, '2026-07-01'); // first insert wins
  assert.equal(row?.reportDeliveredAt, null);
  assert.equal(await store.get('nope'), null);
});

test('listReportDue: window_end <= asOf AND report not yet delivered', async () => {
  const db = await freshDb();
  const store = createCycleStore(db);
  await store.create({
    contractId: 'due',
    toolId: 'tool-a',
    windowStart: '2026-06-01',
    windowEnd: '2026-07-01',
  });
  await store.create({
    contractId: 'not-due',
    toolId: 'tool-b',
    windowStart: '2026-07-01',
    windowEnd: '2026-08-01',
  });
  await store.create({
    contractId: 'already-reported',
    toolId: 'tool-c',
    windowStart: '2026-06-01',
    windowEnd: '2026-07-01',
  });
  await store.markReported('already-reported');

  const due = await store.listReportDue(new Date('2026-07-01T00:00:00Z'));
  assert.deepEqual(due.map((c) => c.contractId).sort(), ['due']);
});

test('markReported sets report_delivered_at', async () => {
  const db = await freshDb();
  const store = createCycleStore(db);
  await store.create({
    contractId: 'hc-1',
    toolId: 'tool-a',
    windowStart: '2026-06-01',
    windowEnd: '2026-07-01',
  });
  await store.markReported('hc-1');
  const row = await store.get('hc-1');
  assert.ok(row?.reportDeliveredAt);
});

test('latestForTool returns the cycle with the greatest window_end', async () => {
  const db = await freshDb();
  const store = createCycleStore(db);
  await store.create({
    contractId: 'hc-1',
    toolId: 'tool-a',
    windowStart: '2026-05-01',
    windowEnd: '2026-06-01',
  });
  await store.create({
    contractId: 'hc-2',
    toolId: 'tool-a',
    windowStart: '2026-06-01',
    windowEnd: '2026-07-01',
  });
  const latest = await store.latestForTool('tool-a');
  assert.deepEqual(latest, { contractId: 'hc-2', windowEnd: '2026-07-01' });
  assert.equal(await store.latestForTool('nope'), null);
});

test('listOpen returns only undelivered cycles whose window contains asOf', async () => {
  const db = await freshDb();
  const store = createCycleStore(db);
  await store.create({
    contractId: 'open',
    toolId: 'tool-a',
    windowStart: '2026-07-01',
    windowEnd: '2026-07-31',
  });
  await store.create({
    contractId: 'past',
    toolId: 'tool-b',
    windowStart: '2026-05-01',
    windowEnd: '2026-05-31',
  });
  await store.create({
    contractId: 'future',
    toolId: 'tool-c',
    windowStart: '2026-08-01',
    windowEnd: '2026-08-31',
  });
  await store.create({
    contractId: 'reported',
    toolId: 'tool-d',
    windowStart: '2026-07-01',
    windowEnd: '2026-07-31',
  });
  await store.markReported('reported');

  const open = await store.listOpen(new Date('2026-07-15T00:00:00Z'));
  assert.deepEqual(open.map((c) => c.contractId).sort(), ['open']);
});

// --- UsageStore + period formatters --------------------------------------------

test('reserve enforces the cap atomically then release decrements', async () => {
  const db = await freshDb();
  const usage = createUsageStore(db);
  assert.deepEqual(await usage.reserve('edit:tool-a', 'hc-1', 3), { reserved: true, used: 1 });
  assert.deepEqual(await usage.reserve('edit:tool-a', 'hc-1', 3), { reserved: true, used: 2 });
  assert.deepEqual(await usage.reserve('edit:tool-a', 'hc-1', 3), { reserved: true, used: 3 });
  assert.deepEqual(await usage.reserve('edit:tool-a', 'hc-1', 3), { reserved: false, used: 3 });
  assert.equal(await usage.getUsed('edit:tool-a', 'hc-1'), 3);

  await usage.release('edit:tool-a', 'hc-1');
  assert.equal(await usage.getUsed('edit:tool-a', 'hc-1'), 2);
  assert.deepEqual(await usage.reserve('edit:tool-a', 'hc-1', 3), { reserved: true, used: 3 });
});

test('release never drops below zero', async () => {
  const db = await freshDb();
  const usage = createUsageStore(db);
  await usage.release('scope', 'period'); // no row yet
  assert.equal(await usage.getUsed('scope', 'period'), 0);
  await usage.reserve('scope', 'period', 5);
  await usage.release('scope', 'period');
  await usage.release('scope', 'period'); // extra release clamps at 0
  assert.equal(await usage.getUsed('scope', 'period'), 0);
});

test('a zero cap reserves nothing', async () => {
  const db = await freshDb();
  const usage = createUsageStore(db);
  assert.deepEqual(await usage.reserve('scope', 'period', 0), { reserved: false, used: 0 });
});

test('period formatters produce exact UTC strings', () => {
  const d = new Date('2026-07-07T09:05:00Z');
  assert.equal(monthPeriod(d), '2026-07');
  assert.equal(dayPeriod(d), '20260707');
  assert.equal(minutePeriod(d), '202607070905');
});

// --- EditRequestStore ------------------------------------------------------

test('edit claim wins exactly once; quota ref round-trips', async () => {
  const db = await freshDb();
  const store = createEditRequestStore(db);
  assert.equal(
    await store.claim({
      requestId: 'req-1',
      toolId: 'tool-a',
      contractId: 'hc-1',
      instruction: 'change color',
    }),
    true,
  );
  assert.equal(
    await store.claim({
      requestId: 'req-1',
      toolId: 'tool-a',
      contractId: 'hc-1',
      instruction: 'ignored',
    }),
    false,
  );

  await store.setQuotaRef('req-1', 'edit:tool-a', 'hc-1');
  const row = await store.get('req-1');
  assert.equal(row?.status, 'claimed');
  assert.equal(row?.quotaScope, 'edit:tool-a');
  assert.equal(row?.quotaPeriod, 'hc-1');
  assert.equal(row?.instruction, 'change color');
});

test('setStatus transitions and countDone/listByTool scope by tool and time', async () => {
  const db = await freshDb();
  const store = createEditRequestStore(db);
  await store.claim({ requestId: 'req-1', toolId: 'tool-a', contractId: 'hc-1', instruction: 'a' });
  await store.claim({ requestId: 'req-2', toolId: 'tool-a', contractId: 'hc-1', instruction: 'b' });
  await store.claim({ requestId: 'req-3', toolId: 'tool-b', contractId: 'hc-2', instruction: 'c' });
  await store.setStatus('req-1', 'done');
  await store.setStatus('req-2', 'failed');
  await store.setStatus('req-3', 'done');

  assert.equal(await store.countDone('tool-a', '1970-01-01T00:00:00Z'), 1);
  assert.equal(await store.countDone('tool-b', '1970-01-01T00:00:00Z'), 1);

  const byTool = await store.listByTool('tool-a', '1970-01-01T00:00:00Z');
  assert.deepEqual(byTool.map((r) => r.requestId).sort(), ['req-1', 'req-2']);
});

test('listClaimedOlderThan returns only still-claimed rows for the tool older than the cutoff', async () => {
  const db = await freshDb();
  let ms = Date.UTC(2026, 0, 1, 0, 0, 0);
  const store = createEditRequestStore(db, () => new Date(ms));

  // req-1: claimed at t0 (stale), keeps its quota ref.
  await store.claim({ requestId: 'req-1', toolId: 'tool-a', contractId: 'hc-1', instruction: 'a' });
  await store.setQuotaRef('req-1', 'edit:tool-a', 'hc-1');
  // req-2: claimed at t0 (stale) but already advanced to 'done' — must be excluded.
  await store.claim({ requestId: 'req-2', toolId: 'tool-a', contractId: 'hc-1', instruction: 'b' });
  await store.setStatus('req-2', 'done');
  // req-3: a different tool — must be excluded even though it is stale + claimed.
  await store.claim({ requestId: 'req-3', toolId: 'tool-b', contractId: 'hc-2', instruction: 'c' });

  // Advance 40 minutes, then claim req-4 fresh (must be excluded by the 30-min cutoff).
  ms += 40 * 60_000;
  await store.claim({ requestId: 'req-4', toolId: 'tool-a', contractId: 'hc-1', instruction: 'd' });

  const cutoff = new Date(ms - 30 * 60_000).toISOString();
  const stale = await store.listClaimedOlderThan('tool-a', cutoff);
  assert.deepEqual(
    stale.map((r) => r.requestId),
    ['req-1'],
  );
  assert.equal(stale[0].contractId, 'hc-1');
  assert.equal(stale[0].instruction, 'a');
  assert.equal(stale[0].quotaScope, 'edit:tool-a');
  assert.equal(stale[0].quotaPeriod, 'hc-1');
});

// --- RelayStore ------------------------------------------------------------

test('ensure creates a fresh unverified relay; recipient change resets verification', async () => {
  const db = await freshDb();
  const store = createRelayStore(db);
  const created = await store.ensure('tool-a', 'buyer@example.com');
  assert.equal(created.created, true);
  assert.equal(created.verified, false);
  assert.match(created.token, /^[0-9a-f]{64}$/);
  assert.match(created.verifyToken, /^[0-9a-f]{64}$/);

  // Same recipient again: not created, stable tokens.
  const again = await store.ensure('tool-a', 'buyer@example.com');
  assert.equal(again.created, false);
  assert.equal(again.token, created.token);
  assert.equal(again.verifyToken, created.verifyToken);
  assert.equal(again.verified, false);

  // Recipient change resets verified and rotates verifyToken, but keeps the relay token stable.
  const changed = await store.ensure('tool-a', 'other@example.com');
  assert.equal(changed.created, false);
  assert.equal(changed.token, created.token);
  assert.notEqual(changed.verifyToken, created.verifyToken);
  assert.equal(changed.verified, false);
  const row = await store.get('tool-a');
  assert.equal(row?.recipient, 'other@example.com');
});

test('verifyByToken flips verified once and 404s a second use (rotated)', async () => {
  const db = await freshDb();
  const store = createRelayStore(db);
  const { verifyToken } = await store.ensure('tool-a', 'buyer@example.com');

  const result = await store.verifyByToken(verifyToken);
  assert.deepEqual(result, { toolId: 'tool-a' });
  const row = await store.get('tool-a');
  assert.equal(row?.verified, true);

  // Old verify token is dead: it was rotated on success.
  assert.equal(await store.verifyByToken(verifyToken), null);
  assert.equal(await store.verifyByToken('not-a-real-token'), null);
});

test('recordEvent + latestEvent scoped by kind', async () => {
  const db = await freshDb();
  const store = createRelayStore(db);
  await store.recordEvent({ toolId: 'tool-a', kind: 'verification', status: 'sent' });
  await store.recordEvent({ toolId: 'tool-a', kind: 'verification', status: 'confirmed' });
  await store.recordEvent({
    toolId: 'tool-a',
    kind: 'submission',
    messageId: 'm-1',
    status: 'delivered',
  });

  const latestVerification = await store.latestEvent('tool-a', 'verification');
  assert.equal(latestVerification?.status, 'confirmed');
  const latestSubmission = await store.latestEvent('tool-a', 'submission');
  assert.equal(latestSubmission?.messageId, 'm-1');
  assert.equal(await store.latestEvent('tool-a', 'test'), null);
});

test('pruneEvents deletes only rows older than the cutoff', async () => {
  let clock = new Date('2026-07-01T00:00:00Z');
  const db = await freshDb();
  const store = createRelayStore(db, () => clock);
  await store.recordEvent({ toolId: 'tool-a', kind: 'verification', status: 'old' });
  clock = new Date('2026-07-10T00:00:00Z');
  await store.recordEvent({ toolId: 'tool-a', kind: 'verification', status: 'new' });

  await store.pruneEvents(new Date('2026-07-05T00:00:00Z'));
  const { results } = await db
    .prepare('SELECT status FROM relay_events WHERE tool_id = ?')
    .bind('tool-a')
    .all<{ status: string }>();
  assert.deepEqual(
    results.map((r) => r.status),
    ['new'],
  );
});

// --- BuildLogStore ---------------------------------------------------------

test('append assigns sequential seq numbers per token; since() returns entries after afterSeq', async () => {
  const db = await freshDb();
  const store = createBuildLogStore(db);
  assert.equal(await store.append('tok-1', 'plan', 'planning'), 1);
  assert.equal(await store.append('tok-1', 'codegen', 'generating', { files: 3 }), 2);
  assert.equal(await store.append('tok-1', 'gate', 'checking'), 3);
  // A different token starts fresh at 1.
  assert.equal(await store.append('tok-2', 'plan', 'planning'), 1);

  const since = await store.since('tok-1', 1);
  assert.deepEqual(
    since.map((e) => e.seq),
    [2, 3],
  );
  assert.deepEqual(since[0]?.detail, { files: 3 });
  assert.equal(since[1]?.detail, null);
});

test('build log prune removes only entries older than the cutoff', async () => {
  let clock = new Date('2026-07-01T00:00:00Z');
  const db = await freshDb();
  const store = createBuildLogStore(db, () => clock);
  await store.append('tok-1', 'plan', 'old');
  clock = new Date('2026-07-10T00:00:00Z');
  await store.append('tok-1', 'gate', 'new');

  await store.prune(new Date('2026-07-05T00:00:00Z'));
  const remaining = await store.since('tok-1', 0);
  assert.deepEqual(
    remaining.map((e) => e.message),
    ['new'],
  );
});

// --- AuditStore --------------------------------------------------------------

test('audit record/listByScope round-trips detail JSON in insertion order', async () => {
  const db = await freshDb();
  const store = createAuditStore(db);
  await store.record({
    scope: 'tool:t1',
    gate: 'moderation',
    result: 'pass',
    detail: { vendor: 'openai' },
  });
  await store.record({ scope: 'tool:t1', gate: 'psi', result: 'fail' });
  await store.record({ scope: 'tool:t2', gate: 'moderation', result: 'pass' });

  const forT1 = await store.listByScope('tool:t1');
  assert.equal(forT1.length, 2);
  assert.equal(forT1[0]?.gate, 'moderation');
  assert.deepEqual(forT1[0]?.detail, { vendor: 'openai' });
  assert.equal(forT1[1]?.detail, null);
});

test('audit prune deletes only rows older than the cutoff', async () => {
  let clock = new Date('2026-07-01T00:00:00Z');
  const db = await freshDb();
  const store = createAuditStore(db, () => clock);
  await store.record({ scope: 'tool:t1', gate: 'moderation', result: 'pass' });
  clock = new Date('2026-07-10T00:00:00Z');
  await store.record({ scope: 'tool:t1', gate: 'psi', result: 'pass' });

  await store.prune(new Date('2026-07-05T00:00:00Z'));
  const remaining = await store.listByScope('tool:t1');
  assert.deepEqual(
    remaining.map((e) => e.gate),
    ['psi'],
  );
});

// --- Free functions: DLQ, abuse, reputation snapshot --------------------------

test('dlqDepth counts recorded DLQ arrivals', async () => {
  const db = await freshDb();
  assert.equal(await dlqDepth(db), 0);
  await recordDlqEvent(db, 'jobs-queue', { reason: 'max-retries' });
  await recordDlqEvent(db, 'jobs-queue', { reason: 'max-retries' });
  assert.equal(await dlqDepth(db), 2);
});

test('recordAbuse persists a row with slug + detail', async () => {
  const db = await freshDb();
  await recordAbuse(db, 'phishy-slug', 'contains blocked brand fragment');
  const { results } = await db
    .prepare('SELECT slug, detail FROM abuse_reports')
    .all<{ slug: string; detail: string }>();
  assert.equal(results.length, 1);
  assert.equal(results[0]?.slug, 'phishy-slug');
  assert.equal(results[0]?.detail, 'contains blocked brand fragment');
});

test('reputation snapshot cache upserts and reads back', async () => {
  const db = await freshDb();
  assert.equal(await loadReputationSnapshot(db), null);
  await saveReputationSnapshot(db, { reputationScore: 71, disputeRate: 0 });
  await saveReputationSnapshot(db, { reputationScore: 74, disputeRate: 0 });
  assert.deepEqual(await loadReputationSnapshot(db), { reputationScore: 74, disputeRate: 0 });
});
