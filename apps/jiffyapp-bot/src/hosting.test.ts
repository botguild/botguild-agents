// Hosting lifecycle (Task 21): cycle jobs, grace → suspend → revive, and month-end service
// reports, exercised over real D1-backed stores (in-memory sqlite, migrations applied). A
// lighter local harness than pipeline.test.ts's `makeHarness` — hosting.ts never touches the
// browser/codegen/deploy surface, so those PipelineConfig fields are unused throwing stubs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import type { D1Like } from '@botguild/agent-core-workers';
import type { Contract } from '@botguild/agent-core';
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
  sha256Hex,
} from './jobs.js';
import { createGigStore } from './gigStore.js';
import { getTemplate } from './templates/registry.js';
import type { PipelineClient, PipelineConfig } from './pipeline.js';
import type { SweepServices } from './sweeps.js';
import { runDailySweep } from './sweeps.js';
import { deliverCycleReports, processCycleJob, sweepHostingExpiry } from './hosting.js';
import {
  BUILD_LOG_RETENTION_DAYS,
  GRACE_DAYS,
  HOSTING_WINDOW_DAYS,
  STUCK_CLAIM_MINUTES,
} from './config.js';
import type { GoldenSet, JiffyBrief, JobMessage, ToolStatus } from './types.js';

const logger = createConsoleLogger({ service: 'test', level: 'silent' });
const PUBLIC_BASE_URL = 'https://jiffyapp-bot.example.com';
const TOOL_HOST_SUFFIX = 'jiffyapp.dev';
const DAY_MS = 86_400_000;

const BRIEF: JiffyBrief = {
  template: 'calculator',
  name: 'Rate Estimator',
  description: 'A rate estimator that totals hours by seniority.',
};
const GOLDENS: GoldenSet = {
  goldens: [{ title: 'headline renders', steps: [], expect: [{ titleEquals: 'Rate Estimator' }] }],
};

// --- Clock -------------------------------------------------------------------

interface Clock {
  now: () => Date;
  advance: (deltaMs: number) => void;
  set: (d: Date) => void;
}
function makeClock(startMs = Date.UTC(2026, 0, 1, 0, 0, 0)): Clock {
  let ms = startMs;
  return {
    now: () => new Date(ms),
    advance: (deltaMs) => {
      ms += deltaMs;
    },
    set: (d) => {
      ms = d.getTime();
    },
  };
}

// --- Harness -----------------------------------------------------------------

interface Harness {
  cfg: PipelineConfig;
  sweep: SweepServices;
  clock: Clock;
  db: D1Like;
  stores: {
    jobs: ReturnType<typeof createJobStore>;
    tools: ReturnType<typeof createToolStore>;
    cycles: ReturnType<typeof createCycleStore>;
    edits: ReturnType<typeof createEditRequestStore>;
    relay: ReturnType<typeof createRelayStore>;
    buildLog: ReturnType<typeof createBuildLogStore>;
    audit: ReturnType<typeof createAuditStore>;
  };
  messages: Array<{ contractId: string; content: string }>;
  queueSent: JobMessage[];
  deliverMilestoneCalls: Array<{ contractId: string; milestoneId: string; note: string }>;
  contracts: Map<string, Contract>;
  fetchStatuses: number[];
  fetchThrowNext: { value: boolean };
  fetchCalls: string[];
  seedTool: (opts: {
    toolId: string;
    slug: string;
    hostedUntil: string;
    buildContractId?: string;
    status?: ToolStatus;
    graceStartedAt?: Date;
    latestHostingContractId?: string;
  }) => Promise<void>;
  claimCycleJob: (opts: {
    contractId: string;
    toolId?: string;
  }) => Promise<{ jobKey: string; msg: JobMessage & { kind: 'cycle' } }>;
}

