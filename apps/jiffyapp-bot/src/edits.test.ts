// Thread-driven bounded edits (Task 22 / FR-14): parseEditInstruction's matrix and the
// pollEditRequests sweep step (claim → reserve → enqueue, or hold-and-prompt over quota),
// exercised over real D1-backed cycle/edit/usage/job stores with the thread reader, queue, and
// platform client as scripted fakes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import type { D1Like } from '@botguild/agent-core-workers';
import type { AgentClient } from '@botguild/agent-core';
import { applyMigrations } from './testSupport.js';
import {
  createCycleStore,
  createEditRequestStore,
  createJobStore,
  createUsageStore,
  jobKeyFor,
  sha256Hex,
} from './jobs.js';
import { EDITS_PER_CYCLE, ORPHAN_EDIT_CLAIM_MINUTES } from './config.js';
import type { ThreadMessage, ThreadReader } from './threads.js';
import type { QueueLike } from './pipeline.js';
import type { JobMessage } from './types.js';
import type { SweepServices } from './sweeps.js';
import { parseEditInstruction, pollEditRequests } from './edits.js';

const logger = createConsoleLogger({ service: 'test', level: 'silent' });
const BOT_ID = 'bot-jiffyapp';

// =============================================================================
// parseEditInstruction
// =============================================================================

test('parseEditInstruction: matrix of prefixes and remainders', () => {
  assert.equal(parseEditInstruction('edit: change headline to X'), 'change headline to X');
  assert.equal(parseEditInstruction('EDIT : make it blue'), 'make it blue');
  assert.equal(parseEditInstruction('  edit:trim leading space  '), 'trim leading space');
  assert.equal(parseEditInstruction('Edit:  padded  '), 'padded');
  // No prefix, or an unrelated word that merely starts with "edit".
  assert.equal(parseEditInstruction('please change the headline'), null);
  assert.equal(parseEditInstruction('editor: not an edit'), null);
  // Empty remainder.
  assert.equal(parseEditInstruction('edit:'), null);
  assert.equal(parseEditInstruction('edit:   '), null);
  assert.equal(parseEditInstruction(''), null);
});

// =============================================================================
// pollEditRequests harness
// =============================================================================

interface Harness {
  services: SweepServices;
  db: D1Like;
  cycles: ReturnType<typeof createCycleStore>;
  edits: ReturnType<typeof createEditRequestStore>;
  usage: ReturnType<typeof createUsageStore>;
  jobs: ReturnType<typeof createJobStore>;
  threadsByContract: Map<string, ThreadMessage[]>;
  queueSent: JobMessage[];
  messages: Array<{ contractId: string; content: string }>;
  setNow: (d: Date) => void;
  seedOpenCycle: (opts: {
    contractId: string;
    toolId: string;
    windowStart: string;
    windowEnd: string;
  }) => Promise<void>;
}

function makeClock(startIso: string): { now: () => Date; set: (d: Date) => void } {
  let ms = new Date(startIso).getTime();
  return {
    now: () => new Date(ms),
    set: (d: Date) => {
      ms = d.getTime();
    },
  };
}

async function makeHarness(startIso = '2026-01-25T00:00:00.000Z'): Promise<Harness> {
  const db = createMemoryD1();
  await applyMigrations(db);
  const clock = makeClock(startIso);

  const cycles = createCycleStore(db, clock.now);
  const edits = createEditRequestStore(db, clock.now);
  const usage = createUsageStore(db, clock.now);
  const jobs = createJobStore(db, clock.now);

  const threadsByContract = new Map<string, ThreadMessage[]>();
  const threadReader: ThreadReader = {
    async fetchContractMessages(contractId: string): Promise<ThreadMessage[]> {
      return threadsByContract.get(contractId) ?? [];
    },
  };

  const queueSent: JobMessage[] = [];
  const queue: QueueLike = {
    async send(msg: JobMessage): Promise<unknown> {
      queueSent.push(msg);
      return {};
    },
  };

  const messages: Array<{ contractId: string; content: string }> = [];
  const client = {
    async sendMessage(contractId: string, content: string): Promise<void> {
      messages.push({ contractId, content });
    },
  } as unknown as AgentClient;

  const services = {
    cycles,
    edits,
    usage,
    jobs,
    threadReader,
    queue,
    client,
    botId: BOT_ID,
    logger,
    now: clock.now,
  } as unknown as SweepServices;

  const seedOpenCycle: Harness['seedOpenCycle'] = async (opts) => {
    await cycles.create(opts);
  };

  return {
    services,
    db,
    cycles,
    edits,
    usage,
    jobs,
    threadsByContract,
    queueSent,
    messages,
    setNow: clock.set,
    seedOpenCycle,
  };
}

