import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import type { D1Like } from '@botguild/agent-core-workers';
import { applyMigrations } from './testSupport.js';
import {
  buildJobKey,
  createConceptStore,
  createJobStore,
  createQuotaStore,
  createSelectionStore,
  decideOnConflict,
  randomDeliverableToken,
} from './jobs.js';

let db: D1Like;
beforeEach(async () => {
  db = createMemoryD1();
  await applyMigrations(db);
});

describe('buildJobKey', () => {
  it('produces a distinct key per stage for the same contract', async () => {
    const concepts = await buildJobKey('c1', 'concepts');
    const vector = await buildJobKey('c1', 'vector');
    assert.notEqual(concepts, vector);
    assert.ok(concepts.endsWith(':concepts'));
    assert.ok(vector.endsWith(':vector'));
  });

  it('is stable across calls', async () => {
    assert.equal(await buildJobKey('c1', 'concepts'), await buildJobKey('c1', 'concepts'));
  });
});

describe('randomDeliverableToken', () => {
  it('is 64 hex characters and not derived from anything', () => {
    const a = randomDeliverableToken();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, randomDeliverableToken());
  });
});

describe('decideOnConflict', () => {
  it('re-enqueues a bare claim whose queue send may have been lost', () => {
    assert.deepEqual(decideOnConflict({ status: 'claimed', checkpoint: null }), {
      action: 'enqueue',
      reason: 'claimed-not-checkpointed',
    });
  });

  it('skips delivered, parked, in-progress, and checkpointed jobs', () => {
    assert.equal(decideOnConflict({ status: 'delivered', checkpoint: null }).action, 'skip');
    assert.equal(decideOnConflict({ status: 'parked', checkpoint: null }).action, 'skip');
    assert.equal(decideOnConflict({ status: 'in_progress', checkpoint: null }).action, 'skip');
    assert.equal(
      decideOnConflict({ status: 'claimed', checkpoint: { slots: [], spendUsd: 0 } }).action,
      'skip',
    );
  });
});