async function makeHarness(): Promise<Harness> {
  const db = createMemoryD1();
  await applyMigrations(db);
  const clock = makeClock();

  const jobs = createJobStore(db, clock.now);
  const tools = createToolStore(db, clock.now);
  const gigs = createGigStore(db, clock.now);
  const cycles = createCycleStore(db, clock.now);
  const usage = createUsageStore(db, clock.now);
  const edits = createEditRequestStore(db, clock.now);
  const relay = createRelayStore(db, clock.now);
  const buildLog = createBuildLogStore(db, clock.now);
  const audit = createAuditStore(db, clock.now);

  const contracts = new Map<string, Contract>();
  const messages: Harness['messages'] = [];
  const deliverMilestoneCalls: Harness['deliverMilestoneCalls'] = [];
  const client: PipelineClient = {
    async getContract(contractId: string): Promise<Contract> {
      const c = contracts.get(contractId);
      if (!c) throw new Error(`no fake contract for ${contractId}`);
      return c;
    },
    async getGig(): Promise<never> {
      throw new Error('getGig: not scripted for this test');
    },
    async sendMessage(contractId: string, content: string): Promise<void> {
      messages.push({ contractId, content });
    },
    async deliverMilestone(contractId, milestoneId, payload): Promise<void> {
      deliverMilestoneCalls.push({ contractId, milestoneId, note: payload.note });
    },
  };

  const queueSent: JobMessage[] = [];
  const queue = {
    async send(msg: JobMessage): Promise<unknown> {
      queueSent.push(msg);
      return {};
    },
  };

  const fetchStatuses: number[] = [];
  const fetchThrowNext = { value: false };
  const fetchCalls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    fetchCalls.push(String(input));
    if (fetchThrowNext.value) {
      fetchThrowNext.value = false;
      throw new Error('fetch failed (simulated)');
    }
    return new Response('', { status: fetchStatuses.shift() ?? 200 });
  }) as unknown as typeof fetch;

  const emailRouting = {
    async ensureDestination(): Promise<void> {},
    async isDestinationVerified(): Promise<boolean> {
      return false;
    },
  };

  const cfg: PipelineConfig = {
    jobs,
    tools,
    gigs,
    cycles,
    usage,
    edits,
    relay,
    buildLog,
    audit,
    client,
    codegen: {
      async generate(): Promise<never> {
        throw new Error('codegen: not scripted for this test');
      },
    },
    deployer: {
      async putScript(): Promise<void> {
        throw new Error('deployer.putScript: not scripted for this test');
      },
      async deleteScript(): Promise<void> {},
      async checkServes(): Promise<never> {
        throw new Error('deployer.checkServes: not scripted for this test');
      },
    },
    compiler: {
      async compile(): Promise<never> {
        throw new Error('compiler: not scripted for this test');
      },
      async recompileForEdit(): Promise<never> {
        throw new Error('recompileForEdit: not scripted for this test');
      },
    },
    emailRouting,
    openPage: async () => {
      throw new Error('openPage: not scripted for this test');
    },
    closeBrowser: async () => {},
    psi: {
      async run(): Promise<never> {
        throw new Error('psi: not scripted for this test');
      },
    },
    moderation: {
      async moderate(): Promise<never> {
        throw new Error('moderation.moderate: not scripted for this test');
      },
      async moderateImage(): Promise<never> {
        throw new Error('moderation.moderateImage: not scripted for this test');
      },
    },
    mailer: {
      async send(): Promise<never> {
        throw new Error('mailer: not scripted for this test');
      },
    },
    deliverables: {
      async put(): Promise<void> {
        throw new Error('deliverables: not scripted for this test');
      },
    },
    queue,
    fetchImpl,
    publicBaseUrl: PUBLIC_BASE_URL,
    toolHostSuffix: TOOL_HOST_SUFFIX,
    relayFromAddress: 'forms@jiffyapp.dev',
    logger,
    now: clock.now,
  };

  const sweep: SweepServices = {
    db,
    client: client as unknown as SweepServices['client'],
    jobs,
    tools,
    cycles,
    gigs,
    edits,
    usage,
    relay,
    buildLog,
    audit,
    seen: {} as unknown as SweepServices['seen'],
    negotiationStore: {} as unknown as SweepServices['negotiationStore'],
    reputationSource: {} as unknown as SweepServices['reputationSource'],
    proposer: {} as unknown as SweepServices['proposer'],
    costEstimator: {} as unknown as SweepServices['costEstimator'],
    threadReader: {} as unknown as SweepServices['threadReader'],
    queue,
    emailRouting,
    fetchImpl,
    botId: 'bot-jiffyapp',
    publicBaseUrl: PUBLIC_BASE_URL,
    toolHostSuffix: TOOL_HOST_SUFFIX,
    logger,
    now: clock.now,
  };

  const seedTool: Harness['seedTool'] = async (opts) => {
    const def = getTemplate('calculator');
    await tools.create({
      toolId: opts.toolId,
      slugCandidates: [opts.slug],
      templateId: 'calculator',
      templateVersion: def.version,
      buildContractId: opts.buildContractId ?? `build-${opts.toolId}`,
      name: BRIEF.name,
      brief: BRIEF,
      goldens: GOLDENS,
    });
    await tools.promote(opts.toolId, { slots: {}, hostedUntil: opts.hostedUntil });
    if (opts.latestHostingContractId) {
      await tools.extendHosting(opts.toolId, {
        hostedUntil: opts.hostedUntil,
        hostingContractId: opts.latestHostingContractId,
      });
    }
    if (opts.status === 'grace') {
      await tools.markGrace(opts.toolId, opts.graceStartedAt ?? clock.now());
    } else if (opts.status === 'suspended') {
      await tools.setStatus(opts.toolId, 'suspended');
    }
  };

  const claimCycleJob: Harness['claimCycleJob'] = async ({ contractId, toolId }) => {
    const hash = await sha256Hex(contractId);
    const jobKey = jobKeyFor(hash, 'cycle');
    await jobs.claim({ jobKey, contractId, kind: 'cycle', toolId });
    return { jobKey, msg: { kind: 'cycle', contractId, jobKey, toolId } };
  };

  return {
    cfg,
    sweep,
    clock,
    db,
    stores: { jobs, tools, cycles, edits, relay, buildLog, audit },
    messages,
    queueSent,
    deliverMilestoneCalls,
    contracts,
    fetchStatuses,
    fetchThrowNext,
    fetchCalls,
    seedTool,
    claimCycleJob,
  };
}

