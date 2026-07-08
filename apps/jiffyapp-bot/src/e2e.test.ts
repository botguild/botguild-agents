// End-to-end integration proof (Task 23 / PART D) — the PRD §14 Phase-4 "simulated month-2"
// exit criterion, executable in CI. ONE sequential test file whose subtests share a single
// harness and drive the FULL JiffyApp lifecycle over the REAL module composition (real D1-backed
// stores on in-memory sqlite with migrations applied; real sweeps/handlers/pipeline/hosting/edits
// wiring) with only the external effects behind fakes (codegen, deploy, browser, PSI, moderation,
// mailer, email-routing, R2, platform client, thread reader, and the queue — which is drained by
// a helper that mirrors index.ts's consumer).
//
// The clock is an explicit tick fake: subtests advance it deliberately so the whole run is
// deterministic. Because a funded hosting cycle COMPOUNDS `hosted_until` on top of the build's
// included first month, `hosted_until` sits ~30 days PAST the cycle's `window_end` — so the
// month-end report (window_end crossing) is chronologically EARLIER than expiry (hosted_until
// crossing). The subtests therefore run report → expiry, not the reverse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import type { D1Like, WebhookEvent, WebhookHandler } from '@botguild/agent-core-workers';
import type { AgentClient, Contract, Gig, ProposalDraft } from '@botguild/agent-core';
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
import { EDITS_PER_CYCLE, GRACE_DAYS, HOSTING_WINDOW_DAYS } from './config.js';
import { createJiffyProposer } from './proposer.js';
import { buildHandlers } from './handlers.js';
import { maybePropose, runDailySweep, type SweepServices } from './sweeps.js';
import { pollEditRequests } from './edits.js';
import { processCycleJob } from './hosting.js';
import { processJobMessage, type PipelineClient, type PipelineConfig } from './pipeline.js';
import { getTemplate } from './templates/registry.js';
import type { PageDriver } from './assertPlan.js';
import type { CodegenArgs, CodegenResult } from './codegen.js';
import type { ModerationOutcome } from './moderation.js';
import type { PsiResult } from './psi.js';
import type { ThreadMessage, ThreadReader } from './threads.js';
import type { GoldenSet, JobMessage, SlotValues } from './types.js';

const logger = createConsoleLogger({ service: 'test', level: 'silent' });
const BOT_ID = 'bot-jiffyapp';
const PUBLIC_BASE_URL = 'https://jiffyapp-bot.example.com';
const TOOL_HOST_SUFFIX = 'jiffyapp.dev';
const DAY_MS = 86_400_000;
const EXACT_CATEGORY = 'Web Development / Micro-tools'; // scorerConfig.categories[0]

// --- Fixtures ----------------------------------------------------------------

const CALC_GOLDENS: GoldenSet = {
  goldens: [
    { title: 'headline renders', steps: [], expect: [{ titleEquals: 'Rate Estimator' }] },
    {
      title: 'computes total',
      steps: [{ do: 'click', testid: 'calc-submit' }],
      expect: [{ testid: 'result', equals: '$100.00' }],
    },
    { title: 'reset shown', steps: [], expect: [{ testid: 'reset', visible: true }] },
  ],
};

// A recompiled set that still passes on calcLivePage('$100.00') but differs (first title), so an
// assertion that the tool's goldens flipped after an edit is meaningful.
const UPDATED_CALC_GOLDENS: GoldenSet = {
  goldens: [
    { title: 'updated headline renders', steps: [], expect: [{ titleEquals: 'Rate Estimator' }] },
    {
      title: 'computes total',
      steps: [{ do: 'click', testid: 'calc-submit' }],
      expect: [{ testid: 'result', equals: '$100.00' }],
    },
    { title: 'reset shown', steps: [], expect: [{ testid: 'reset', visible: true }] },
  ],
};

function calcSlots(): SlotValues {
  return structuredClone(getTemplate('calculator').referenceSlots);
}
function okCodegen(slots: SlotValues): CodegenResult {
  return { ok: true, slots, costUsd: 0.1, model: 'qwen-test' };
}