describe('JobStore', () => {
  it('claims once and re-enqueues on a redelivered webhook', async () => {
    const jobs = createJobStore(db);
    const key = await buildJobKey('c1', 'concepts');
    assert.deepEqual(await jobs.claim(key, 'c1', 'concepts'), {
      action: 'enqueue',
      reason: 'fresh-claim',
    });
    assert.deepEqual(await jobs.claim(key, 'c1', 'concepts'), {
      action: 'enqueue',
      reason: 'claimed-not-checkpointed',
    });
  });

  it('lets both stages of one contract claim independently', async () => {
    const jobs = createJobStore(db);
    const a = await jobs.claim(await buildJobKey('c1', 'concepts'), 'c1', 'concepts');
    const b = await jobs.claim(await buildJobKey('c1', 'vector'), 'c1', 'vector');
    assert.equal(a.action, 'enqueue');
    assert.equal(b.action, 'enqueue');
  });

  it('does not re-enqueue once the consumer has started', async () => {
    const jobs = createJobStore(db);
    const key = await buildJobKey('c1', 'concepts');
    await jobs.claim(key, 'c1', 'concepts');
    await jobs.setInProgress(key, { kind: 'logo', gigId: 'g1', payerId: 'p1', briefJson: '{}' });
    assert.equal((await jobs.claim(key, 'c1', 'concepts')).action, 'skip');
  });

  it('resumes spend from the checkpoint rather than restarting it', async () => {
    const jobs = createJobStore(db);
    const key = await buildJobKey('c1', 'concepts');
    await jobs.claim(key, 'c1', 'concepts');
    await jobs.saveCheckpoint(key, { slots: [], spendUsd: 1.75 });
    const row = await jobs.get(key);
    assert.equal(row?.spentUsd, 1.75);
    assert.equal(row?.checkpoint?.spendUsd, 1.75);
  });

  it('finds a job by its deliverable token', async () => {
    const jobs = createJobStore(db);
    const key = await buildJobKey('c1', 'concepts');
    await jobs.claim(key, 'c1', 'concepts');
    const token = (await jobs.get(key))!.deliverableToken!;
    assert.equal((await jobs.getByToken(token))?.jobKey, key);
    assert.equal(await jobs.getByToken('0'.repeat(64)), null);
  });

  it('parks, unparks, and lists parked jobs by reason', async () => {
    const jobs = createJobStore(db);
    const key = await buildJobKey('c1', 'concepts');
    await jobs.claim(key, 'c1', 'concepts');
    await jobs.park(key, 'moderation_outage');
    assert.equal((await jobs.listParked('moderation_outage')).length, 1);
    await jobs.unpark(key);
    assert.equal((await jobs.listParked()).length, 0);
  });

  it('lists stuck claims older than the cutoff with no checkpoint', async () => {
    const past = new Date('2026-07-30T00:00:00.000Z');
    const jobs = createJobStore(db, () => past);
    await jobs.claim(await buildJobKey('c1', 'concepts'), 'c1', 'concepts');
    assert.equal((await jobs.listStuckClaims(new Date('2026-07-30T01:00:00.000Z'))).length, 1);
    assert.equal((await jobs.listStuckClaims(new Date('2026-07-29T00:00:00.000Z'))).length, 0);
  });

  it('records gate audit entries', async () => {
    const jobs = createJobStore(db);
    await jobs.recordGateAudit({
      jobKey: 'k',
      contractId: 'c1',
      slot: 2,
      gate: 'ocr',
      result: 'fail',
      detail: { score: 0.4 },
    });
    const row = await db
      .prepare('SELECT gate, result, detail_json FROM gate_audit WHERE job_key = ?')
      .bind('k')
      .first<{ gate: string; result: string; detail_json: string }>();
    assert.equal(row?.gate, 'ocr');
    assert.deepEqual(JSON.parse(row!.detail_json), { score: 0.4 });
  });

  it('reads the audit trail back in insert order, with detail already parsed', async () => {
    const jobs = createJobStore(db);
    await jobs.recordGateAudit({ jobKey: 'k', gate: 'moderation', result: 'unavailable' });
    await jobs.recordGateAudit({
      jobKey: 'k',
      contractId: 'c1',
      gate: 'moderation',
      result: 'clear',
      detail: { flagged: false, response: { id: 'modr-1' } },
    });
    await jobs.recordGateAudit({ jobKey: 'other', gate: 'moderation', result: 'clear' });

    const trail = await jobs.listGateAudit('k');
    assert.deepEqual(
      trail.map((row) => row.result),
      ['unavailable', 'clear'],
      'oldest first, and scoped to the job asked for',
    );
    // `created_at` has one-second resolution and these rows land in the same
    // tick, so "which was last" can only come from insert order.
    assert.ok(trail[0]!.id < trail[1]!.id);
    assert.deepEqual(trail[1]!.detail, { flagged: false, response: { id: 'modr-1' } });
    assert.equal(trail[0]!.detail, null, 'an entry written without a detail reads back as null');
    assert.equal(trail[1]!.contractId, 'c1');
  });

  it('narrows the audit trail to one gate on request', async () => {
    const jobs = createJobStore(db);
    await jobs.recordGateAudit({ jobKey: 'k', gate: 'moderation', result: 'clear' });
    await jobs.recordGateAudit({ jobKey: 'k', gate: 'ocr', result: 'fail', detail: { s: 1 } });

    // Precondition: the unfiltered read sees both, so the filter below is
    // narrowing something rather than querying an already-empty trail.
    assert.equal((await jobs.listGateAudit('k')).length, 2);
    const moderation = await jobs.listGateAudit('k', 'moderation');
    assert.deepEqual(
      moderation.map((row) => row.gate),
      ['moderation'],
    );
  });

  it('degrades a corrupted detail column to null instead of throwing', async () => {
    // One row damaged after the fact must not take down a whole report build.
    const jobs = createJobStore(db);
    await jobs.recordGateAudit({
      jobKey: 'k',
      gate: 'moderation',
      result: 'clear',
      detail: { a: 1 },
    });
    await db
      .prepare('UPDATE gate_audit SET detail_json = ? WHERE job_key = ?')
      .bind('{not json', 'k')
      .run();

    const trail = await jobs.listGateAudit('k');
    assert.equal(trail.length, 1);
    assert.equal(trail[0]!.detail, null);
  });
});