// =============================================================================
// processCycleJob
// =============================================================================

test('processCycleJob: creates the window and extends hostedUntil +30d from the existing (later) expiry', async () => {
  const h = await makeHarness();
  const existingHostedUntil = new Date(h.clock.now().getTime() + 10 * DAY_MS).toISOString();
  await h.seedTool({ toolId: 'tool-1', slug: 'rate-calc', hostedUntil: existingHostedUntil });
  const { jobKey, msg } = await h.claimCycleJob({ contractId: 'c-cyc-1', toolId: 'tool-1' });

  await processCycleJob(h.cfg, msg);

  const cycle = await h.stores.cycles.get('c-cyc-1');
  assert.ok(cycle);
  assert.equal(cycle?.toolId, 'tool-1');

  const tool = await h.stores.tools.get('tool-1');
  assert.equal(tool?.status, 'live');
  assert.equal(tool?.latestHostingContractId, 'c-cyc-1');
  const expected = new Date(new Date(existingHostedUntil).getTime() + HOSTING_WINDOW_DAYS * DAY_MS);
  assert.equal(tool?.hostedUntil, expected.toISOString());

  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].contractId, 'c-cyc-1');
  assert.match(h.messages[0].content, /edit:/);
  assert.doesNotMatch(h.messages[0].content, /revives/i);

  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'in_progress');
  assert.ok(job?.checkpoint);
});