// --- Fake page driver (census-complete calculator live page) -----------------

interface ElementState {
  text?: string;
  visible?: boolean;
}
interface PageState {
  elements: Record<string, ElementState[]>;
  title: string;
}
function calcLivePage(resultText: string): PageState {
  return {
    title: 'Rate Estimator',
    elements: {
      'input-hours': [{ visible: true }],
      'input-seniority': [{ visible: true }],
      'input-rush': [{ visible: true }],
      'calc-submit': [{ visible: true }],
      result: [{ text: resultText, visible: true }],
      reset: [{ visible: true }],
      footer: [{ visible: true }],
    },
  };
}
function fakeDriver(state: PageState): PageDriver {
  const el = (testid: string, nth?: number): ElementState | undefined =>
    (state.elements[testid] ?? [])[nth ?? 0];
  return {
    async goto() {},
    async fill() {},
    async setChecked() {},
    async selectOption() {},
    async click() {},
    async uploadFile() {},
    async textContent(testid, nth) {
      return el(testid, nth)?.text ?? null;
    },
    async getAttribute() {
      return null;
    },
    async count(testid) {
      return (state.elements[testid] ?? []).length;
    },
    async isVisible(testid, nth) {
      return el(testid, nth)?.visible ?? false;
    },
    async title() {
      return state.title;
    },
    async metaContent() {
      return null;
    },
    async screenshot() {
      return new Uint8Array([1, 2, 3]);
    },
    async close() {},
  };
}

const PASS: ModerationOutcome = {
  ok: true,
  verdict: { vendor: 'openai', model: 'test', flagged: false, response: {}, checkedAt: 't' },
};

// --- Harness -----------------------------------------------------------------

interface Harness {
  db: D1Like;
  cfg: PipelineConfig;
  sweep: SweepServices;
  handlers: Record<string, WebhookHandler>;
  stores: {
    jobs: ReturnType<typeof createJobStore>;
    tools: ReturnType<typeof createToolStore>;
    gigs: ReturnType<typeof createGigStore>;
    cycles: ReturnType<typeof createCycleStore>;
    edits: ReturnType<typeof createEditRequestStore>;
    usage: ReturnType<typeof createUsageStore>;
    buildLog: ReturnType<typeof createBuildLogStore>;
    audit: ReturnType<typeof createAuditStore>;
  };
  setPage: (state: PageState) => void;
  codegenQueue: CodegenResult[];
  compileResult: { value: { ok: true; set: GoldenSet; costUsd: number } };
  recompileResult: { value: { ok: true; set: GoldenSet; costUsd: number } };
  submitProposalCalls: Array<{ gigId: string; draft: ProposalDraft }>;
  deliverMilestoneCalls: Array<{
    contractId: string;
    milestoneId: string;
    payload: { note: string; attachments?: string[] };
  }>;
  messages: Array<{ contractId: string; content: string }>;
  deliverables: Map<string, { value: string | Uint8Array; contentType: string }>;
  deployerPuts: string[];
  deployerDeletes: string[];
  threadsByContract: Map<string, ThreadMessage[]>;
  contracts: Map<string, Contract>;
  gigsById: Map<string, Gig>;
  now: () => Date;
  advanceToIso: (iso: string) => void;
  advanceDays: (days: number) => void;
  seedContract: (opts: { contractId: string; gigId: string; milestoneStatus?: string }) => void;
  fund: (contractId: string) => Promise<void>;
  drainQueue: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const db = createMemoryD1();
  await applyMigrations(db);

  let clockMs = Date.UTC(2026, 6, 1, 0, 0, 0); // 2026-07-01T00:00:00Z
  const now = (): Date => new Date(clockMs);

