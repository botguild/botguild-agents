// Cron sweep layer (Task 20): maybePropose's classify→gate→propose matrix (including the
// §15 off-catalog-skip KPI), and the 15-minute sweep's parked-job re-enqueue / thread
// brief-correction steps. Real D1-backed stores (in-memory sqlite, migrations applied) with
// the platform client, thread reader, email-routing client, and queue as scripted fakes — the
// same harness shape as pipeline.test.ts, lighter since there's no browser/codegen surface here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import type { D1Like } from '@botguild/agent-core-workers';
import type { AgentClient, Gig, ProposalDraft } from '@botguild/agent-core';
import { applyMigrations } from './testSupport.js';
import {
  createAuditStore,
  createBuildLogStore,
  createCycleStore,
  createEditRequestStore,
  createJobStore,
  createRelayStore,
  createToolStore,
  createUsageStore,
  jobKeyFor,
  loadReputationSnapshot,
  sha256Hex,
} from './jobs.js';
import { createGigStore } from './gigStore.js';
import { getTemplate } from './templates/registry.js';
import { createJiffyProposer } from './proposer.js';
import type { ThreadMessage, ThreadReader } from './threads.js';
import type { EmailRoutingClient, QueueLike } from './pipeline.js';
import type { GoldenSet, JobKind, JobMessage } from './types.js';
import { maybePropose, runFifteenMinuteSweep, type SweepServices } from './sweeps.js';

const logger = createConsoleLogger({ service: 'test', level: 'silent' });
const BOT_ID = 'bot-jiffyapp';

// --- Gig fixture ---------------------------------------------------------------

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: 'gig-1',
    title: 'A gig',
    description: '',
    payerId: 'payer-1',
    payerName: 'Buyer',
    payerAvatar: '',
    category: 'Other',
    subcategory: '',
    deliverables: [],
    acceptanceCriteria: [],
    budget: 25,
    timeline: '3 days',
    urgency: 'medium',
    warrantyRequired: false,
    warrantyMinDuration: '',
    dataConstraints: [],
    status: 'open',
    proposalCount: 0,
    postedDate: '2026-01-01T00:00:00.000Z',
    tags: [],
    ...overrides,
  } as Gig;
}

const EXACT_CATEGORY = 'Web Development / Micro-tools'; // scorerConfig.categories[0]

const STUB_GOLDENS: GoldenSet = {
  goldens: [{ title: 'loads', steps: [], expect: [{ titleEquals: 'Rate Calc' }] }],
};

const STUB_DRAFT: ProposalDraft = {
  price: 25,
  timeline: '1 business day',
  milestones: [{ title: 'Milestone 1', duration: '1 business day', deliverables: ['a'] }],
  assumptions: [],
};

// --- Harness ---------------------------------------------------------------

interface Harness {
  db: D1Like;
  services: SweepServices;
  jobs: ReturnType<typeof createJobStore>;
  tools: ReturnType<typeof createToolStore>;
  relay: ReturnType<typeof createRelayStore>;
  gigsStore: ReturnType<typeof createGigStore>;
  audit: ReturnType<typeof createAuditStore>;
  submitProposalCalls: Array<{ gigId: string; draft: ProposalDraft }>;
  queueSent: JobMessage[];
  verifiedDestinations: Set<string>;
  threadsByContract: Map<string, ThreadMessage[]>;
  listGigs: { impl: () => Promise<Gig[]> };
  compileResult: {
    value:
      | { ok: true; set: GoldenSet; costUsd: number }
      | { ok: false; errors: string[]; costUsd: number };
  };
  claimAndPark(args: {
    contractId: string;
    kind: JobKind;
    toolId?: string;
    reason: string;
  }): Promise<string>;
}