test('processCycleJob: revives a suspended tool to live with a fresh window', async () => {
  const h = await makeHarness();
  const longLapsed = new Date(h.clock.now().getTime() - 60 * DAY_MS).toISOString();
  await h.seedTool({
    toolId: 'tool-2',
    slug: 'rate-calc-2',
    hostedUntil: longLapsed,
    status: 'suspended',
  });
  const { msg } = await h.claimCycleJob({ contractId: 'c-cyc-2', toolId: 'tool-2' });

  await processCycleJob(h.cfg, msg);

  const tool = await h.stores.tools.get('tool-2');
  assert.equal(tool?.status, 'live');
  assert.equal(tool?.graceStartedAt, null);
  const expected = new Date(h.clock.now().getTime() + HOSTING_WINDOW_DAYS * DAY_MS);
  assert.equal(tool?.hostedUntil, expected.toISOString());

  assert.match(h.messages[0].content, /revives/i);
});

test('processCycleJob: unknown toolId parks tool_missing and messages the thread', async () => {
  const h = await makeHarness();
  const { jobKey, msg } = await h.claimCycleJob({ contractId: 'c-cyc-3', toolId: 'tool-nope' });

  await processCycleJob(h.cfg, msg);

  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'parked');
  assert.equal(job?.parkReason, 'tool_missing');
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].content, /tool-nope/);
});

test('processCycleJob: redelivered claim on the same contract skips as in-progress', async () => {
  const h = await makeHarness();
  await h.seedTool({
    toolId: 'tool-4',
    slug: 'rate-calc-4',
    hostedUntil: new Date(h.clock.now().getTime() + 5 * DAY_MS).toISOString(),
  });
  const { msg } = await h.claimCycleJob({ contractId: 'c-cyc-4', toolId: 'tool-4' });

  await processCycleJob(h.cfg, msg);

  const hash = await sha256Hex('c-cyc-4');
  const jobKey = jobKeyFor(hash, 'cycle');
  const decision = await h.stores.jobs.claim({
    jobKey,
    contractId: 'c-cyc-4',
    kind: 'cycle',
    toolId: 'tool-4',
  });
  assert.deepEqual(decision, { action: 'skip', reason: 'in-progress' });
});

test('processCycleJob: redelivery after a crash between extendHosting and checkpoint does not double-extend', async () => {
  const h = await makeHarness();
  const existingHostedUntil = new Date(h.clock.now().getTime() + 10 * DAY_MS).toISOString();
  await h.seedTool({ toolId: 'tool-14', slug: 'rate-calc-14', hostedUntil: existingHostedUntil });
  const { jobKey, msg } = await h.claimCycleJob({ contractId: 'c-cyc-14', toolId: 'tool-14' });

  // Script sendMessage (which runs AFTER extendHosting, before the trailing buildLog/audit/
  // checkpoint bookkeeping) to throw on its first call only, simulating a crash right in that
  // window — the exact gap the redelivery/stuck-claim sweep can then retry into.
  let sendMessageCalls = 0;
  const originalSendMessage = h.cfg.client.sendMessage.bind(h.cfg.client);
  h.cfg.client.sendMessage = async (contractId: string, content: string): Promise<void> => {
    sendMessageCalls++;
    if (sendMessageCalls === 1) {
      throw new Error('sendMessage failed (simulated)');
    }
    return originalSendMessage(contractId, content);
  };

  await assert.rejects(() => processCycleJob(h.cfg, msg), /sendMessage failed \(simulated\)/);

  const afterCrash = await h.stores.tools.get('tool-14');
  const expectedHostedUntil = new Date(
    new Date(existingHostedUntil).getTime() + HOSTING_WINDOW_DAYS * DAY_MS,
  ).toISOString();
  assert.equal(afterCrash?.hostedUntil, expectedHostedUntil);
  assert.equal(afterCrash?.latestHostingContractId, 'c-cyc-14');

  // Redelivery: same message, sendMessage now healthy.
  await processCycleJob(h.cfg, msg);

  const afterRedelivery = await h.stores.tools.get('tool-14');
  assert.equal(afterRedelivery?.hostedUntil, expectedHostedUntil, 'must not double-extend to +60d');
  assert.equal(afterRedelivery?.latestHostingContractId, 'c-cyc-14');

  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'in_progress');
  assert.ok(job?.checkpoint);

  // sendMessage was attempted once (and threw); the redelivery detects the extension already
  // applied to this contract and skips re-sending the confirmation entirely.
  assert.equal(sendMessageCalls, 1);
  assert.equal(h.messages.length, 0);
});