  const jobs = createJobStore(db, now);
  const tools = createToolStore(db, now);
  const gigs = createGigStore(db, now);
  const cycles = createCycleStore(db, now);
  const usage = createUsageStore(db, now);
  const edits = createEditRequestStore(db, now);
  const relay = createRelayStore(db, now);
  const buildLog = createBuildLogStore(db, now);
  const audit = createAuditStore(db, now);

  // --- Browser / codegen / deploy / psi / moderation fakes -------------------
  let page = calcLivePage('$100.00');
  const openPage = async (): Promise<PageDriver> => fakeDriver(page);

  const codegenQueue: CodegenResult[] = [];
  const codegen = {
    async generate(_args: CodegenArgs): Promise<CodegenResult> {
      const entry = codegenQueue.shift();
      if (!entry) throw new Error('codegen fake: queue empty (test under-provisioned)');
      return entry;
    },
  };

  const deployerPuts: string[] = [];
  const deployerDeletes: string[] = [];
  const deployer = {
    async putScript(slug: string): Promise<void> {
      deployerPuts.push(slug);
    },
    async deleteScript(slug: string): Promise<void> {
      deployerDeletes.push(slug);
    },
    async checkServes(): Promise<{ ok: boolean; status: number }> {
      return { ok: true, status: 200 };
    },
  };

  const psi = {
    async run(): Promise<PsiResult> {
      return { ok: true, performance: 96, accessibility: 98 };
    },
  };

  const moderation = {
    async moderate(): Promise<ModerationOutcome> {
      return PASS;
    },
    async moderateImage(): Promise<ModerationOutcome> {
      return PASS;
    },
  };

  const mailer = {
    async send(): Promise<{ messageId: string | null }> {
      return { messageId: 'msg-1' };
    },
  };
  const emailRouting = {
    async ensureDestination(): Promise<void> {},
    async isDestinationVerified(): Promise<boolean> {
      return true;
    },
  };

  const deliverables = new Map<string, { value: string | Uint8Array; contentType: string }>();
  const deliverableStore = {
    async put(key: string, value: string | Uint8Array, contentType: string): Promise<void> {
      deliverables.set(key, { value, contentType });
    },
  };

  // --- Golden compiler fake (build compile + edit recompile) -----------------
  const compileResult: Harness['compileResult'] = {
    value: { ok: true, set: CALC_GOLDENS, costUsd: 0.05 },
  };
  const recompileResult: Harness['recompileResult'] = {
    value: { ok: true, set: UPDATED_CALC_GOLDENS, costUsd: 0.05 },
  };
  const compiler = {
    async compile(): Promise<{ ok: true; set: GoldenSet; costUsd: number }> {
      return compileResult.value;
    },
    async recompileForEdit(): Promise<{ ok: true; set: GoldenSet; costUsd: number }> {
      return recompileResult.value;
    },
  };
  const baseProposer = {
    async generateProposal(): Promise<ProposalDraft> {
      return {
        price: 25,
        timeline: '1 business day',
        milestones: [{ title: 'Milestone 1', duration: '1 business day', deliverables: ['a'] }],
        assumptions: [],
      };
    },
  };
  const jiffyProposer = createJiffyProposer({
    base: baseProposer as unknown as Parameters<typeof createJiffyProposer>[0]['base'],
    compiler: compiler as unknown as Parameters<typeof createJiffyProposer>[0]['compiler'],
    gigs,
    logger,
  });