async function makeHarness(): Promise<Harness> {
  const db = createMemoryD1();
  await applyMigrations(db);

  const jobs = createJobStore(db);
  const tools = createToolStore(db);
  const cycles = createCycleStore(db);
  const gigsStore = createGigStore(db);
  const edits = createEditRequestStore(db);
  const usage = createUsageStore(db);
  const relay = createRelayStore(db);
  const buildLog = createBuildLogStore(db);
  const audit = createAuditStore(db);

  const submitProposalCalls: Harness['submitProposalCalls'] = [];
  const listGigs: Harness['listGigs'] = { impl: async () => [] };
  const client = {
    async listGigs(): Promise<Gig[]> {
      return listGigs.impl();
    },
    async listProposals(): Promise<never[]> {
      return [];
    },
    async getGig(): Promise<Gig> {
      throw new Error('getGig: not scripted for this test');
    },
    async acceptCounter(): Promise<{ contractId: string }> {
      throw new Error('acceptCounter: not scripted for this test');
    },
    async counterProposal(): Promise<void> {
      throw new Error('counterProposal: not scripted for this test');
    },
    async declineCounter(): Promise<void> {},
    async submitProposal(gigId: string, draft: ProposalDraft): Promise<{ proposalId: string }> {
      submitProposalCalls.push({ gigId, draft });
      return { proposalId: `prop-${submitProposalCalls.length}` };
    },
    async sendMessage(): Promise<void> {},
  } as unknown as AgentClient;

  const compileResult: Harness['compileResult'] = {
    value: { ok: true, set: STUB_GOLDENS, costUsd: 0.05 },
  };
  const compiler = {
    async compile() {
      return compileResult.value;
    },
  };
  const baseProposer = {
    async generateProposal(): Promise<ProposalDraft> {
      return structuredClone(STUB_DRAFT);
    },
  };
  const proposer = createJiffyProposer({ base: baseProposer, compiler, gigs: gigsStore, logger });

  const costEstimator = {
    async estimate(): Promise<never> {
      throw new Error('costEstimator.estimate: not scripted for this test');
    },
  };

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

  const verifiedDestinations = new Set<string>();
  const emailRouting: EmailRoutingClient = {
    async ensureDestination(): Promise<void> {},
    async isDestinationVerified(email: string): Promise<boolean> {
      return verifiedDestinations.has(email);
    },
  };

  const reputationSource = {
    async getMyReputation() {
      return {
        handler: { handlerId: BOT_ID, reputationScore: 82, disputeRate: 0.01 },
        bots: [],
      };
    },
    async getMyEarnings() {
      return {
        summary: { funded: 0, released: 0, refunded: 0, fees: 0, balance: 0, transactionCount: 0 },
        transactions: [],
      };
    },
  };

  const negotiationStore = {
    async loadCounteredSet() {
      return new Set<string>();
    },
    async hydrate() {
      return {
        memory: {
          hasCountered: () => false,
          markCountered: () => {},
          clear: () => {},
        },
        flush: async () => {},
      };
    },
  };

  const services: SweepServices = {
    db,
    client,
    jobs,
    tools,
    cycles,
    gigs: gigsStore,
    edits,
    usage,
    relay,
    buildLog,
    audit,
    seen: { has: async () => false, add: async () => {} },
    negotiationStore,
    reputationSource,
    proposer,
    costEstimator,
    threadReader,
    queue,
    emailRouting,
    fetchImpl: (async () => {
      throw new Error('fetchImpl: not scripted for this test');
    }) as unknown as typeof fetch,
    botId: BOT_ID,
    publicBaseUrl: 'https://jiffyapp-bot.example.com',
    toolHostSuffix: 'jiffyapp.dev',
    logger,
    now: () => new Date('2026-01-02T00:00:00.000Z'),
  };

  const claimAndPark: Harness['claimAndPark'] = async ({ contractId, kind, toolId, reason }) => {
    const hash = await sha256Hex(contractId);
    const stage = kind === 'cycle' ? 'cycle' : kind === 'edit' ? 'edit' : 'build';
    const jobKey = jobKeyFor(hash, stage);
    await jobs.claim({ jobKey, contractId, kind, toolId });
    await jobs.park(jobKey, reason);
    return jobKey;
  };

  return {
    db,
    services,
    jobs,
    tools,
    relay,
    gigsStore,
    audit,
    submitProposalCalls,
    queueSent,
    verifiedDestinations,
    threadsByContract,
    listGigs,
    compileResult,
    claimAndPark,
  };
}

// =============================================================================
// maybePropose matrix
// =============================================================================

test('maybePropose: low-score gig with no keywords is skipped silently (no proposal, no audit)', async () => {
  const h = await makeHarness();
  const gig = makeGig({
    id: 'g-low',
    category: 'Pet Care',
    title: 'Plant watering',
    description: 'Please water my plants twice a week while I am away.',
  });

  await maybePropose(h.services, gig);

  assert.equal(h.submitProposalCalls.length, 0);
  assert.deepEqual(await h.audit.listByScope('gig:g-low'), []);
});