test('processCycleJob: clean redelivery of a fully completed cycle job is a no-op', async () => {
  const h = await makeHarness();
  const existingHostedUntil = new Date(h.clock.now().getTime() + 10 * DAY_MS).toISOString();
  await h.seedTool({ toolId: 'tool-15', slug: 'rate-calc-15', hostedUntil: existingHostedUntil });
  const { jobKey, msg } = await h.claimCycleJob({ contractId: 'c-cyc-15', toolId: 'tool-15' });

  await processCycleJob(h.cfg, msg);

  const expectedHostedUntil = new Date(
    new Date(existingHostedUntil).getTime() + HOSTING_WINDOW_DAYS * DAY_MS,
  ).toISOString();
  const afterFirst = await h.stores.tools.get('tool-15');
  assert.equal(afterFirst?.hostedUntil, expectedHostedUntil);
  assert.equal(h.messages.length, 1);

  // A second, direct redelivery of the exact same message (e.g. the daily stuck-claim sweep
  // re-enqueuing a job it believes is still outstanding).
  await processCycleJob(h.cfg, msg);

  const afterSecond = await h.stores.tools.get('tool-15');
  assert.equal(afterSecond?.hostedUntil, expectedHostedUntil, 'must not double-extend');
  assert.equal(afterSecond?.latestHostingContractId, 'c-cyc-15');
  assert.equal(h.messages.length, 1, 'no extra confirmation message on redelivery');

  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'in_progress');
  assert.ok(job?.checkpoint);
});

// =============================================================================
// sweepHostingExpiry
// =============================================================================

test('sweepHostingExpiry: a live tool past hostedUntil enters grace and nudges the thread', async () => {
  const h = await makeHarness();
  const yesterday = new Date(h.clock.now().getTime() - 1 * DAY_MS).toISOString();
  await h.seedTool({
    toolId: 'tool-5',
    slug: 'rate-calc-5',
    hostedUntil: yesterday,
    buildContractId: 'c-build-5',
  });

  await sweepHostingExpiry(h.sweep);

  const tool = await h.stores.tools.get('tool-5');
  assert.equal(tool?.status, 'grace');
  assert.ok(tool?.graceStartedAt);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].contractId, 'c-build-5');
  assert.match(h.messages[0].content, /grace/i);
  assert.match(h.messages[0].content, /toolId: tool-5/);
});

test('sweepHostingExpiry: a grace tool older than GRACE_DAYS suspends and notes the thread', async () => {
  const h = await makeHarness();
  const graceStarted = new Date(h.clock.now().getTime() - (GRACE_DAYS + 1) * DAY_MS);
  await h.seedTool({
    toolId: 'tool-6',
    slug: 'rate-calc-6',
    hostedUntil: new Date(h.clock.now().getTime() - (GRACE_DAYS + 5) * DAY_MS).toISOString(),
    status: 'grace',
    graceStartedAt: graceStarted,
    buildContractId: 'c-build-6',
  });

  await sweepHostingExpiry(h.sweep);

  const tool = await h.stores.tools.get('tool-6');
  assert.equal(tool?.status, 'suspended');
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].content, /suspended/i);
  assert.match(h.messages[0].content, /toolId: tool-6/);
});