// =============================================================================
// pollEditRequests
// =============================================================================

test('pollEditRequests: a buyer edit on an open cycle is claimed, reserved (1/3), and enqueued', async () => {
  const h = await makeHarness();
  await h.seedOpenCycle({
    contractId: 'c-cyc-1',
    toolId: 'tool-1',
    windowStart: '2026-01-20T00:00:00.000Z',
    windowEnd: '2026-02-20T00:00:00.000Z',
  });
  h.threadsByContract.set('c-cyc-1', [
    { id: 'm1', botId: 'buyer-1', content: 'edit: change headline to X' },
  ]);

  await pollEditRequests(h.services);

  // The request row was claimed with its quota ref recorded.
  const req = await h.edits.get('m1');
  assert.equal(req?.status, 'claimed');
  assert.equal(req?.instruction, 'change headline to X');
  assert.equal(req?.quotaScope, 'edit:tool-1');
  assert.equal(req?.quotaPeriod, 'c-cyc-1');

  // Quota is 1/3 under period = the cycle contractId.
  assert.equal(await h.usage.getUsed('edit:tool-1', 'c-cyc-1'), 1);

  // An edit job was enqueued carrying the requestId.
  assert.equal(h.queueSent.length, 1);
  const hash = await sha256Hex('c-cyc-1');
  assert.deepEqual(h.queueSent[0], {
    kind: 'edit',
    contractId: 'c-cyc-1',
    jobKey: jobKeyFor(hash, 'edit:m1'),
    toolId: 'tool-1',
    requestId: 'm1',
  });
});

test('pollEditRequests: the same message on a second sweep is not re-claimed or re-enqueued', async () => {
  const h = await makeHarness();
  await h.seedOpenCycle({
    contractId: 'c-cyc-2',
    toolId: 'tool-2',
    windowStart: '2026-01-20T00:00:00.000Z',
    windowEnd: '2026-02-20T00:00:00.000Z',
  });
  h.threadsByContract.set('c-cyc-2', [
    { id: 'm1', botId: 'buyer-1', content: 'edit: make the button green' },
  ]);

  await pollEditRequests(h.services);
  await pollEditRequests(h.services);

  assert.equal(h.queueSent.length, 1); // no duplicate enqueue
  assert.equal(await h.usage.getUsed('edit:tool-2', 'c-cyc-2'), 1); // reserved exactly once
});

test('pollEditRequests: a 4th request in one cycle is HELD with exactly one prompt and no job', async () => {
  const h = await makeHarness();
  await h.seedOpenCycle({
    contractId: 'c-cyc-3',
    toolId: 'tool-3',
    windowStart: '2026-01-20T00:00:00.000Z',
    windowEnd: '2026-02-20T00:00:00.000Z',
  });
  h.threadsByContract.set('c-cyc-3', [
    { id: 'm1', botId: 'buyer-1', content: 'edit: one' },
    { id: 'm2', botId: 'buyer-1', content: 'edit: two' },
    { id: 'm3', botId: 'buyer-1', content: 'edit: three' },
    { id: 'm4', botId: 'buyer-1', content: 'edit: four' },
  ]);

  await pollEditRequests(h.services);

  // Three enqueued, quota maxed at EDITS_PER_CYCLE.
  assert.equal(h.queueSent.length, EDITS_PER_CYCLE);
  assert.equal(await h.usage.getUsed('edit:tool-3', 'c-cyc-3'), EDITS_PER_CYCLE);

  // The 4th is held, with exactly one hold reply and no job.
  assert.equal((await h.edits.get('m4'))?.status, 'held');
  assert.equal(h.queueSent.filter((m) => m.requestId === 'm4').length, 0);
  const holdReplies = h.messages.filter((m) => /HELD/i.test(m.content));
  assert.equal(holdReplies.length, 1);
});