describe('ConceptStore', () => {
  it('upserts a slot and lists concepts in slot order', async () => {
    const concepts = createConceptStore(db);
    await concepts.upsert({
      contractId: 'c1',
      slot: 2,
      axisId: 'lockup',
      vendor: 'recraft',
      ocrPass: true,
      ocrScore: 0.95,
    });
    await concepts.upsert({
      contractId: 'c1',
      slot: 1,
      axisId: 'wordmark',
      vendor: 'ideogram',
      ocrPass: false,
      ocrScore: 0.4,
    });
    const rows = await concepts.list('c1');
    assert.deepEqual(
      rows.map((r) => r.slot),
      [1, 2],
    );
  });

  it('overwrites a slot on regeneration rather than duplicating it', async () => {
    const concepts = createConceptStore(db);
    await concepts.upsert({
      contractId: 'c1',
      slot: 1,
      axisId: 'a',
      vendor: 'ideogram',
      ocrScore: 0.4,
    });
    await concepts.upsert({
      contractId: 'c1',
      slot: 1,
      axisId: 'a',
      vendor: 'ideogram',
      ocrScore: 0.9,
    });
    const rows = await concepts.list('c1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.ocrScore, 0.9);
  });

  it('lists only passing concepts, best OCR score first', async () => {
    const concepts = createConceptStore(db);
    await concepts.upsert({
      contractId: 'c1',
      slot: 1,
      axisId: 'a',
      vendor: 'v',
      ocrPass: true,
      ocrScore: 0.9,
    });
    await concepts.upsert({
      contractId: 'c1',
      slot: 2,
      axisId: 'b',
      vendor: 'v',
      ocrPass: false,
      ocrScore: 0.99,
    });
    await concepts.upsert({
      contractId: 'c1',
      slot: 3,
      axisId: 'c',
      vendor: 'v',
      ocrPass: true,
      ocrScore: 0.95,
    });
    const passing = await concepts.listPassing('c1');
    assert.deepEqual(
      passing.map((r) => r.slot),
      [3, 1],
    );
  });
});

describe('SelectionStore', () => {
  it('walks concepts_delivered → winner_selected → pack_delivered', async () => {
    const selection = createSelectionStore(db);
    await selection.open('c1');
    assert.equal((await selection.get('c1'))?.state, 'concepts_delivered');
    await selection.select('c1', 2, 'buyer');
    const selected = await selection.get('c1');
    assert.equal(selected?.state, 'winner_selected');
    assert.equal(selected?.winnerSlot, 2);
    assert.equal(selected?.source, 'buyer');
    await selection.markPackDelivered('c1');
    assert.equal((await selection.get('c1'))?.state, 'pack_delivered');
  });

  it('does not let a late buyer reply overwrite a default selection', async () => {
    const selection = createSelectionStore(db);
    await selection.open('c1');
    await selection.select('c1', 1, 'default');
    await selection.select('c1', 3, 'buyer');
    const row = await selection.get('c1');
    assert.equal(row?.winnerSlot, 1);
    assert.equal(row?.source, 'default');
  });

  it('lists contracts still awaiting selection past the cutoff', async () => {
    const past = new Date('2026-07-30T00:00:00.000Z');
    const selection = createSelectionStore(db, () => past);
    await selection.open('c1');
    const due = await selection.listAwaitingSelection(new Date('2026-08-02T01:00:00.000Z'));
    assert.deepEqual(
      due.map((r) => r.contractId),
      ['c1'],
    );
    assert.equal((await selection.listAwaitingSelection(past)).length, 0);
  });
});

describe('QuotaStore', () => {
  /** Roomy limits: these tests are about counting, not about the cap. */
  const ROOMY = { windowDays: 30, maxPerPayer: 100 };

  it("counts a payer's free gigs inside the rolling window", async () => {
    const quota = createQuotaStore(db, () => new Date('2026-07-30T00:00:00.000Z'));
    assert.equal(await quota.consume('p1', 'favicon', 'c1', ROOMY), true);
    assert.equal(await quota.consume('p1', 'taster', 'c2', ROOMY), true);
    assert.equal(await quota.consume('p2', 'favicon', 'c3', ROOMY), true);
    assert.equal(await quota.countRecent('p1', 30), 2);
    assert.equal(await quota.countRecent('p2', 30), 1);
    assert.equal(await quota.countRecent('p3', 30), 0);
  });

  it('excludes usage older than the window', async () => {
    let now = new Date('2026-06-01T00:00:00.000Z');
    const quota = createQuotaStore(db, () => now);
    await quota.consume('p1', 'favicon', 'c1', ROOMY);
    now = new Date('2026-07-30T00:00:00.000Z');
    assert.equal(await quota.countRecent('p1', 30), 0);
  });

  it('enforces the cap in the INSERT, so a stale count cannot buy a slot', async () => {
    // The read-then-write this replaced was defeated by concurrency: every job
    // that read the count before anyone wrote passed. Here the cap lives in the
    // statement, so a caller holding an arbitrarily stale count still cannot
    // get a row past it.
    const quota = createQuotaStore(db);
    const limits = { windowDays: 30, maxPerPayer: 3 };
    const staleCount = await quota.countRecent('p1', 30);
    assert.equal(staleCount, 0);

    const granted: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      granted.push(await quota.consume('p1', 'taster', `c-${i}`, limits));
    }
    assert.deepEqual(granted, [true, true, true, false, false, false]);
    assert.equal(await quota.countRecent('p1', 30), 3);
  });

  it('is idempotent per contract, so a retry never takes a second slot', async () => {
    const quota = createQuotaStore(db);
    const limits = { windowDays: 30, maxPerPayer: 3 };
    assert.equal(await quota.holdsAllowance('c1'), false);
    assert.equal(await quota.consume('p1', 'favicon', 'c1', limits), true);
    assert.equal(await quota.holdsAllowance('c1'), true);

    // Same contract, three more times: still one row, still granted.
    for (let i = 0; i < 3; i++) {
      assert.equal(await quota.consume('p1', 'favicon', 'c1', limits), true);
    }
    assert.equal(await quota.countRecent('p1', 30), 1);
  });

  it('keeps granting a contract that already holds a slot even once the payer is at the cap', async () => {
    // The C2 property, at the store level: an allowance belongs to the job that
    // took it. Without this a parked-and-resumed job is refused by its own row.
    const quota = createQuotaStore(db);
    const limits = { windowDays: 30, maxPerPayer: 3 };
    assert.equal(await quota.consume('p1', 'taster', 'mine', limits), true);
    assert.equal(await quota.consume('p1', 'taster', 'other-1', limits), true);
    assert.equal(await quota.consume('p1', 'taster', 'other-2', limits), true);
    assert.equal(await quota.countRecent('p1', 30), limits.maxPerPayer);

    assert.equal(await quota.consume('p1', 'taster', 'newcomer', limits), false);
    assert.equal(await quota.consume('p1', 'taster', 'mine', limits), true);
  });
});