test('sweepHostingExpiry: a grace tool within GRACE_DAYS is left alone', async () => {
  const h = await makeHarness();
  const graceStarted = new Date(h.clock.now().getTime() - 1 * DAY_MS);
  await h.seedTool({
    toolId: 'tool-7',
    slug: 'rate-calc-7',
    hostedUntil: new Date(h.clock.now().getTime() - 5 * DAY_MS).toISOString(),
    status: 'grace',
    graceStartedAt: graceStarted,
  });

  await sweepHostingExpiry(h.sweep);

  const tool = await h.stores.tools.get('tool-7');
  assert.equal(tool?.status, 'grace');
  assert.equal(h.messages.length, 0);
});

test('sweepHostingExpiry: nudges the latest hosting contract, not the original build contract, once one exists', async () => {
  const h = await makeHarness();
  const yesterday = new Date(h.clock.now().getTime() - 1 * DAY_MS).toISOString();
  await h.seedTool({
    toolId: 'tool-8',
    slug: 'rate-calc-8',
    hostedUntil: yesterday,
    buildContractId: 'c-build-8',
    latestHostingContractId: 'c-cyc-8',
  });

  await sweepHostingExpiry(h.sweep);

  assert.equal(h.messages[0].contractId, 'c-cyc-8');
});

// =============================================================================
// deliverCycleReports
// =============================================================================

function fundedContract(milestoneId = 'm1'): Contract {
  return {
    id: 'unused',
    milestones: [{ id: milestoneId, status: 'funded' }],
  } as unknown as Contract;
}

test('deliverCycleReports: report due after windowEnd delivers once with edits + toolId + reachability, marks reported and job delivered', async () => {
  const h = await makeHarness();
  await h.seedTool({
    toolId: 'tool-9',
    slug: 'rate-calc-9',
    hostedUntil: new Date(h.clock.now().getTime() + 60 * DAY_MS).toISOString(),
  });
  const contractId = 'c-cyc-9';
  const windowStart = new Date(h.clock.now().getTime() - 31 * DAY_MS).toISOString();
  const windowEnd = new Date(h.clock.now().getTime() - 1 * DAY_MS).toISOString();
  await h.stores.cycles.create({ contractId, toolId: 'tool-9', windowStart, windowEnd });
  h.contracts.set(contractId, fundedContract('m-report'));
  h.fetchStatuses.push(200);

  await h.stores.edits.claim({
    requestId: 'req-done',
    toolId: 'tool-9',
    contractId,
    instruction: 'change the button color to blue',
  });
  await h.stores.edits.setStatus('req-done', 'done');
  await h.stores.edits.claim({
    requestId: 'req-held',
    toolId: 'tool-9',
    contractId,
    instruction: 'add a second page',
  });
  await h.stores.edits.setStatus('req-held', 'held');

  const hash = await sha256Hex(contractId);
  const jobKey = jobKeyFor(hash, 'cycle');
  await h.stores.jobs.claim({ jobKey, contractId, kind: 'cycle', toolId: 'tool-9' });
  await h.stores.jobs.setInProgress(jobKey, {});

  await deliverCycleReports(h.sweep);

  assert.equal(h.deliverMilestoneCalls.length, 1);
  const { note } = h.deliverMilestoneCalls[0];
  assert.match(note, /toolId: tool-9/);
  assert.match(note, /HTTP 200/);
  assert.match(note, /change the button color to blue.*done/);
  assert.match(note, /add a second page.*held/);

  const cycle = await h.stores.cycles.get(contractId);
  assert.ok(cycle?.reportDeliveredAt);

  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'delivered');
  assert.equal(job?.outcome, 'delivered');
});