test('maybePropose: scored calculator gig with a valid fenced brief submits a proposal and persists goldens', async () => {
  const h = await makeHarness();
  const gig = makeGig({
    id: 'g-calc',
    category: EXACT_CATEGORY,
    title: 'Rate calculator',
    description:
      '```json\n{"template":"calculator","name":"Rate Calc","description":"Computes hourly rates by seniority."}\n```',
  });

  await maybePropose(h.services, gig);

  assert.equal(h.submitProposalCalls.length, 1);
  assert.equal(h.submitProposalCalls[0]?.gigId, 'g-calc');
  const row = await h.gigsStore.get('g-calc');
  assert.equal(row?.kind, 'build');
  assert.equal(row?.templateId, 'calculator');
  assert.deepEqual(row?.goldens, STUB_GOLDENS);
  assert.deepEqual(await h.audit.listByScope('gig:g-calc'), []);
});

test('maybePropose: off-catalog-but-scored gig records the off-catalog-skip KPI and proposes nothing', async () => {
  const h = await makeHarness();
  const gig = makeGig({
    id: 'g-offcat',
    category: 'Miscellaneous', // not scorerConfig.categories — relevance comes from keyword fallback
    title: 'Something for my website',
    description:
      '```json\n{"name":"Untitled small web tool","description":"A micro-app prototype for internal use; not sure which category this belongs to."}\n```',
  });

  await maybePropose(h.services, gig);

  assert.equal(h.submitProposalCalls.length, 0);
  const rows = await h.audit.listByScope('gig:g-offcat');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.gate, 'off-catalog-skip');
  assert.equal(rows[0]?.result, 'off-catalog');
});

test('maybePropose: scored prose gig with no fenced brief and no template match records no-brief KPI', async () => {
  const h = await makeHarness();
  const gig = makeGig({
    id: 'g-nobrief',
    category: 'Miscellaneous', // not scorerConfig.categories — relevance comes from keyword fallback
    title: 'Something for my website',
    description:
      'A micro-app prototype for internal use; this is a general web tool with no ' +
      'specific category yet, just a rough idea written out in plain prose.',
  });

  await maybePropose(h.services, gig);

  assert.equal(h.submitProposalCalls.length, 0);
  const rows = await h.audit.listByScope('gig:g-nobrief');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.gate, 'off-catalog-skip');
  assert.equal(rows[0]?.result, 'no-brief');
});

test('maybePropose: cycle gig with a known toolId proposes a hosting-cycle renewal', async () => {
  const h = await makeHarness();
  const def = getTemplate('calculator');
  await h.tools.create({
    toolId: 'tool-known-1',
    slugCandidates: ['known-tool'],
    templateId: 'calculator',
    templateVersion: def.version,
    buildContractId: 'c-build-1',
    name: 'Known Tool',
    brief: { name: 'Known Tool', description: 'd' },
    goldens: { goldens: [] },
  });
  const gig = makeGig({
    id: 'g-cycle',
    category: 'Anything',
    description: '```json\n{"toolId":"tool-known-1"}\n```',
  });

  await maybePropose(h.services, gig);

  assert.equal(h.submitProposalCalls.length, 1);
  const row = await h.gigsStore.get('g-cycle');
  assert.equal(row?.kind, 'cycle');
  assert.equal(row?.toolId, 'tool-known-1');
  assert.deepEqual(await h.audit.listByScope('gig:g-cycle'), []);
});

test('maybePropose: cycle gig with an unknown toolId records unknown-toolId and proposes nothing', async () => {
  const h = await makeHarness();
  const gig = makeGig({
    id: 'g-cycle-unknown',
    description: '```json\n{"toolId":"tool-missing-99"}\n```',
  });

  await maybePropose(h.services, gig);

  assert.equal(h.submitProposalCalls.length, 0);
  const rows = await h.audit.listByScope('gig:g-cycle-unknown');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.gate, 'unknown-toolId');
  assert.equal(rows[0]?.result, 'tool-missing-99');
});

// =============================================================================
// runFifteenMinuteSweep — parked re-enqueue + brief corrections + reputation
// =============================================================================