test('pollEditRequests: quota is keyed to the contract, not the month — a 4th request stays held across a month boundary', async () => {
  const h = await makeHarness('2026-01-25T00:00:00.000Z');
  await h.seedOpenCycle({
    contractId: 'c-cyc-4',
    toolId: 'tool-4',
    windowStart: '2026-01-20T00:00:00.000Z',
    windowEnd: '2026-02-20T00:00:00.000Z', // a 30-day window straddling Feb 1
  });
  h.threadsByContract.set('c-cyc-4', [
    { id: 'm1', botId: 'buyer-1', content: 'edit: one' },
    { id: 'm2', botId: 'buyer-1', content: 'edit: two' },
    { id: 'm3', botId: 'buyer-1', content: 'edit: three' },
  ]);

  await pollEditRequests(h.services); // three in January
  assert.equal(h.queueSent.length, 3);

  // Advance past the calendar-month boundary and post a 4th — a month-keyed counter would reset
  // and wrongly grant it; the contract-keyed counter must still hold it.
  h.setNow(new Date('2026-02-05T00:00:00.000Z'));
  h.threadsByContract.set('c-cyc-4', [
    ...(h.threadsByContract.get('c-cyc-4') ?? []),
    { id: 'm4', botId: 'buyer-1', content: 'edit: four' },
  ]);

  await pollEditRequests(h.services);

  assert.equal((await h.edits.get('m4'))?.status, 'held');
  assert.equal(await h.usage.getUsed('edit:tool-4', 'c-cyc-4'), EDITS_PER_CYCLE);
  assert.equal(h.queueSent.filter((m) => m.requestId === 'm4').length, 0);
});

test('pollEditRequests: the bot own edit-shaped posts are ignored', async () => {
  const h = await makeHarness();
  await h.seedOpenCycle({
    contractId: 'c-cyc-5',
    toolId: 'tool-5',
    windowStart: '2026-01-20T00:00:00.000Z',
    windowEnd: '2026-02-20T00:00:00.000Z',
  });
  h.threadsByContract.set('c-cyc-5', [
    // The cycle-confirmation message the bot itself posts names "edit:" — must never be claimed.
    {
      id: 'm-bot',
      botId: BOT_ID,
      content: 'Post an edit request starting with "edit:" — 3 included.',
    },
  ]);

  await pollEditRequests(h.services);

  assert.equal(h.queueSent.length, 0);
  assert.equal(await h.edits.get('m-bot'), null);
  assert.equal(await h.usage.getUsed('edit:tool-5', 'c-cyc-5'), 0);
});

// =============================================================================
// Orphaned-edit-claim backstop (Task 23 / PART C)
// =============================================================================

const ORPHAN_START = '2026-01-25T00:00:00.000Z';
async function seedOrphanCycle(
  h: Harness,
  opts: { contractId: string; toolId: string },
): Promise<void> {
  await h.seedOpenCycle({
    contractId: opts.contractId,
    toolId: opts.toolId,
    windowStart: '2026-01-20T00:00:00.000Z',
    windowEnd: '2026-02-20T00:00:00.000Z',
  });
}