test('deliverCycleReports: a second daily run does not re-deliver', async () => {
  const h = await makeHarness();
  await h.seedTool({
    toolId: 'tool-10',
    slug: 'rate-calc-10',
    hostedUntil: new Date(h.clock.now().getTime() + 60 * DAY_MS).toISOString(),
  });
  const contractId = 'c-cyc-10';
  const windowStart = new Date(h.clock.now().getTime() - 31 * DAY_MS).toISOString();
  const windowEnd = new Date(h.clock.now().getTime() - 1 * DAY_MS).toISOString();
  await h.stores.cycles.create({ contractId, toolId: 'tool-10', windowStart, windowEnd });
  h.contracts.set(contractId, fundedContract());
  h.fetchStatuses.push(200, 200);

  await deliverCycleReports(h.sweep);
  assert.equal(h.deliverMilestoneCalls.length, 1);

  await deliverCycleReports(h.sweep);
  assert.equal(h.deliverMilestoneCalls.length, 1); // no second delivery
});

test('deliverCycleReports: a fetch throw records reachability status 0', async () => {
  const h = await makeHarness();
  await h.seedTool({
    toolId: 'tool-11',
    slug: 'rate-calc-11',
    hostedUntil: new Date(h.clock.now().getTime() + 60 * DAY_MS).toISOString(),
  });
  const contractId = 'c-cyc-11';
  await h.stores.cycles.create({
    contractId,
    toolId: 'tool-11',
    windowStart: new Date(h.clock.now().getTime() - 31 * DAY_MS).toISOString(),
    windowEnd: new Date(h.clock.now().getTime() - 1 * DAY_MS).toISOString(),
  });
  h.contracts.set(contractId, fundedContract());
  h.fetchThrowNext.value = true;

  await deliverCycleReports(h.sweep);

  assert.equal(h.deliverMilestoneCalls.length, 1);
  assert.match(h.deliverMilestoneCalls[0].note, /HTTP 0/);
});

test('deliverCycleReports: an already-delivered milestone on retry marks reported without re-delivering', async () => {
  const h = await makeHarness();
  await h.seedTool({
    toolId: 'tool-12',
    slug: 'rate-calc-12',
    hostedUntil: new Date(h.clock.now().getTime() + 60 * DAY_MS).toISOString(),
  });
  const contractId = 'c-cyc-12';
  await h.stores.cycles.create({
    contractId,
    toolId: 'tool-12',
    windowStart: new Date(h.clock.now().getTime() - 31 * DAY_MS).toISOString(),
    windowEnd: new Date(h.clock.now().getTime() - 1 * DAY_MS).toISOString(),
  });
  h.contracts.set(contractId, {
    id: contractId,
    milestones: [{ id: 'm1', status: 'delivered' }],
  } as unknown as Contract);
  h.fetchStatuses.push(200);

  const hash = await sha256Hex(contractId);
  const jobKey = jobKeyFor(hash, 'cycle');
  await h.stores.jobs.claim({ jobKey, contractId, kind: 'cycle', toolId: 'tool-12' });

  await deliverCycleReports(h.sweep);

  assert.equal(h.deliverMilestoneCalls.length, 0);
  const cycle = await h.stores.cycles.get(contractId);
  assert.ok(cycle?.reportDeliveredAt);
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'delivered');
});

test('deliverCycleReports: no funded and no delivered/accepted milestone leaves the cycle due for retry', async () => {
  const h = await makeHarness();
  await h.seedTool({
    toolId: 'tool-13',
    slug: 'rate-calc-13',
    hostedUntil: new Date(h.clock.now().getTime() + 60 * DAY_MS).toISOString(),
  });
  const contractId = 'c-cyc-13';
  await h.stores.cycles.create({
    contractId,
    toolId: 'tool-13',
    windowStart: new Date(h.clock.now().getTime() - 31 * DAY_MS).toISOString(),
    windowEnd: new Date(h.clock.now().getTime() - 1 * DAY_MS).toISOString(),
  });
  h.contracts.set(contractId, {
    id: contractId,
    milestones: [{ id: 'm1', status: 'pending' }],
  } as unknown as Contract);
  h.fetchStatuses.push(200);

  await deliverCycleReports(h.sweep);

  assert.equal(h.deliverMilestoneCalls.length, 0);
  const cycle = await h.stores.cycles.get(contractId);
  assert.equal(cycle?.reportDeliveredAt, null);
});