test('reenqueueParked re-sends exactly the parked moderation_outage/psi_outage jobs with reconstructed messages', async () => {
  const h = await makeHarness();
  const modKey = await h.claimAndPark({
    contractId: 'c-mod',
    kind: 'build',
    reason: 'moderation_outage',
  });
  const psiKey = await h.claimAndPark({ contractId: 'c-psi', kind: 'build', reason: 'psi_outage' });
  const cycleKey = await h.claimAndPark({
    contractId: 'c-cyc',
    kind: 'cycle',
    toolId: 'tool-xyz',
    reason: 'moderation_outage',
  });
  const untouchedKey = await h.claimAndPark({
    contractId: 'c-other',
    kind: 'build',
    reason: 'brief_invalid',
  });

  await runFifteenMinuteSweep(h.services);

  const byKey = new Map(h.queueSent.map((m) => [m.jobKey, m]));
  assert.deepEqual(byKey.get(modKey), {
    kind: 'build',
    contractId: 'c-mod',
    jobKey: modKey,
    toolId: undefined,
  });
  assert.deepEqual(byKey.get(psiKey), {
    kind: 'build',
    contractId: 'c-psi',
    jobKey: psiKey,
    toolId: undefined,
  });
  assert.deepEqual(byKey.get(cycleKey), {
    kind: 'cycle',
    contractId: 'c-cyc',
    jobKey: cycleKey,
    toolId: 'tool-xyz',
  });
  assert.equal(byKey.has(untouchedKey), false);

  assert.equal((await h.jobs.get(modKey))?.status, 'claimed');
  assert.equal((await h.jobs.get(psiKey))?.status, 'claimed');
  assert.equal((await h.jobs.get(cycleKey))?.status, 'claimed');
  assert.equal((await h.jobs.get(untouchedKey))?.status, 'parked');
});

test('reenqueueVerified leaves the job parked when only the relay token side is verified', async () => {
  const h = await makeHarness();
  const def = getTemplate('form');
  await h.tools.create({
    toolId: 'tool-relay-1',
    slugCandidates: ['relay-tool'],
    templateId: 'form',
    templateVersion: def.version,
    buildContractId: 'c-relay-1',
    name: 'Relay Tool',
    brief: { name: 'Relay Tool', description: 'd', notifyEmail: 'owner@example.com' },
    goldens: { goldens: [] },
  });
  const { verifyToken } = await h.relay.ensure('tool-relay-1', 'owner@example.com');
  await h.relay.verifyByToken(verifyToken); // bot-side (relay.verified) flips true
  // emailRouting side deliberately NOT marked verified.

  const jobKey = await h.claimAndPark({
    contractId: 'c-relay-1',
    kind: 'build',
    reason: 'awaiting_verification',
  });

  await runFifteenMinuteSweep(h.services);

  assert.equal(
    h.queueSent.some((m) => m.jobKey === jobKey),
    false,
  );
  assert.equal((await h.jobs.get(jobKey))?.status, 'parked');
});

test('reenqueueVerified unparks and sends once BOTH the relay token and email-routing sides verify', async () => {
  const h = await makeHarness();
  const def = getTemplate('form');
  await h.tools.create({
    toolId: 'tool-relay-2',
    slugCandidates: ['relay-tool-2'],
    templateId: 'form',
    templateVersion: def.version,
    buildContractId: 'c-relay-2',
    name: 'Relay Tool 2',
    brief: { name: 'Relay Tool 2', description: 'd', notifyEmail: 'owner2@example.com' },
    goldens: { goldens: [] },
  });
  const { verifyToken } = await h.relay.ensure('tool-relay-2', 'owner2@example.com');
  await h.relay.verifyByToken(verifyToken);
  h.verifiedDestinations.add('owner2@example.com');

  const jobKey = await h.claimAndPark({
    contractId: 'c-relay-2',
    kind: 'build',
    reason: 'awaiting_verification',
  });

  await runFifteenMinuteSweep(h.services);

  assert.equal(
    h.queueSent.some((m) => m.jobKey === jobKey),
    true,
  );
  assert.equal((await h.jobs.get(jobKey))?.status, 'claimed');
});

test('pollBriefCorrections applies the newest non-bot correction, updates the brief, and re-enqueues', async () => {
  const h = await makeHarness();
  const jobKey = await h.claimAndPark({
    contractId: 'c-brief-1',
    kind: 'build',
    reason: 'brief_invalid',
  });
  h.threadsByContract.set('c-brief-1', [
    {
      id: 'm1',
      botId: BOT_ID,
      content:
        'The brief could not be validated: name required. Please reply with a corrected brief.',
    },
    {
      id: 'm2',
      botId: 'buyer-1',
      content: '```json\n{"name":"Fixed Name","description":"Fixed description text."}\n```',
    },
    // Newest message is another bot post (an ack) — must be skipped so the buyer's
    // correction just before it is still the one picked up.
    { id: 'm3', botId: BOT_ID, content: 'Thanks — resuming the build shortly.' },
  ]);

  await runFifteenMinuteSweep(h.services);

  const row = await h.jobs.get(jobKey);
  assert.equal(row?.status, 'claimed');
  assert.deepEqual(row?.brief, { name: 'Fixed Name', description: 'Fixed description text.' });
  assert.equal(
    h.queueSent.some((m) => m.jobKey === jobKey),
    true,
  );
});