test('orphan backstop: a claimed+reserved request with no job row past the cutoff is re-enqueued once, not re-reserved', async () => {
  const h = await makeHarness(ORPHAN_START);
  await seedOrphanCycle(h, { contractId: 'c-orph-1', toolId: 'tool-o1' });
  // Simulate a crash between reserve/setQuotaRef and queue.send: the request reserved its slot
  // but never produced a job.
  await h.edits.claim({
    requestId: 'm-orph',
    toolId: 'tool-o1',
    contractId: 'c-orph-1',
    instruction: 'change headline',
  });
  await h.usage.reserve('edit:tool-o1', 'c-orph-1', EDITS_PER_CYCLE);
  await h.edits.setQuotaRef('m-orph', 'edit:tool-o1', 'c-orph-1');

  // Still fresh (< 30 min): the backstop leaves it alone.
  await pollEditRequests(h.services);
  assert.equal(h.queueSent.length, 0);

  // Past the cutoff: the backstop re-drives it exactly once.
  h.setNow(new Date(new Date(ORPHAN_START).getTime() + (ORPHAN_EDIT_CLAIM_MINUTES + 1) * 60_000));
  await pollEditRequests(h.services);
  assert.equal(h.queueSent.length, 1);
  assert.equal(h.queueSent[0].requestId, 'm-orph');
  assert.equal(h.queueSent[0].kind, 'edit');
  // Reservation was NOT doubled (it kept its existing slot).
  assert.equal(await h.usage.getUsed('edit:tool-o1', 'c-orph-1'), 1);

  // A subsequent sweep does not re-enqueue (the job row now exists).
  await pollEditRequests(h.services);
  assert.equal(h.queueSent.length, 1);
});

test('orphan backstop: a claimed request that never reserved is reserved then enqueued', async () => {
  const h = await makeHarness(ORPHAN_START);
  await seedOrphanCycle(h, { contractId: 'c-orph-2', toolId: 'tool-o2' });
  // Crash right after claim — no reservation, no quota ref.
  await h.edits.claim({
    requestId: 'm-orph2',
    toolId: 'tool-o2',
    contractId: 'c-orph-2',
    instruction: 'make it blue',
  });

  h.setNow(new Date(new Date(ORPHAN_START).getTime() + (ORPHAN_EDIT_CLAIM_MINUTES + 1) * 60_000));
  await pollEditRequests(h.services);

  assert.equal(h.queueSent.length, 1);
  assert.equal(h.queueSent[0].requestId, 'm-orph2');
  assert.equal(await h.usage.getUsed('edit:tool-o2', 'c-orph-2'), 1);
  const row = await h.edits.get('m-orph2');
  assert.equal(row?.quotaScope, 'edit:tool-o2');
  assert.equal(row?.quotaPeriod, 'c-orph-2');
});

test('orphan backstop: a request that already has a job row is not re-enqueued', async () => {
  const h = await makeHarness(ORPHAN_START);
  await seedOrphanCycle(h, { contractId: 'c-orph-3', toolId: 'tool-o3' });
  await h.edits.claim({
    requestId: 'm-orph3',
    toolId: 'tool-o3',
    contractId: 'c-orph-3',
    instruction: 'x',
  });
  await h.usage.reserve('edit:tool-o3', 'c-orph-3', EDITS_PER_CYCLE);
  await h.edits.setQuotaRef('m-orph3', 'edit:tool-o3', 'c-orph-3');
  // The job WAS enqueued — its row exists, so this is not orphaned.
  const hash = await sha256Hex('c-orph-3');
  await h.jobs.claim({
    jobKey: jobKeyFor(hash, 'edit:m-orph3'),
    contractId: 'c-orph-3',
    kind: 'edit',
    toolId: 'tool-o3',
  });

  h.setNow(new Date(new Date(ORPHAN_START).getTime() + (ORPHAN_EDIT_CLAIM_MINUTES + 1) * 60_000));
  await pollEditRequests(h.services);

  assert.equal(h.queueSent.length, 0);
});