// =============================================================================
// runDailySweep — composition: stuck-claim recovery + retention prunes
// =============================================================================

test('runDailySweep: re-enqueues a claimed job stuck past STUCK_CLAIM_MINUTES with no checkpoint', async () => {
  const h = await makeHarness();
  const contractId = 'c-stuck-1';
  const hash = await sha256Hex(contractId);
  const jobKey = jobKeyFor(hash, 'build');
  await h.stores.jobs.claim({ jobKey, contractId, kind: 'build' });

  h.clock.advance((STUCK_CLAIM_MINUTES + 5) * 60_000);
  await runDailySweep(h.sweep);

  assert.equal(h.queueSent.length, 1);
  assert.deepEqual(h.queueSent[0], {
    kind: 'build',
    contractId,
    jobKey,
    toolId: undefined,
  });
});

test('runDailySweep: does not re-enqueue a claim younger than STUCK_CLAIM_MINUTES', async () => {
  const h = await makeHarness();
  const contractId = 'c-stuck-2';
  const hash = await sha256Hex(contractId);
  const jobKey = jobKeyFor(hash, 'build');
  await h.stores.jobs.claim({ jobKey, contractId, kind: 'build' });

  h.clock.advance((STUCK_CLAIM_MINUTES - 5) * 60_000);
  await runDailySweep(h.sweep);

  assert.equal(h.queueSent.length, 0);
});

test('runDailySweep: prunes only old relay_events/build_log/gate_audit rows', async () => {
  const h = await makeHarness();
  const veryOld = new Date(h.clock.now().getTime() - (BUILD_LOG_RETENTION_DAYS + 10) * DAY_MS);

  h.clock.set(veryOld);
  await h.stores.relay.recordEvent({ toolId: 'tool-old', kind: 'test', status: 'sent' });
  await h.stores.buildLog.append('tok-old', 'stage', 'old message');
  await h.stores.audit.record({ scope: 'scope-old', gate: 'g', result: 'r' });

  h.clock.set(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));
  await h.stores.relay.recordEvent({ toolId: 'tool-new', kind: 'test', status: 'sent' });
  await h.stores.buildLog.append('tok-new', 'stage', 'new message');
  await h.stores.audit.record({ scope: 'scope-new', gate: 'g', result: 'r' });

  await runDailySweep(h.sweep);

  const relayRows = await h.db
    .prepare('SELECT tool_id FROM relay_events')
    .all<{ tool_id: string }>();
  assert.deepEqual(
    relayRows.results.map((r) => r.tool_id),
    ['tool-new'],
  );

  const buildLogRows = await h.db.prepare('SELECT token FROM build_log').all<{ token: string }>();
  assert.deepEqual(
    buildLogRows.results.map((r) => r.token),
    ['tok-new'],
  );

  const auditRows = await h.db.prepare('SELECT scope FROM gate_audit').all<{ scope: string }>();
  assert.deepEqual(
    auditRows.results.map((r) => r.scope),
    ['scope-new'],
  );
});

test('runDailySweep: one step failing (hosting-expiry) does not block the others (stuck-claim recovery still runs)', async () => {
  const h = await makeHarness();
  h.sweep.tools.listExpired = async () => {
    throw new Error('listExpired: simulated D1 outage');
  };

  const contractId = 'c-stuck-3';
  const hash = await sha256Hex(contractId);
  const jobKey = jobKeyFor(hash, 'build');
  await h.stores.jobs.claim({ jobKey, contractId, kind: 'build' });
  h.clock.advance((STUCK_CLAIM_MINUTES + 5) * 60_000);

  await runDailySweep(h.sweep);

  assert.equal(h.queueSent.length, 1);
  assert.equal(h.queueSent[0].jobKey, jobKey);
});