  // --- Platform client fake (build/cycle/edit + proposal + reports) ----------
  const contracts = new Map<string, Contract>();
  const gigsById = new Map<string, Gig>();
  const submitProposalCalls: Harness['submitProposalCalls'] = [];
  const messages: Harness['messages'] = [];
  const deliverMilestoneCalls: Harness['deliverMilestoneCalls'] = [];
  const client = {
    async getContract(contractId: string): Promise<Contract> {
      const c = contracts.get(contractId);
      if (!c) throw new Error(`no fake contract for ${contractId}`);
      return c;
    },
    async getGig(gigId: string): Promise<Gig> {
      const g = gigsById.get(gigId);
      if (!g) throw new Error(`no fake gig for ${gigId}`);
      return g;
    },
    async sendMessage(contractId: string, content: string): Promise<void> {
      messages.push({ contractId, content });
    },
    async deliverMilestone(
      contractId: string,
      milestoneId: string,
      payload: { note: string; attachments?: string[] },
    ): Promise<void> {
      deliverMilestoneCalls.push({ contractId, milestoneId, payload });
    },
    async submitProposal(gigId: string, draft: ProposalDraft): Promise<{ proposalId: string }> {
      submitProposalCalls.push({ gigId, draft });
      return { proposalId: `prop-${submitProposalCalls.length}` };
    },
    async getContractReview(): Promise<null> {
      return null;
    },
  };

  // --- Queue: a recording array drained by a helper mirroring index.ts -------
  const queueSent: JobMessage[] = [];
  const queue = {
    async send(msg: JobMessage): Promise<unknown> {
      queueSent.push(msg);
      return {};
    },
  };

  const threadsByContract = new Map<string, ThreadMessage[]>();
  const threadReader: ThreadReader = {
    async fetchContractMessages(contractId: string): Promise<ThreadMessage[]> {
      return threadsByContract.get(contractId) ?? [];
    },
  };