test('pollBriefCorrections leaves the job parked when no message parses as a corrected brief', async () => {
  const h = await makeHarness();
  const jobKey = await h.claimAndPark({
    contractId: 'c-brief-2',
    kind: 'build',
    reason: 'brief_invalid',
  });
  h.threadsByContract.set('c-brief-2', [
    { id: 'm1', botId: 'buyer-1', content: 'Still working on it, will send details soon.' },
  ]);

  await runFifteenMinuteSweep(h.services);

  const row = await h.jobs.get(jobKey);
  assert.equal(row?.status, 'parked');
  assert.equal(
    h.queueSent.some((m) => m.jobKey === jobKey),
    false,
  );
});

// Note: a plain `listGigs` failure does NOT exercise step isolation — runGigPollSweep
// catches it internally (pollSweep.ts) and returns an empty result, so step 1's own
// try/catch in runFifteenMinuteSweep is never reached. The two tests below use failures
// that genuinely escape their step, to prove runFifteenMinuteSweep's per-step try/catch
// is what's doing the isolating.

test('sweep-step isolation: a seen-store failure escapes runGigPollSweep uncaught and is caught by step 1s own try/catch; later steps still run', async () => {
  const h = await makeHarness();
  // seen.has is called OUTSIDE runGigPollSweep's per-gig try/catch (pollSweep.ts), so a
  // throw here propagates all the way out of runGigPollSweep itself.
  h.listGigs.impl = async () => [makeGig({ id: 'g-seen-boom' })];
  h.services.seen.has = async () => {
    throw new Error('seen.has: simulated KV outage');
  };

  await runFifteenMinuteSweep(h.services);

  assert.equal(h.submitProposalCalls.length, 0); // never reached onGig

  const snapshot = await loadReputationSnapshot(h.db);
  assert.equal((snapshot as { reputationScore: number } | null)?.reputationScore, 82);
  assert.equal((snapshot as { disputeRate: number } | null)?.disputeRate, 0.01);
});

test('sweep-step isolation: a jobs.listParked failure escapes reenqueueParked (step 3) uncaught; step 5s brief-correction still runs and step 7s reputation snapshot still saves', async () => {
  const h = await makeHarness();

  // A moderation_outage-parked job step 3 would normally re-enqueue — reenqueueParked
  // has no internal try/catch, so a throw from listParked propagates straight out of it.
  const modKey = await h.claimAndPark({
    contractId: 'c-mod-boom',
    kind: 'build',
    reason: 'moderation_outage',
  });

  // A brief_invalid-parked job step 5 (pollBriefCorrections) should still pick up and
  // correct, proving step 3's throw didn't take the rest of the sweep down with it.
  const briefKey = await h.claimAndPark({
    contractId: 'c-brief-still-runs',
    kind: 'build',
    reason: 'brief_invalid',
  });
  h.threadsByContract.set('c-brief-still-runs', [
    {
      id: 'm1',
      botId: 'buyer-1',
      content: '```json\n{"name":"Fixed Name","description":"Fixed description text."}\n```',
    },
  ]);

  const originalListParked = h.jobs.listParked;
  h.services.jobs.listParked = async (reason?: string) => {
    if (reason === 'moderation_outage' || reason === 'psi_outage') {
      throw new Error('listParked: simulated D1 outage');
    }
    return originalListParked(reason);
  };

  await runFifteenMinuteSweep(h.services);

  // Step 3 blew up before ever unparking/sending the moderation_outage job.
  assert.equal(
    h.queueSent.some((m) => m.jobKey === modKey),
    false,
  );
  assert.equal((await h.jobs.get(modKey))?.status, 'parked');

  // Step 5 still ran and applied the correction despite step 3's throw.
  const briefRow = await h.jobs.get(briefKey);
  assert.equal(briefRow?.status, 'claimed');
  assert.deepEqual(briefRow?.brief, { name: 'Fixed Name', description: 'Fixed description text.' });
  assert.equal(
    h.queueSent.some((m) => m.jobKey === briefKey),
    true,
  );

  // Step 7 still saved the reputation snapshot.
  const snapshot = await loadReputationSnapshot(h.db);
  assert.equal((snapshot as { reputationScore: number } | null)?.reputationScore, 82);
  assert.equal((snapshot as { disputeRate: number } | null)?.disputeRate, 0.01);
});