  const fetchImpl = (async (): Promise<Response> => {
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;

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
    client: client as unknown as PipelineClient,
    codegen,
    deployer,
    compiler: compiler as unknown as PipelineConfig['compiler'],
    emailRouting,
    openPage,
    closeBrowser: async () => {},
    psi,
    moderation,
    mailer,
    deliverables: deliverableStore,
    queue,
    fetchImpl,
    publicBaseUrl: PUBLIC_BASE_URL,
    toolHostSuffix: TOOL_HOST_SUFFIX,
    relayFromAddress: 'forms@jiffyapp.dev',
    logger,
    now,
    sleep: async () => {},
  };

  const sweep: SweepServices = {
    db,
    client: client as unknown as AgentClient,
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
    proposer: jiffyProposer,
    costEstimator: {} as unknown as SweepServices['costEstimator'],
    threadReader,
    queue,
    emailRouting,
    fetchImpl,
    botId: BOT_ID,
    publicBaseUrl: PUBLIC_BASE_URL,
    toolHostSuffix: TOOL_HOST_SUFFIX,
    logger,
    now,
  };

  const handlers = buildHandlers({
    client: client as unknown as AgentClient,
    mcp: { async respondToDispute() {} } as unknown as Parameters<typeof buildHandlers>[0]['mcp'],
    gigs,
    jobs,
    cycles,
    tools,
    queue,
    botId: BOT_ID,
    publicBaseUrl: PUBLIC_BASE_URL,
    logger,
  });

  const seedContract: Harness['seedContract'] = ({ contractId, gigId, milestoneStatus }) => {
    contracts.set(contractId, {
      id: contractId,
      gigId,
      botId: BOT_ID,
      milestones: [{ id: `${contractId}-m1`, status: milestoneStatus ?? 'funded' }],
    } as unknown as Contract);
  };

  const fund: Harness['fund'] = async (contractId) => {
    await handlers['milestone.funded']!({
      eventType: 'milestone.funded',
      payload: { contractId },
    } as WebhookEvent);
  };

  const drainQueue: Harness['drainQueue'] = async () => {
    // Bounded to avoid an accidental infinite loop if a fake mis-enqueues.
    for (let guard = 0; guard < 100 && queueSent.length > 0; guard++) {
      const msg = queueSent.shift()!;
      if (msg.kind === 'cycle') {
        await processCycleJob(cfg, msg as JobMessage & { kind: 'cycle' });
      } else {
        await processJobMessage(cfg, msg);
      }
    }
    if (queueSent.length > 0) throw new Error('drainQueue: queue did not settle');
  };

  return {
    db,
    cfg,
    sweep,
    handlers,
    stores: { jobs, tools, gigs, cycles, edits, usage, buildLog, audit },
    setPage: (state) => {
      page = state;
    },
    codegenQueue,
    compileResult,
    recompileResult,
    submitProposalCalls,
    deliverMilestoneCalls,
    messages,
    deliverables,
    deployerPuts,
    deployerDeletes,
    threadsByContract,
    contracts,
    gigsById,
    now,
    advanceToIso: (iso) => {
      clockMs = new Date(iso).getTime();
    },
    advanceDays: (days) => {
      clockMs += days * DAY_MS;
    },
    seedContract,
    fund,
    drainQueue,
  };
}

// =============================================================================
// The lifecycle — sequential subtests sharing ONE harness.
// =============================================================================

test('jiffyapp e2e: discover → build → host → edit → report → expiry → revive → kill', async (t) => {
  const h = await makeHarness();

  // Shared IDs threaded through the run.
  const BUILD_GIG = 'gig-build';
  const BUILD_CONTRACT = 'c-build';
  const CYCLE1_GIG = 'gig-cycle-1';
  const CYCLE1_CONTRACT = 'c-cycle-1';
  const CYCLE2_GIG = 'gig-cycle-2';
  const CYCLE2_CONTRACT = 'c-cycle-2';
  let toolId = '';
  let slug = '';

  const buildGig = (): Gig =>
    ({
      id: BUILD_GIG,
      title: 'Rate calculator',
      description:
        '```json\n{"template":"calculator","name":"Rate Calc","description":"Computes hourly rates by seniority."}\n```',
      category: EXACT_CATEGORY,
      budget: 25,
      timeline: '3 days',
      status: 'open',
    }) as unknown as Gig;

  await t.test('1. discover → propose (goldens embedded, gig_briefs persisted)', async () => {
    const gig = buildGig();
    h.gigsById.set(BUILD_GIG, gig);
    await maybePropose(h.sweep, gig);

    assert.equal(h.submitProposalCalls.length, 1);
    assert.equal(h.submitProposalCalls[0].gigId, BUILD_GIG);
    // The compiled golden block is embedded in the proposal's assumptions.
    const assumptions = h.submitProposalCalls[0].draft.assumptions ?? [];
    assert.ok(assumptions.some((a) => a.includes('Matched template: `calculator`')));

    // gig_briefs row persisted as a build with the compiled goldens.
    const row = await h.stores.gigs.get(BUILD_GIG);
    assert.equal(row?.kind, 'build');
    assert.equal(row?.templateId, 'calculator');
    assert.deepEqual(row?.goldens, CALC_GOLDENS);
  });

  await t.test('2. fund → build → deliver (live URL, 4 attachments, R2 evidence)', async () => {
    h.setPage(calcLivePage('$100.00'));
    h.codegenQueue.push(okCodegen(calcSlots()));
    h.seedContract({ contractId: BUILD_CONTRACT, gigId: BUILD_GIG });

    // The milestone.funded handler claims a build job + enqueues; the drain runs the pipeline.
    await h.fund(BUILD_CONTRACT);
    await h.drainQueue();

    const tool = await h.stores.tools.getByBuildContract(BUILD_CONTRACT);
    assert.ok(tool);
    toolId = tool!.toolId;
    slug = tool!.slug;
    assert.equal(tool!.status, 'live');
    assert.equal(tool!.hostedUntil?.slice(0, 10), '2026-07-31');
    assert.deepEqual(tool!.goldens, CALC_GOLDENS);

    // deliverMilestone captured with 4 attachments + the toolId line in the note.
    assert.equal(h.deliverMilestoneCalls.length, 1);
    const delivery = h.deliverMilestoneCalls[0];
    assert.equal(delivery.contractId, BUILD_CONTRACT);
    assert.equal(delivery.payload.attachments?.length, 4);
    assert.match(delivery.payload.note, new RegExp(`toolId: ${toolId}`));

    // R2 holds the report, PSI JSON, source zip, and per-golden screenshots.
    const hash = await sha256Hex(BUILD_CONTRACT);
    const job = await h.stores.jobs.get(jobKeyFor(hash, 'build'));
    const token = job!.deliverableToken;
    assert.ok(h.deliverables.has(`${token}/report.json`));
    assert.ok(h.deliverables.has(`${token}/psi.json`));
    assert.ok(h.deliverables.has(`${token}/source.zip`));
    for (let i = 0; i < CALC_GOLDENS.goldens.length; i++) {
      assert.ok(h.deliverables.has(`${token}/shot-${i}.png`), `missing live screenshot ${i}`);
    }

    // Job delivered; the build log has a terminal 'delivered' stage.
    assert.equal(job!.status, 'delivered');
    const stages = new Set((await h.stores.buildLog.since(token, 0)).map((e) => e.stage));
    assert.ok(stages.has('promote') && stages.has('delivered'));
  });

  await t.test(
    '3. hosting cycle: cycle gig → proposal → funded → window + extended hosting',
    async () => {
      const cycleGig = {
        id: CYCLE1_GIG,
        title: 'Keep my rate calc hosted',
        description: `Keep hosting my tool for another month.\n\n\`\`\`\ntoolId: ${toolId}\n\`\`\`\n`,
        category: EXACT_CATEGORY,
        budget: 5,
        timeline: '30 days',
        status: 'open',
      } as unknown as Gig;
      h.gigsById.set(CYCLE1_GIG, cycleGig);

      // Classify + propose the cycle (persists a gig_briefs cycle row the handler routes on).
      await maybePropose(h.sweep, cycleGig);
      const cycleRow = await h.stores.gigs.get(CYCLE1_GIG);
      assert.equal(cycleRow?.kind, 'cycle');
      assert.equal(cycleRow?.toolId, toolId);

      h.seedContract({ contractId: CYCLE1_CONTRACT, gigId: CYCLE1_GIG });
      await h.fund(CYCLE1_CONTRACT);
      await h.drainQueue();

      // Window opened and hosting compounded onto the build's included month (07-31 → 08-30).
      const cycle = await h.stores.cycles.get(CYCLE1_CONTRACT);
      assert.ok(cycle);
      assert.equal(cycle?.toolId, toolId);
      const tool = await h.stores.tools.get(toolId);
      assert.equal(tool?.status, 'live');
      assert.equal(tool?.latestHostingContractId, CYCLE1_CONTRACT);
      assert.equal(tool?.hostedUntil?.slice(0, 10), '2026-08-30');
    },
  );

  await t.test(
    '4. edit round-trip: buyer "edit:" thread message → promote → goldens updated',
    async () => {
      h.setPage(calcLivePage('$100.00'));
      h.codegenQueue.push(okCodegen(calcSlots()));
      // Buyer posts an edit request in the (open) cycle thread.
      h.threadsByContract.set(CYCLE1_CONTRACT, [
        {
          id: 'edit-msg-1',
          botId: 'buyer-1',
          content: 'edit: change the headline to Rate Estimator',
        },
      ]);

      await pollEditRequests(h.sweep); // claims + reserves + enqueues the edit job
      await h.drainQueue(); // processEditJob: recompile → codegen → promote over the live slug

      const tool = await h.stores.tools.get(toolId);
      assert.equal(tool?.status, 'live');
      assert.deepEqual(tool?.goldens, UPDATED_CALC_GOLDENS); // goldens flipped
      assert.deepEqual(tool?.slots, calcSlots());
      assert.equal((await h.stores.edits.get('edit-msg-1'))?.status, 'done');
      // Promoted over the SAME live slug; no new milestone delivery for an edit.
      assert.ok(h.deployerPuts.includes(slug));
      assert.equal(h.deliverMilestoneCalls.length, 1); // still just the build delivery
      assert.equal(await h.stores.usage.getUsed(`edit:${toolId}`, CYCLE1_CONTRACT), 1);
    },
  );

  await t.test(
    '5. month-end report: past window_end → service report (edit listed) delivered',
    async () => {
      // window_end is 07-31; advance just past it (still before hosted_until 08-30).
      h.advanceToIso('2026-08-01T00:00:00.000Z');
      await runDailySweep(h.sweep);

      // The report milestone was delivered on the cycle contract with the edit listed.
      assert.equal(h.deliverMilestoneCalls.length, 2);
      const report = h.deliverMilestoneCalls[1];
      assert.equal(report.contractId, CYCLE1_CONTRACT);
      assert.match(report.payload.note, /Month-end service report/);
      assert.match(report.payload.note, /change the headline to Rate Estimator/);
      assert.match(report.payload.note, /done/);

      // The cycle job is delivered and the report marked as sent (idempotent next sweep).
      const hash = await sha256Hex(CYCLE1_CONTRACT);
      assert.equal((await h.stores.jobs.get(jobKeyFor(hash, 'cycle')))?.status, 'delivered');

      // The tool is still live (hosted_until has not lapsed yet).
      assert.equal((await h.stores.tools.get(toolId))?.status, 'live');
    },
  );

  await t.test('6. expiry → grace → suspend → revive', async () => {
    // Past hosted_until (08-30) → grace + in-thread nudge.
    h.advanceToIso('2026-08-31T00:00:00.000Z');
    await runDailySweep(h.sweep);
    assert.equal((await h.stores.tools.get(toolId))?.status, 'grace');
    assert.ok(h.messages.some((m) => m.contractId === CYCLE1_CONTRACT && /grace/i.test(m.content)));
    // No duplicate month-end report (the cycle was already reported).
    assert.equal(h.deliverMilestoneCalls.length, 2);

    // Grace lapses (+GRACE_DAYS) with no re-fund → suspended (dispatcher serves 410 off status).
    h.advanceDays(GRACE_DAYS + 1);
    await runDailySweep(h.sweep);
    assert.equal((await h.stores.tools.get(toolId))?.status, 'suspended');

    // A newly funded cycle revives the tool to live.
    const cycle2Gig = {
      id: CYCLE2_GIG,
      title: 'Revive my rate calc',
      description: `Bring my tool back online.\n\n\`\`\`\ntoolId: ${toolId}\n\`\`\`\n`,
      category: EXACT_CATEGORY,
      budget: 5,
      timeline: '30 days',
      status: 'open',
    } as unknown as Gig;
    h.gigsById.set(CYCLE2_GIG, cycle2Gig);
    await maybePropose(h.sweep, cycle2Gig);
    h.seedContract({ contractId: CYCLE2_CONTRACT, gigId: CYCLE2_GIG });
    await h.fund(CYCLE2_CONTRACT);
    await h.drainQueue();

    const revived = await h.stores.tools.get(toolId);
    assert.equal(revived?.status, 'live');
    assert.equal(revived?.latestHostingContractId, CYCLE2_CONTRACT);
    assert.ok(
      h.messages.some((m) => m.contractId === CYCLE2_CONTRACT && /revives/i.test(m.content)),
    );
  });

  await t.test(
    '7. kill switch: setStatus killed makes the tool dispatch-visible as gone',
    async () => {
      // Route-level (/admin/suspend) lives in index.ts and is untested by convention; the store
      // effect the dispatcher reads is the contract under test. `killed` is what dispatch 410s on.
      await h.stores.tools.setStatus(toolId, 'killed');
      assert.equal((await h.stores.tools.get(toolId))?.status, 'killed');
      // And it is reversible only from killed (mirrors /admin/unsuspend's store effect).
      await h.stores.tools.setStatus(toolId, 'live');
      assert.equal((await h.stores.tools.get(toolId))?.status, 'live');
    },
  );

  // Sanity: the whole run exercised each constant it depends on (documents the fixtures).
  assert.equal(HOSTING_WINDOW_DAYS, 30);
  assert.equal(EDITS_PER_CYCLE, 3);
});
