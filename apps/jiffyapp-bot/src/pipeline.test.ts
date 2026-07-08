// Build pipeline (Tasks 17/18): the full codegen → stage → assert → repair loop through
// GREEN STAGING, then promote → live gates → package → deliver (and the abort leg), exercised
// end-to-end over REAL D1-backed stores (in-memory sqlite, migrations applied) with every
// external effect behind a recording/scripted fake. `makeHarness()` is exported (Task 18
// extended it with psi/fetch/sleep/deliverMilestone scripting) so later tasks can reuse the
// same seams. Happy paths run all the way to a captured `deliverMilestone`; cap/deadline paths
// run to a completed `abortJob`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import type { D1Like } from '@botguild/agent-core-workers';
import type { Contract, Gig } from '@botguild/agent-core';
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
  type BuildCheckpoint,
} from './jobs.js';
import { createGigStore } from './gigStore.js';
import { EDITS_PER_CYCLE } from './config.js';
import { getTemplate } from './templates/registry.js';
import { stagingSlug } from './slug.js';
import type { PageDriver } from './assertPlan.js';
import type { CodegenArgs, CodegenResult } from './codegen.js';
import type { ModerationOutcome } from './moderation.js';
import type { PsiResult } from './psi.js';
import type { GoldenSet, JiffyBrief, JobMessage, SlotValues, TemplateId } from './types.js';
import {
  processJobMessage,
  promoteAndDeliver,
  type PipelineClient,
  type PipelineConfig,
} from './pipeline.js';

const logger = createConsoleLogger({ service: 'test', level: 'silent' });
const BOT_ID = 'bot-jiffyapp';
const PUBLIC_BASE_URL = 'https://jiffyapp-bot.example.com';
const TOOL_HOST_SUFFIX = 'jiffyapp.dev';

// --- Fixtures ----------------------------------------------------------------

const CALC_BRIEF: JiffyBrief = {
  template: 'calculator',
  name: 'Rate Estimator',
  description: 'A rate estimator that totals hours by seniority.',
  copy: { headline: 'Rate Estimator' },
};

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

const FORM_BRIEF: JiffyBrief = {
  template: 'form',
  name: 'Studio contact form',
  description: 'Contact form for inbound studio inquiries.',
  copy: { headline: 'Get in touch' },
  notifyEmail: 'owner@example.com',
};

const FORM_GOLDENS: GoldenSet = {
  goldens: [
    { title: 'loads', steps: [], expect: [{ titleEquals: 'Get in touch' }] },
    {
      title: 'success hidden on load',
      steps: [],
      expect: [{ testid: 'success-msg', hidden: true }],
    },
  ],
};

function calcSlots(): SlotValues {
  return structuredClone(getTemplate('calculator').referenceSlots);
}
function formSlots(): SlotValues {
  return structuredClone(getTemplate('form').referenceSlots);
}
function okCodegen(slots: SlotValues, costUsd: number): CodegenResult {
  return { ok: true, slots, costUsd, model: 'qwen-test' };
}

// --- Scripted fake page driver (shared mutable state, per assertPlan.test.ts) -------------

interface ElementState {
  text?: string;
  visible?: boolean;
  attrs?: Record<string, string>;
}
interface PageState {
  elements: Record<string, ElementState[]>;
  title: string;
  gotoUrls: string[];
}
function newPage(overrides: Partial<PageState> = {}): PageState {
  return { elements: {}, title: '', gotoUrls: [], ...overrides };
}
function calcPage(resultText: string): PageState {
  return newPage({
    title: 'Rate Estimator',
    elements: { result: [{ text: resultText, visible: true }], reset: [{ visible: true }] },
  });
}
// Census-complete fixtures: every testid in the template's `elementContract(referenceSlots)` is
// present (count > 0), so the live element-census gate passes. `calcLivePage` also carries the
// calc goldens' result/reset; `formLivePage` the form goldens' title + hidden success message.
function calcLivePage(resultText: string): PageState {
  return newPage({
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
  });
}
function formLivePage(): PageState {
  return newPage({
    title: 'Get in touch',
    elements: {
      'field-name': [{ visible: true }],
      'field-email': [{ visible: true }],
      'field-message': [{ visible: true }],
      submit: [{ visible: true }],
      'success-msg': [{ visible: false }],
      'error-msg': [{ visible: false }],
      footer: [{ visible: true }],
    },
  });
}

function fakeDriver(state: PageState): PageDriver {
  const el = (testid: string, nth?: number): ElementState | undefined =>
    (state.elements[testid] ?? [])[nth ?? 0];
  return {
    async goto(url) {
      state.gotoUrls.push(url);
    },
    async fill() {},
    async setChecked() {},
    async selectOption() {},
    async click() {},
    async uploadFile() {},
    async textContent(testid, nth) {
      return el(testid, nth)?.text ?? null;
    },
    async getAttribute(testid, attr, nth) {
      return el(testid, nth)?.attrs?.[attr] ?? null;
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

// --- Clock -------------------------------------------------------------------

interface Clock {
  now: () => Date;
  advance: (deltaMs: number) => void;
}
function makeClock(startMs = Date.UTC(2026, 0, 1, 0, 0, 0)): Clock {
  let ms = startMs;
  return {
    now: () => {
      const at = new Date(ms);
      ms += 1000; // every read advances the clock 1s so active time is always > 0
      return at;
    },
    advance: (deltaMs) => {
      ms += deltaMs;
    },
  };
}

// --- Moderation outcome builders ---------------------------------------------

const PASS: ModerationOutcome = {
  ok: true,
  verdict: { vendor: 'openai', model: 'test', flagged: false, response: {}, checkedAt: 't' },
};
const FLAGGED: ModerationOutcome = {
  ok: true,
  verdict: { vendor: 'openai', model: 'test', flagged: true, response: {}, checkedAt: 't' },
};
const OUTAGE: ModerationOutcome = { ok: false, kind: 'outage', detail: 'test outage' };

// --- Harness -----------------------------------------------------------------

export interface Harness {
  cfg: PipelineConfig;
  db: D1Like;
  clock: Clock;
  stores: {
    jobs: ReturnType<typeof createJobStore>;
    tools: ReturnType<typeof createToolStore>;
    gigs: ReturnType<typeof createGigStore>;
    relay: ReturnType<typeof createRelayStore>;
    audit: ReturnType<typeof createAuditStore>;
    buildLog: ReturnType<typeof createBuildLogStore>;
    edits: ReturnType<typeof createEditRequestStore>;
    usage: ReturnType<typeof createUsageStore>;
  };
  page: PageState;
  setPage: (state: PageState) => void;
  codegenQueue: Array<{ result: CodegenResult; onCall?: (args: CodegenArgs) => void }>;
  codegenCalls: CodegenArgs[];
  moderationText: ModerationOutcome[];
  moderationTextCalls: string[];
  /** When true, the moderation fake throws on any call (proves the staged short-circuit skips it). */
  moderationThrow: { value: boolean };
  serves: { value: { ok: boolean; status: number }; throwOnce: boolean };
  deployerPuts: Array<{ slug: string; script: string }>;
  deployerDeletes: string[];
  checkServesCalls: string[];
  messages: Array<{ contractId: string; content: string }>;
  queueSent: JobMessage[];
  mailerSent: Array<{ to: string; from: string; subject: string; text: string }>;
  ensuredDestinations: string[];
  verifiedDestinations: Set<string>;
  deliverables: Map<string, { value: string | Uint8Array; contentType: string }>;
  deliverMilestoneCalls: Array<{
    contractId: string;
    milestoneId: string;
    payload: { note: string; attachments?: string[] };
  }>;
  /** Queue of errors the fake `deliverMilestone` throws, one per call, in order; once drained it
   *  succeeds (a no-op beyond recording the call — it does NOT touch the fake contract's
   *  milestone status, so a test wanting a subsequent `getContract` to see 'delivered' scripts
   *  that itself, e.g. by monkeypatching `cfg.client.getContract` for the call(s) that follow). */
  deliverMilestoneQueue: Error[];
  /** The fake contracts keyed by contractId — exposed so a test can seed/inspect milestone
   *  status directly. */
  contracts: Map<string, Contract>;
  /** Live-reachability probe statuses, consumed in order; defaults to 200 when the queue is empty. */
  fetchStatuses: number[];
  fetchCalls: string[];
  /** PSI result the fake returns; settable per test (default a passing 96/97). */
  psiResult: { value: PsiResult };
  psiCalls: string[];
  /** The result the recompileForEdit fake returns (Task 22); settable per test. */
  recompileResult: {
    value:
      | { ok: true; set: GoldenSet; costUsd: number }
      | { ok: false; errors: string[]; costUsd: number };
  };
  recompileCalls: Array<{ instruction: string; currentGoldens: GoldenSet }>;
  seedBuildGig: (opts: {
    templateId: TemplateId;
    brief: JiffyBrief;
    goldens: GoldenSet;
    contractId?: string;
    gigId?: string;
  }) => Promise<{
    contractId: string;
    gigId: string;
    jobKey: string;
    token: string;
    msg: JobMessage;
  }>;
  /** Seed a LIVE tool + a claimed+reserved edit request + an `edit` job, ready for
   *  `processJobMessage` (Task 22). */
  seedEditJob: (opts: {
    templateId: TemplateId;
    brief: JiffyBrief;
    goldens: GoldenSet;
    slots: SlotValues;
    instruction: string;
    toolId?: string;
    contractId?: string;
    requestId?: string;
    reserveQuota?: boolean;
  }) => Promise<{
    toolId: string;
    contractId: string;
    requestId: string;
    jobKey: string;
    token: string;
    msg: JobMessage & { kind: 'edit' };
  }>;
}

export async function makeHarness(opts: { now?: () => Date } = {}): Promise<Harness> {
  const db = createMemoryD1();
  await applyMigrations(db);

  const clock = makeClock();
  const now = opts.now ?? clock.now;
  const storeNow = (): Date => new Date('2026-01-01T00:00:00Z');

  const jobs = createJobStore(db, storeNow);
  const tools = createToolStore(db, storeNow);
  const gigs = createGigStore(db, storeNow);
  const cycles = createCycleStore(db, storeNow);
  const usage = createUsageStore(db, storeNow);
  const edits = createEditRequestStore(db, storeNow);
  const relay = createRelayStore(db, storeNow);
  const buildLog = createBuildLogStore(db, storeNow);
  const audit = createAuditStore(db, storeNow);

  // mutable page state (reassignable via setPage so a resume can swap the fixture)
  let page = newPage();
  const openPage = async (): Promise<PageDriver> => fakeDriver(page);

  const codegenQueue: Harness['codegenQueue'] = [];
  const codegenCalls: CodegenArgs[] = [];
  const codegen = {
    async generate(args: CodegenArgs): Promise<CodegenResult> {
      codegenCalls.push(args);
      const entry = codegenQueue.shift();
      if (!entry) throw new Error('codegen fake: queue empty (test under-provisioned)');
      entry.onCall?.(args);
      return entry.result;
    },
  };

  const moderationText: ModerationOutcome[] = [];
  const moderationTextCalls: string[] = [];
  const moderationThrow = { value: false };
  const moderation = {
    async moderate(text: string): Promise<ModerationOutcome> {
      if (moderationThrow.value)
        throw new Error('moderation fake: should not be called on this path');
      moderationTextCalls.push(text);
      return moderationText.shift() ?? PASS;
    },
    async moderateImage(): Promise<ModerationOutcome> {
      if (moderationThrow.value)
        throw new Error('moderation fake: should not be called on this path');
      return PASS;
    },
  };

  const serves = { value: { ok: true, status: 200 }, throwOnce: false };
  const deployerPuts: Array<{ slug: string; script: string }> = [];
  const deployerDeletes: string[] = [];
  const checkServesCalls: string[] = [];
  const deployer = {
    async putScript(slug: string, script: string): Promise<void> {
      deployerPuts.push({ slug, script });
    },
    async deleteScript(slug: string): Promise<void> {
      deployerDeletes.push(slug);
    },
    async checkServes(slug: string): Promise<{ ok: boolean; status: number }> {
      checkServesCalls.push(slug);
      if (serves.throwOnce) {
        serves.throwOnce = false;
        throw new Error('checkServes fake: transient binding error');
      }
      return serves.value;
    },
  };

  const contracts = new Map<string, Contract>();
  const gigsById = new Map<string, Gig>();
  const messages: Array<{ contractId: string; content: string }> = [];
  const deliverMilestoneCalls: Harness['deliverMilestoneCalls'] = [];
  const deliverMilestoneQueue: Harness['deliverMilestoneQueue'] = [];
  const client: PipelineClient = {
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
      const err = deliverMilestoneQueue.shift();
      if (err) throw err;
    },
  };

  const queueSent: JobMessage[] = [];
  const queue = {
    async send(msg: JobMessage): Promise<unknown> {
      queueSent.push(msg);
      return {};
    },
  };

  const mailerSent: Array<{ to: string; from: string; subject: string; text: string }> = [];
  const mailer = {
    async send(msg: { to: string; from: string; subject: string; text: string }): Promise<{
      messageId: string | null;
    }> {
      mailerSent.push(msg);
      return { messageId: `msg-${mailerSent.length}` };
    },
  };

  const ensuredDestinations: string[] = [];
  const verifiedDestinations = new Set<string>();
  const emailRouting = {
    async ensureDestination(email: string): Promise<void> {
      ensuredDestinations.push(email);
    },
    async isDestinationVerified(email: string): Promise<boolean> {
      return verifiedDestinations.has(email);
    },
  };

  const deliverables = new Map<string, { value: string | Uint8Array; contentType: string }>();
  const deliverableStore = {
    async put(key: string, value: string | Uint8Array, contentType: string): Promise<void> {
      deliverables.set(key, { value, contentType });
    },
  };

  const recompileResult: Harness['recompileResult'] = {
    value: { ok: false, errors: ['recompiler not scripted for this test'], costUsd: 0 },
  };
  const recompileCalls: Harness['recompileCalls'] = [];
  const compiler = {
    async compile(): Promise<{ ok: false; errors: string[]; costUsd: number }> {
      return { ok: false, errors: ['compiler not scripted for this test'], costUsd: 0 };
    },
    async recompileForEdit(args: {
      brief: JiffyBrief;
      instruction: string;
      currentGoldens: GoldenSet;
    }): Promise<
      | { ok: true; set: GoldenSet; costUsd: number }
      | { ok: false; errors: string[]; costUsd: number }
    > {
      recompileCalls.push({ instruction: args.instruction, currentGoldens: args.currentGoldens });
      return recompileResult.value;
    },
  };

  const psiResult = { value: { ok: true, performance: 96, accessibility: 97 } as PsiResult };
  const psiCalls: string[] = [];
  const psi = {
    async run(url: string): Promise<PsiResult> {
      psiCalls.push(url);
      return psiResult.value;
    },
  };

  const fetchStatuses: number[] = [];
  const fetchCalls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    fetchCalls.push(String(input));
    return new Response('', { status: fetchStatuses.shift() ?? 200 });
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
    client,
    codegen,
    deployer,
    compiler,
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
    sleep: async () => {}, // no-op — the reachability propagation retry never actually waits in tests
  };

  let seq = 0;
  const seedBuildGig: Harness['seedBuildGig'] = async ({ templateId, brief, goldens, ...ids }) => {
    seq += 1;
    const gigId = ids.gigId ?? `gig-${seq}`;
    const contractId = ids.contractId ?? `c-${seq}`;
    const def = getTemplate(templateId);
    await gigs.saveBuild({ gigId, templateId, templateVersion: def.version, brief, goldens });
    contracts.set(contractId, {
      id: contractId,
      gigId,
      botId: BOT_ID,
      milestones: [{ id: 'm1', status: 'funded' }],
    } as unknown as Contract);
    gigsById.set(gigId, {
      id: gigId,
      title: brief.name,
      description: brief.description,
    } as unknown as Gig);
    const hash = await sha256Hex(contractId);
    const jobKey = jobKeyFor(hash, 'build');
    await jobs.claim({ jobKey, contractId, kind: 'build', gigId });
    const job = await jobs.get(jobKey);
    return {
      contractId,
      gigId,
      jobKey,
      token: job!.deliverableToken,
      msg: { kind: 'build', contractId, jobKey },
    };
  };

  const seedEditJob: Harness['seedEditJob'] = async (opts) => {
    seq += 1;
    const toolId = opts.toolId ?? `tool-edit-${seq}`;
    const contractId = opts.contractId ?? `c-edit-${seq}`;
    const requestId = opts.requestId ?? `req-${seq}`;
    const def = getTemplate(opts.templateId);
    await tools.create({
      toolId,
      slugCandidates: [`edit-tool-${seq}`],
      templateId: opts.templateId,
      templateVersion: def.version,
      buildContractId: `build-${contractId}`,
      name: opts.brief.name,
      brief: opts.brief,
      goldens: opts.goldens,
      notifyEmail: opts.brief.notifyEmail,
    });
    // Promote to LIVE with the current slots + a hosting window well in the future.
    const hostedUntil = new Date(storeNow().getTime() + 30 * 86_400_000).toISOString();
    await tools.promote(toolId, { slots: opts.slots, hostedUntil });

    // Claim + reserve the edit request exactly as pollEditRequests would.
    await edits.claim({ requestId, toolId, contractId, instruction: opts.instruction });
    if (opts.reserveQuota !== false) {
      const scope = `edit:${toolId}`;
      await usage.reserve(scope, contractId, EDITS_PER_CYCLE);
      await edits.setQuotaRef(requestId, scope, contractId);
    }
    const hash = await sha256Hex(contractId);
    const jobKey = jobKeyFor(hash, `edit:${requestId}`);
    await jobs.claim({ jobKey, contractId, kind: 'edit', toolId });
    const job = await jobs.get(jobKey);
    return {
      toolId,
      contractId,
      requestId,
      jobKey,
      token: job!.deliverableToken,
      msg: { kind: 'edit', contractId, jobKey, toolId, requestId },
    };
  };

  return {
    cfg,
    db,
    clock,
    stores: { jobs, tools, gigs, relay, audit, buildLog, edits, usage },
    get page() {
      return page;
    },
    setPage: (state: PageState) => {
      page = state;
    },
    codegenQueue,
    codegenCalls,
    moderationText,
    moderationTextCalls,
    moderationThrow,
    serves,
    deployerPuts,
    deployerDeletes,
    checkServesCalls,
    messages,
    queueSent,
    mailerSent,
    ensuredDestinations,
    verifiedDestinations,
    deliverables,
    deliverMilestoneCalls,
    deliverMilestoneQueue,
    contracts,
    fetchStatuses,
    fetchCalls,
    psiResult,
    psiCalls,
    recompileResult,
    recompileCalls,
    seedBuildGig,
    seedEditJob,
  };
}

// =============================================================================
// Cases
// =============================================================================

test('full happy path: green staging → promote → live gates → package → deliver', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00'));
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  const { msg, token, jobKey, contractId } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await processJobMessage(h.cfg, msg); // completes to delivery — no throw

  const stg = stagingSlug(token);
  const tool = await h.stores.tools.getByBuildContract(contractId);
  assert.ok(tool);

  // Staging PUT (round 0) + final PUT on the live slug, then staging DELETE.
  assert.equal(h.deployerPuts.filter((p) => p.slug === stg).length, 1);
  assert.equal(h.deployerPuts.filter((p) => p.slug === tool!.slug).length, 1);
  assert.ok(h.deployerDeletes.includes(stg));

  // Tool promoted live with hostedUntil ≈ now(2026-01-01) + 30d.
  assert.equal(tool!.status, 'live');
  assert.equal(tool!.hostedUntil?.slice(0, 10), '2026-01-31');

  // Live goldens re-ran on the live url; screenshots stored under <token>/shot-*.png.
  assert.ok(h.page.gotoUrls.includes(`https://${tool!.slug}.${TOOL_HOST_SUFFIX}/?jiffytest=1`));
  for (let i = 0; i < CALC_GOLDENS.goldens.length; i++) {
    assert.ok(h.deliverables.has(`${token}/shot-${i}.png`), `missing live screenshot ${i}`);
  }

  // PSI recorded against the CLEAN live url; deliverables present.
  assert.ok(h.psiCalls.includes(`https://${tool!.slug}.${TOOL_HOST_SUFFIX}`));
  assert.ok(h.deliverables.has(`${token}/report.json`));
  assert.ok(h.deliverables.has(`${token}/psi.json`));
  assert.ok(h.deliverables.has(`${token}/source.zip`));

  // Evidence report content: reachability 200, live screenshots hashed under bare basenames.
  const report = JSON.parse(String(h.deliverables.get(`${token}/report.json`)!.value));
  assert.equal(report.liveGates.reachability.status, 200);
  assert.equal(report.goldens[0].screenshot.key, 'shot-0.png');
  assert.match(report.goldens[0].screenshot.sha256, /^[0-9a-f]{64}$/);

  // deliverMilestone captured with the 4 attachments + toolId line in the note.
  assert.equal(h.deliverMilestoneCalls.length, 1);
  assert.equal(h.deliverMilestoneCalls[0].payload.attachments?.length, 4);
  assert.match(h.deliverMilestoneCalls[0].payload.note, new RegExp(`toolId: ${tool!.toolId}`));

  // Job delivered; build log has the terminal entry.
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'delivered');
  assert.equal(job?.outcome, 'delivered');
  const stages = new Set((await h.stores.buildLog.since(token, 0)).map((e) => e.stage));
  assert.ok(stages.has('promote') && stages.has('delivered'));
});

test('repair loop: round 0 fails, round 1 gets failures + priorSlots, passes, and delivers', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$0.00')); // round 0: result is wrong
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  h.codegenQueue.push({
    result: okCodegen(calcSlots(), 0.1),
    onCall: () => {
      h.page.elements.result = [{ text: '$100.00', visible: true }]; // repair fixes the page
    },
  });
  const { msg, token, jobKey, contractId } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await processJobMessage(h.cfg, msg);

  // Round 1 codegen received the prior slots + the round-0 failures.
  assert.equal(h.codegenCalls.length, 2);
  assert.ok(h.codegenCalls[1].priorSlots !== undefined);
  assert.deepEqual(h.codegenCalls[1].priorSlots, getTemplate('calculator').referenceSlots);
  assert.ok((h.codegenCalls[1].failures ?? []).length > 0);

  // Two staging PUTs (r0 + r1); checkpoint records repair round 1.
  const stg = stagingSlug(token);
  assert.equal(h.deployerPuts.filter((p) => p.slug === stg).length, 2);
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.checkpoint?.round, 1);
  assert.equal(job?.repairRounds, 1);
  assert.equal(job?.outcome, 'delivered');

  // Staging screenshots for both rounds; delivered.
  assert.ok(h.deliverables.has(`${token}/stg-r0-shot-0.png`));
  assert.ok(h.deliverables.has(`${token}/stg-r1-shot-0.png`));
  assert.equal(h.deliverMilestoneCalls.length, 1);
  const tool = await h.stores.tools.getByBuildContract(contractId);
  assert.equal(tool?.status, 'live');
});

test('spend cap: exhausting MAX_SPEND_USD aborts (never promotes) and audits cap-exhausted', async () => {
  const h = await makeHarness();
  h.setPage(calcPage('$0.00')); // goldens never pass
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.3) });
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.3) });
  const { msg, jobKey, contractId } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await processJobMessage(h.cfg, msg); // abort is a controlled exit — no throw

  // Two rounds ran (0.3 + 0.3 = 0.6 ≥ 0.5), then the spend precheck broke to abort.
  assert.equal(h.codegenCalls.length, 2);
  assert.equal(h.deployerPuts.length, 2);
  const audits = await h.stores.audit.listByScope(contractId);
  assert.ok(audits.some((a) => a.result === 'cap-exhausted'));
  assert.ok(audits.some((a) => a.gate === 'non-convergence'));

  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'aborted');
  assert.equal(h.deliverMilestoneCalls.length, 0);
  assert.match(h.messages[h.messages.length - 1].content, /cancel/i);
});

test('soft budget: crossing CONSUMER_SOFT_BUDGET_MS checkpoints and re-enqueues (no promote/abort)', async () => {
  const h = await makeHarness();
  h.setPage(calcPage('$0.00')); // round 0 fails, so the loop reaches round 1's soft-budget gate
  h.codegenQueue.push({
    result: okCodegen(calcSlots(), 0.1),
    onCall: () => h.clock.advance(9 * 60_000), // jump past the 8-min soft budget during round 0
  });
  const { msg, jobKey } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await processJobMessage(h.cfg, msg); // resolves cleanly — no throw

  assert.equal(h.queueSent.length, 1);
  assert.deepEqual(h.queueSent[0], msg);
  assert.equal(h.deployerPuts.length, 1); // only round 0 deployed
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.checkpoint?.round, 1);
  assert.ok((job?.checkpoint?.activeMs ?? 0) > 8 * 60_000);
});

test('moderation outage on the brief parks moderation_outage and notices only on attempt 3', async () => {
  const h = await makeHarness();
  h.moderationText.push(OUTAGE, OUTAGE, OUTAGE);
  const { msg, jobKey } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await processJobMessage(h.cfg, msg); // attempt 1
  let job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'parked');
  assert.equal(job?.parkReason, 'moderation_outage');
  assert.equal(job?.moderationAttempts, 1);
  assert.equal(h.messages.length, 0);

  await h.stores.jobs.unpark(jobKey);
  await processJobMessage(h.cfg, msg); // attempt 2
  assert.equal((await h.stores.jobs.get(jobKey))?.moderationAttempts, 2);
  assert.equal(h.messages.length, 0);

  await h.stores.jobs.unpark(jobKey);
  await processJobMessage(h.cfg, msg); // attempt 3 → single thread notice
  job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.moderationAttempts, 3);
  assert.equal(h.messages.length, 1);
  assert.equal(h.deployerPuts.length, 0);
});

test('flagged brief: messages the buyer and marks the job rejected', async () => {
  const h = await makeHarness();
  h.moderationText.push(FLAGGED);
  const { msg, jobKey } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await processJobMessage(h.cfg, msg);

  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'delivered');
  assert.equal(job?.outcome, 'rejected');
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].content, /flagged/i);
  assert.equal(h.deployerPuts.length, 0);
});

test('slug policy: a slugPreference normalizing to stg-* is rejected — parks, no tool, no deploy', async () => {
  const h = await makeHarness();
  const brief: JiffyBrief = { ...CALC_BRIEF, slugPreference: 'stg cool' };
  const { msg, jobKey, contractId } = await h.seedBuildGig({
    templateId: 'calculator',
    brief,
    goldens: CALC_GOLDENS,
  });

  await processJobMessage(h.cfg, msg); // controlled park — no throw

  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'parked');
  assert.equal(job?.parkReason, 'brief_invalid');
  assert.match(h.messages[h.messages.length - 1].content, /naming policy/i);
  // No tool row was ever created (a stg- slug can never be reserved) and nothing deployed.
  assert.equal(await h.stores.tools.getByBuildContract(contractId), null);
  assert.equal(h.deployerPuts.length, 0);
});

test('slug policy: a slugPreference containing a blocked brand (paypal) is rejected — parks, no deploy', async () => {
  const h = await makeHarness();
  const brief: JiffyBrief = { ...CALC_BRIEF, slugPreference: 'paypal' };
  const { msg, jobKey, contractId } = await h.seedBuildGig({
    templateId: 'calculator',
    brief,
    goldens: CALC_GOLDENS,
  });

  await processJobMessage(h.cfg, msg);

  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'parked');
  assert.equal(job?.parkReason, 'brief_invalid');
  assert.equal(await h.stores.tools.getByBuildContract(contractId), null);
  assert.equal(h.deployerPuts.length, 0);
});

test('relay template unverified: registers the destination, mails once, parks awaiting_verification', async () => {
  const h = await makeHarness();
  const { msg, jobKey } = await h.seedBuildGig({
    templateId: 'form',
    brief: FORM_BRIEF,
    goldens: FORM_GOLDENS,
  });

  await processJobMessage(h.cfg, msg);

  assert.deepEqual(h.ensuredDestinations, ['owner@example.com']);
  assert.equal(h.mailerSent.length, 1);
  assert.match(h.mailerSent[0].text, /relay\/verify\//);
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'parked');
  assert.equal(job?.parkReason, 'awaiting_verification');
  assert.equal(h.deployerPuts.length, 0);
});

test('resume after both verifications proceeds without aborting (parked time is free)', async () => {
  const h = await makeHarness();
  const { msg, contractId } = await h.seedBuildGig({
    templateId: 'form',
    brief: FORM_BRIEF,
    goldens: FORM_GOLDENS,
  });

  // First invocation parks awaiting verification.
  await processJobMessage(h.cfg, msg);
  assert.equal((await h.stores.jobs.get(msg.jobKey))?.parkReason, 'awaiting_verification');

  // Confirm both sides, then resume two days later.
  const tool = await h.stores.tools.getByBuildContract(contractId);
  const relayRow = await h.stores.relay.get(tool!.toolId);
  await h.stores.relay.verifyByToken(relayRow!.verifyToken);
  h.verifiedDestinations.add('owner@example.com');
  h.setPage(formLivePage());
  h.codegenQueue.push({ result: okCodegen(formSlots(), 0.1) });
  h.clock.advance(2 * 24 * 60 * 60 * 1000);
  await h.stores.jobs.unpark(msg.jobKey);

  // It must proceed all the way to delivery — an abort would mean the parked wait was wrongly
  // counted against the active-time cap.
  await processJobMessage(h.cfg, msg);

  const job = await h.stores.jobs.get(msg.jobKey);
  assert.equal(job?.outcome, 'delivered');
  assert.ok((job?.checkpoint?.activeMs ?? 0) < 25 * 60_000);
  assert.equal(h.deliverMilestoneCalls.length, 1);
});

test('active-time cap: a checkpoint already over 25 min aborts on entry', async () => {
  const h = await makeHarness();
  const { msg, jobKey } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });
  const over: BuildCheckpoint = {
    slotValues: null,
    round: 0,
    spendUsd: 0,
    activeMs: 26 * 60_000,
    staged: false,
    lastFailures: [],
    bankedRound: null,
  };
  await h.stores.jobs.saveCheckpoint(jobKey, over);

  await processJobMessage(h.cfg, msg); // abort is a controlled exit — no throw

  assert.equal(h.deployerPuts.length, 0);
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'aborted');
  assert.equal(h.deliverMilestoneCalls.length, 0);
  assert.match(h.messages[h.messages.length - 1].content, /cancel/i);
});

test('replay of a delivered job is a no-op', async () => {
  const h = await makeHarness();
  const { msg, jobKey } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });
  await h.stores.jobs.markDelivered(jobKey, 'delivered');

  await processJobMessage(h.cfg, msg); // no throw, no effects

  assert.equal(h.deployerPuts.length, 0);
  assert.equal(h.messages.length, 0);
  assert.equal(h.queueSent.length, 0);
});

// =============================================================================
// Task 18 — live gates, form-family relay, abort leg, eject-zip, resume fixes
// =============================================================================

test('form-family happy path: exactly one live relay test submission + relayProof in the report', async () => {
  const h = await makeHarness();
  const { msg, token, contractId } = await h.seedBuildGig({
    templateId: 'form',
    brief: FORM_BRIEF,
    goldens: FORM_GOLDENS,
  });

  // First invocation parks awaiting double opt-in (and sends the verification email).
  await processJobMessage(h.cfg, msg);
  const tool = await h.stores.tools.getByBuildContract(contractId);
  const relayRow = await h.stores.relay.get(tool!.toolId);
  await h.stores.relay.verifyByToken(relayRow!.verifyToken);
  h.verifiedDestinations.add('owner@example.com');
  h.setPage(formLivePage());
  h.codegenQueue.push({ result: okCodegen(formSlots(), 0.1) });
  await h.stores.jobs.unpark(msg.jobKey);

  await processJobMessage(h.cfg, msg); // delivers

  // Exactly one live relay TEST submission (distinct from the earlier verification email).
  const testSubmissions = h.mailerSent.filter((m) => /delivery verification/i.test(m.subject));
  assert.equal(testSubmissions.length, 1);
  assert.equal(testSubmissions[0].to, 'owner@example.com');

  // A 'test' relay event was recorded, and the evidence report carries the relay proof.
  const evt = await h.stores.relay.latestEvent(tool!.toolId, 'test');
  assert.equal(evt?.status, 'sent');
  const report = JSON.parse(String(h.deliverables.get(`${token}/report.json`)!.value));
  assert.ok(report.liveGates.relayProof);
  assert.equal(report.liveGates.relayProof.pass, true);
  assert.equal(h.deliverMilestoneCalls.length, 1);
});

test('relay delivery proof: a prior test-mode "validated" event does NOT suppress the real send (F3)', async () => {
  const h = await makeHarness();
  const { msg, token, contractId } = await h.seedBuildGig({
    templateId: 'form',
    brief: FORM_BRIEF,
    goldens: FORM_GOLDENS,
  });

  // First invocation parks awaiting double opt-in.
  await processJobMessage(h.cfg, msg);
  const tool = await h.stores.tools.getByBuildContract(contractId);
  const relayRow = await h.stores.relay.get(tool!.toolId);
  await h.stores.relay.verifyByToken(relayRow!.verifyToken);
  h.verifiedDestinations.add('owner@example.com');
  h.setPage(formLivePage());
  h.codegenQueue.push({ result: okCodegen(formSlots(), 0.1) });
  await h.stores.jobs.unpark(msg.jobKey);

  // Simulate what the live golden run (?jiffytest=1) records: a test-mode relay submission writes a
  // {kind:'test', status:'validated'} event BEFORE stage (d). The fake PageDriver never runs tool
  // JS, so record it by hand — this is the exact event that masked the real send before F3.
  await h.stores.relay.recordEvent({ toolId: tool!.toolId, kind: 'test', status: 'validated' });

  await processJobMessage(h.cfg, msg); // delivers

  // The real delivery-proof email STILL fires despite the prior 'validated' event.
  const testSubmissions = h.mailerSent.filter((m) => /delivery verification/i.test(m.subject));
  assert.equal(testSubmissions.length, 1);
  // A real 'sent' event exists and the evidence report carries a PASSING relay proof with a msgId.
  const sentEvt = await h.stores.relay.latestEvent(tool!.toolId, 'test', 'sent');
  assert.equal(sentEvt?.status, 'sent');
  assert.ok(sentEvt?.messageId);
  const report = JSON.parse(String(h.deliverables.get(`${token}/report.json`)!.value));
  assert.equal(report.liveGates.relayProof.pass, true);
  assert.ok(report.liveGates.relayProof.messageId);
  assert.equal(h.deliverMilestoneCalls.length, 1);
});

test('relay delivery proof: a prior real "sent" event IS reused — exactly-once (F3)', async () => {
  const h = await makeHarness();
  const { msg, contractId } = await h.seedBuildGig({
    templateId: 'form',
    brief: FORM_BRIEF,
    goldens: FORM_GOLDENS,
  });

  await processJobMessage(h.cfg, msg); // parks awaiting double opt-in
  const tool = await h.stores.tools.getByBuildContract(contractId);
  const relayRow = await h.stores.relay.get(tool!.toolId);
  await h.stores.relay.verifyByToken(relayRow!.verifyToken);
  h.verifiedDestinations.add('owner@example.com');
  h.setPage(formLivePage());
  h.codegenQueue.push({ result: okCodegen(formSlots(), 0.1) });
  await h.stores.jobs.unpark(msg.jobKey);

  // A real 'sent' proof already recorded on a prior promote attempt must be REUSED, not re-sent.
  await h.stores.relay.recordEvent({
    toolId: tool!.toolId,
    kind: 'test',
    status: 'sent',
    messageId: 'prior-sent-id',
  });

  await processJobMessage(h.cfg, msg); // delivers

  // No new delivery-proof email — the prior 'sent' event is reused.
  const testSubmissions = h.mailerSent.filter((m) => /delivery verification/i.test(m.subject));
  assert.equal(testSubmissions.length, 0);
  const audits = (await h.stores.audit.listByScope(contractId)).filter((a) => a.gate === 'relay');
  assert.ok(audits.some((a) => a.result === 'reused'));
});

test('PSI outage parks psi_outage (resumable), never delivering', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00'));
  h.psiResult.value = { ok: false, error: 'psi down' };
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  const { msg, jobKey } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await processJobMessage(h.cfg, msg); // controlled park — no throw

  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'parked');
  assert.equal(job?.parkReason, 'psi_outage');
  assert.equal(h.deliverMilestoneCalls.length, 0);
  // Still staged, so a cron re-enqueue resumes cheaply via the staged short-circuit.
  assert.equal(job?.checkpoint?.staged, true);
});

test('PSI accessibility below the floor audits and throws (message.retry), never delivering', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00'));
  h.psiResult.value = { ok: true, performance: 96, accessibility: 85 };
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  const { msg, contractId } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await assert.rejects(processJobMessage(h.cfg, msg), /PSI below thresholds/);

  assert.equal(h.deliverMilestoneCalls.length, 0);
  const audits = await h.stores.audit.listByScope(contractId);
  assert.ok(audits.some((a) => a.gate === 'psi' && a.result === 'below-threshold'));
});

test('element census: a missing footer audits element-contract fail, throws, and never delivers', async () => {
  const h = await makeHarness();
  const page = calcLivePage('$100.00');
  delete page.elements.footer; // present for goldens, absent for the census
  h.setPage(page);
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  const { msg, contractId } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await assert.rejects(processJobMessage(h.cfg, msg), /element-contract/);

  assert.equal(h.deliverMilestoneCalls.length, 0);
  const audits = await h.stores.audit.listByScope(contractId);
  assert.ok(audits.some((a) => a.gate === 'element-contract' && a.result === 'fail'));
});

test('eject-zip verify failure throws before delivery (unit: doctored empty worker script)', async () => {
  // A corrupt eject ZIP is unreachable through a real template (index.html always renders), so
  // this exercises the FR-9 gate directly: an empty worker script makes index.mjs an empty
  // required path, which verifyEjectZip rejects. The full happy path proves the pass side.
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00'));
  const { contractId, jobKey, token } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });
  const def = getTemplate('calculator');
  await h.stores.tools.create({
    toolId: 'tool-ejz',
    slugCandidates: ['ratecalc'],
    templateId: 'calculator',
    templateVersion: def.version,
    buildContractId: contractId,
    name: CALC_BRIEF.name,
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });
  const tool = await h.stores.tools.getByBuildContract(contractId);
  const job = await h.stores.jobs.get(jobKey);
  const contract = await h.cfg.client.getContract(contractId);
  const checkpoint: BuildCheckpoint = {
    slotValues: calcSlots(),
    round: 0,
    spendUsd: 0.1,
    activeMs: 1000,
    staged: true,
    lastFailures: [],
    bankedRound: null,
  };

  await assert.rejects(
    promoteAndDeliver(h.cfg, {
      job: job!,
      tool: tool!,
      def,
      brief: CALC_BRIEF,
      goldens: CALC_GOLDENS,
      slots: calcSlots(),
      script: '', // doctored: empty index.mjs fails the required-path check
      contract,
      checkpoint,
    }),
    /eject-zip/i,
  );

  assert.equal(h.deliverMilestoneCalls.length, 0);
  assert.ok(!h.deliverables.has(`${token}/report.json`));
});

test('abort leg: caps exhausted after all repair rounds — staging deleted, tool killed, buyer asked to cancel', async () => {
  const h = await makeHarness();
  h.setPage(calcPage('$0.00')); // goldens never pass; the live gates are never reached
  for (let i = 0; i < 4; i++) h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  const { msg, jobKey, token, contractId } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await processJobMessage(h.cfg, msg); // abort is a controlled exit — no throw

  // Rounds 0-3 all ran; the FINAL round escalated to Haiku (FR-6).
  assert.equal(h.codegenCalls.length, 4);
  assert.equal(h.codegenCalls[3].escalate, true);
  assert.equal(h.codegenCalls[0].escalate, false);

  // Staging torn down; nothing delivered.
  assert.ok(h.deployerDeletes.includes(stagingSlug(token)));
  assert.equal(h.deliverMilestoneCalls.length, 0);

  // Buyer message: itemized cancel request + a final-round staging-screenshot link + build log.
  const abortMsg = h.messages[h.messages.length - 1].content;
  assert.match(abortMsg, /cancel/i);
  assert.match(abortMsg, /stg-r/);
  assert.match(abortMsg, /\/p\//); // build-log link

  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'aborted');
  const tool = await h.stores.tools.getByBuildContract(contractId);
  assert.equal(tool?.status, 'killed');
});

test('build seam: a tool killed mid-build is not promoted to live (F4)', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00'));
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  const { msg, jobKey, contractId } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  // Kill the tool mid-build: the first staging deploy fires after the tool row exists (stage 4)
  // and before promote (stage 7), so an operator kill here models FR-17 landing mid-build.
  const origPut = h.cfg.deployer.putScript;
  h.cfg.deployer.putScript = async (slug: string, script: string): Promise<void> => {
    await origPut(slug, script);
    if (slug.startsWith('stg-')) {
      const t = await h.stores.tools.getByBuildContract(contractId);
      if (t) await h.stores.tools.setStatus(t.toolId, 'killed');
    }
  };

  await processJobMessage(h.cfg, msg); // aborts gracefully — no throw

  const tool = await h.stores.tools.getByBuildContract(contractId);
  assert.equal(tool?.status, 'killed'); // never flipped to live
  // Never promoted: no putScript on the live (real) slug — only the staging one.
  assert.ok(!h.deployerPuts.some((p) => p.slug === tool!.slug));
  assert.equal(h.deliverMilestoneCalls.length, 0);
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'aborted');
  const audits = await h.stores.audit.listByScope(contractId);
  assert.ok(audits.some((a) => a.gate === 'promotion' && a.result === 'killed-abort'));
});

test('resume: a codegen !ok round consumes a repair round with no staging PUT, then round 1 delivers', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00'));
  h.codegenQueue.push({
    result: { ok: false, errors: ['bad slots'], costUsd: 0.1, model: 'qwen-test' },
  });
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  const { msg, token, jobKey } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await processJobMessage(h.cfg, msg);

  assert.equal(h.codegenCalls.length, 2);
  const stg = stagingSlug(token);
  // Round 0 (!ok) never staged; round 1 did.
  assert.ok(!h.deliverables.has(`${token}/stg-r0-shot-0.png`));
  assert.ok(h.deliverables.has(`${token}/stg-r1-shot-0.png`));
  assert.equal(h.deployerPuts.filter((p) => p.slug === stg).length, 1);
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'delivered');
});

test('resume: a SlotError from render consumes a repair round, then round 1 delivers', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00'));
  const badSlots = { ...calcSlots(), accentHex: 'not-a-hex' }; // fails the style validator in render
  h.codegenQueue.push({ result: okCodegen(badSlots, 0.1) });
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  const { msg, token, jobKey } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await processJobMessage(h.cfg, msg);

  assert.equal(h.codegenCalls.length, 2);
  const stg = stagingSlug(token);
  // Round 0 threw a SlotError before staging; only round 1 staged.
  assert.equal(h.deployerPuts.filter((p) => p.slug === stg).length, 1);
  assert.ok(h.deliverables.has(`${token}/stg-r1-shot-0.png`));
  // The repair round was fed the validator error.
  assert.ok((h.codegenCalls[1].failures ?? []).some((f) => /accentHex/.test(f)));
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'delivered');
});

test('resume: a checkServes throw retries without a second codegen spend (banked round)', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00'));
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  h.serves.throwOnce = true; // first stage attempt: the serve probe throws (transient)
  const { msg, jobKey } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await assert.rejects(processJobMessage(h.cfg, msg), /transient binding error/);
  // Codegen ran once and was BANKED (slots + spend persisted before the deploy/serve probe).
  const cp1 = (await h.stores.jobs.get(jobKey))?.checkpoint;
  assert.equal(cp1?.bankedRound, 0);
  assert.equal(cp1?.spendUsd, 0.1);
  assert.equal(h.codegenCalls.length, 1);

  // Retry: serve probe now OK; the banked round is re-used — no re-generation, no double spend.
  await processJobMessage(h.cfg, msg);
  assert.equal(h.codegenCalls.length, 1);
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'delivered');
  assert.equal(job?.checkpoint?.spendUsd, 0.1);
});

test('staged short-circuit: a promote-time throw re-enters at promote, skipping codegen AND moderation', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00'));
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  h.fetchStatuses.push(404, 404); // both live-reachability probes fail on the first promote
  const { msg, jobKey } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  // First invocation reaches green staging, promotes, then the reachability gate throws.
  await assert.rejects(processJobMessage(h.cfg, msg), /reachability/);
  assert.equal(h.codegenCalls.length, 1);
  assert.equal((await h.stores.jobs.get(jobKey))?.checkpoint?.staged, true);

  // Re-entry: moderation would THROW if the pipeline re-ran stages 3-5, and codegen must not
  // re-run. The staged short-circuit re-renders from banked slots and jumps straight to promote.
  h.moderationThrow.value = true;
  await processJobMessage(h.cfg, msg); // reachability now defaults to 200 → delivers

  assert.equal(h.codegenCalls.length, 1); // no regeneration
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'delivered');
  assert.equal(h.deliverMilestoneCalls.length, 1);
});

// =============================================================================
// Delivery idempotency across a promote retry — a throw AFTER the relay test send or AFTER a
// platform-accepted deliverMilestone must not re-send a real email or dead-letter an already-
// delivered job.
// =============================================================================

test('relay test send is exactly-once across a promote retry', async () => {
  const h = await makeHarness();
  const { msg, token, contractId } = await h.seedBuildGig({
    templateId: 'form',
    brief: FORM_BRIEF,
    goldens: FORM_GOLDENS,
  });

  // First invocation parks awaiting double opt-in (and sends the verification email).
  await processJobMessage(h.cfg, msg);
  const tool = await h.stores.tools.getByBuildContract(contractId);
  const relayRow = await h.stores.relay.get(tool!.toolId);
  await h.stores.relay.verifyByToken(relayRow!.verifyToken);
  h.verifiedDestinations.add('owner@example.com');
  h.setPage(formLivePage());
  h.codegenQueue.push({ result: okCodegen(formSlots(), 0.1) });
  await h.stores.jobs.unpark(msg.jobKey);

  // First promoteAndDeliver pass: the relay test send succeeds, but deliverMilestone throws — a
  // genuine failure (the refetched contract still shows the milestone 'funded') — so the queue
  // retries the whole message.
  h.deliverMilestoneQueue.push(new Error('platform blip'));
  await assert.rejects(processJobMessage(h.cfg, msg), /platform blip/);

  const afterFirstPass = h.mailerSent.filter((m) => /delivery verification/i.test(m.subject));
  assert.equal(afterFirstPass.length, 1);
  assert.equal(h.deliverMilestoneCalls.length, 1);
  assert.equal((await h.stores.jobs.get(msg.jobKey))?.checkpoint?.staged, true);

  // Retry (the staged short-circuit re-enters at promote): deliverMilestone now succeeds, but the
  // relay test send must NOT be re-sent — it reuses the recorded messageId instead.
  await processJobMessage(h.cfg, msg); // completes

  const testSubmissions = h.mailerSent.filter((m) => /delivery verification/i.test(m.subject));
  assert.equal(testSubmissions.length, 1); // still exactly one across BOTH promote attempts
  assert.equal(h.deliverMilestoneCalls.length, 2); // the failed attempt + the succeeding retry

  const report = JSON.parse(String(h.deliverables.get(`${token}/report.json`)!.value));
  assert.ok(report.liveGates.relayProof);
  assert.equal(report.liveGates.relayProof.pass, true);
  // The reused messageId in the final report is the ONE 'test' event ever recorded — proving the
  // retry's relayProof came from the reuse path, not a second send.
  const relayEvent = await h.stores.relay.latestEvent(tool!.toolId, 'test');
  assert.equal(report.liveGates.relayProof.messageId, relayEvent?.messageId);

  const job = await h.stores.jobs.get(msg.jobKey);
  assert.equal(job?.outcome, 'delivered');

  const relayAudits = (await h.stores.audit.listByScope(contractId)).filter(
    (a) => a.gate === 'relay',
  );
  assert.ok(relayAudits.some((a) => a.result === 'sent'));
  assert.ok(relayAudits.some((a) => a.result === 'reused'));
});

test('deliverMilestone retry after platform-side success completes the job', async () => {
  const h = await makeHarness();
  const { msg, contractId } = await h.seedBuildGig({
    templateId: 'form',
    brief: FORM_BRIEF,
    goldens: FORM_GOLDENS,
  });

  await processJobMessage(h.cfg, msg); // parks awaiting double opt-in
  const tool = await h.stores.tools.getByBuildContract(contractId);
  const relayRow = await h.stores.relay.get(tool!.toolId);
  await h.stores.relay.verifyByToken(relayRow!.verifyToken);
  h.verifiedDestinations.add('owner@example.com');
  h.setPage(formLivePage());
  h.codegenQueue.push({ result: okCodegen(formSlots(), 0.1) });
  await h.stores.jobs.unpark(msg.jobKey);

  // Simulate a local D1 write failing AFTER the platform accepted deliverMilestone: markDelivered
  // throws exactly once (monkeypatched on the shared store instance underlying cfg.jobs).
  const originalMarkDelivered = h.cfg.jobs.markDelivered.bind(h.cfg.jobs);
  let markDeliveredCalls = 0;
  h.cfg.jobs.markDelivered = async (jobKey, outcome) => {
    markDeliveredCalls += 1;
    if (markDeliveredCalls === 1) throw new Error('d1 write failed (simulated)');
    return originalMarkDelivered(jobKey, outcome);
  };

  // getContract is called once per invocation at Stage 2 (to locate the funded milestone) plus
  // once more by the idempotency guard whenever deliverMilestone throws. Calls 1 and 2 (Run 1's
  // stage-2 fetch, and Run 2's stage-2 fetch) must still show the milestone 'funded' — otherwise
  // the pipeline never gets far enough to attempt delivery at all. Only call 3 — Run 2's guard
  // refetch, AFTER deliverMilestone's second (throwing) call — reflects the platform having
  // actually accepted Run 1's delivery, i.e. 'delivered'.
  let getContractCalls = 0;
  const originalGetContract = h.cfg.client.getContract.bind(h.cfg.client);
  h.cfg.client.getContract = async (id: string) => {
    getContractCalls += 1;
    const c = await originalGetContract(id);
    if (getContractCalls < 3) return c;
    return {
      ...c,
      milestones: c.milestones.map((m) => (m.id === 'm1' ? { ...m, status: 'delivered' } : m)),
    };
  };

  // First run: deliverMilestone SUCCEEDS (the platform accepts it), but the tail markDelivered
  // write throws — the whole message is retried by the queue.
  await assert.rejects(processJobMessage(h.cfg, msg), /d1 write failed/);
  assert.equal(h.deliverMilestoneCalls.length, 1);

  // Second run (retry, via the staged short-circuit): deliverMilestone is attempted again — the
  // platform rejects re-delivery of an already-delivered milestone — but the guard's refetch shows
  // the milestone 'delivered', so the pipeline treats it as already-accepted and completes through
  // to markDelivered rather than dead-lettering an otherwise successfully-delivered job.
  h.deliverMilestoneQueue.push(new Error('milestone already delivered'));
  await processJobMessage(h.cfg, msg); // completes

  assert.equal(h.deliverMilestoneCalls.length, 2);
  assert.equal(getContractCalls, 3);
  const job = await h.stores.jobs.get(msg.jobKey);
  assert.equal(job?.outcome, 'delivered');

  const audits = await h.stores.audit.listByScope(contractId);
  assert.ok(audits.some((a) => a.gate === 'delivery' && a.result === 'delivery-already-accepted'));
});

// =============================================================================
// Task 22 — thread-driven bounded edits: the re-gated re-run through processEditJob
// =============================================================================

// A recompiled golden set that still passes on calcLivePage('$100.00') but differs from
// CALC_GOLDENS (first title changed), so an assertion that tool.goldens flipped is meaningful.
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

test('edit happy path: constrained codegen (instruction + current slots) → promote → live gates → tool updated', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00'));
  h.recompileResult.value = { ok: true, set: UPDATED_CALC_GOLDENS, costUsd: 0.05 };
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  const { msg, jobKey, toolId, requestId } = await h.seedEditJob({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
    slots: calcSlots(),
    instruction: 'change the headline to Rate Estimator',
  });

  await processJobMessage(h.cfg, msg); // completes to a delivered edit — no throw

  // Codegen was constrained: it received the edit instruction and started from the tool's slots.
  assert.equal(h.codegenCalls.length, 1);
  assert.equal(h.codegenCalls[0].instruction, 'change the headline to Rate Estimator');
  assert.deepEqual(h.codegenCalls[0].priorSlots, getTemplate('calculator').referenceSlots);
  // The recompiler saw the tool's current goldens.
  assert.equal(h.recompileCalls.length, 1);
  assert.deepEqual(h.recompileCalls[0].currentGoldens, CALC_GOLDENS);

  // Promoted over the LIVE slug and re-ran the live gates (PSI against the live URL).
  const tool = await h.stores.tools.get(toolId);
  assert.equal(tool?.status, 'live');
  assert.ok(h.psiCalls.includes(`https://${tool!.slug}.${TOOL_HOST_SUFFIX}`));
  assert.ok(h.deployerPuts.some((p) => p.slug === tool!.slug));

  // The tool now carries the updated goldens + slots; the request is done; the job delivered.
  assert.deepEqual(tool?.goldens, UPDATED_CALC_GOLDENS);
  assert.deepEqual(tool?.slots, calcSlots());
  assert.equal((await h.stores.edits.get(requestId))?.status, 'done');
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'delivered');
  assert.equal(job?.outcome, 'delivered');
  // No milestone is delivered for an edit — it lands as a thread message.
  assert.equal(h.deliverMilestoneCalls.length, 0);
  assert.match(h.messages[h.messages.length - 1].content, /is live/i);
});

test('edit non-convergence: caps exhausted → live tool UNCHANGED, quota released, job aborted', async () => {
  const h = await makeHarness();
  h.setPage(calcPage('$0.00')); // staging goldens never pass
  h.recompileResult.value = { ok: true, set: UPDATED_CALC_GOLDENS, costUsd: 0.05 };
  for (let i = 0; i < 4; i++) h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  const { msg, jobKey, toolId, contractId, requestId } = await h.seedEditJob({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
    slots: calcSlots(),
    instruction: 'make the result bigger',
  });

  await processJobMessage(h.cfg, msg); // edit abort is a controlled exit — no throw

  // The live tool is untouched: original goldens, original slots, still live, never re-promoted.
  const tool = await h.stores.tools.get(toolId);
  assert.deepEqual(tool?.goldens, CALC_GOLDENS);
  assert.deepEqual(tool?.slots, calcSlots());
  assert.ok(!h.deployerPuts.some((p) => p.slug === tool!.slug));

  // The request failed and the reserved quota was released back to 0.
  assert.equal((await h.stores.edits.get(requestId))?.status, 'failed');
  assert.equal(await h.stores.usage.getUsed(`edit:${toolId}`, contractId), 0);

  // The job aborted; the buyer was told the live tool is unchanged.
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'aborted');
  assert.match(h.messages[h.messages.length - 1].content, /unchanged/i);
});

test('edit recompile failure: rejected, quota released, buyer asked to rephrase, nothing regenerated', async () => {
  const h = await makeHarness();
  h.recompileResult.value = { ok: false, errors: ['cannot map edit to a golden'], costUsd: 0.02 };
  const { msg, jobKey, toolId, contractId, requestId } = await h.seedEditJob({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
    slots: calcSlots(),
    instruction: 'do something impossible',
  });

  await processJobMessage(h.cfg, msg);

  assert.equal(h.codegenCalls.length, 0); // never reached codegen
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'delivered');
  assert.equal(job?.outcome, 'rejected');
  assert.equal((await h.stores.edits.get(requestId))?.status, 'failed');
  assert.equal(await h.stores.usage.getUsed(`edit:${toolId}`, contractId), 0);
  assert.match(h.messages[h.messages.length - 1].content, /re-post|rephrase/i);
});

test('edit template-version mismatch: parks template_version_mismatch, releases quota, regenerates nothing', async () => {
  const h = await makeHarness();
  h.recompileResult.value = { ok: true, set: UPDATED_CALC_GOLDENS, costUsd: 0.05 };
  const { msg, jobKey, toolId, contractId, requestId } = await h.seedEditJob({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
    slots: calcSlots(),
    instruction: 'change the headline',
  });
  // Pin the delivered tool to a stale template version the registry no longer serves.
  await h.db
    .prepare('UPDATE tools SET template_version = ? WHERE tool_id = ?')
    .bind('0.9.0', toolId)
    .run();

  await processJobMessage(h.cfg, msg);

  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'parked');
  assert.equal(job?.parkReason, 'template_version_mismatch');
  assert.equal(h.codegenCalls.length, 0);
  assert.equal(h.recompileCalls.length, 0);
  assert.equal((await h.stores.edits.get(requestId))?.status, 'failed');
  assert.equal(await h.stores.usage.getUsed(`edit:${toolId}`, contractId), 0);
});

test('edit re-entry: a promote-time throw resumes via the staged short-circuit without re-codegen/re-recompile', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00'));
  h.recompileResult.value = { ok: true, set: UPDATED_CALC_GOLDENS, costUsd: 0.05 };
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  h.fetchStatuses.push(404, 404); // both live-reachability probes fail on the first promote
  const { msg, jobKey, toolId, requestId } = await h.seedEditJob({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
    slots: calcSlots(),
    instruction: 'change the headline',
  });

  // First invocation: green staging, then the reachability gate throws on promote.
  await assert.rejects(processJobMessage(h.cfg, msg), /reachability/);
  assert.equal(h.codegenCalls.length, 1);
  assert.equal(h.recompileCalls.length, 1);
  assert.equal((await h.stores.jobs.get(jobKey))?.checkpoint?.staged, true);

  // Re-entry: recompile would now FAIL if it ran — proving the staged short-circuit skips it (and
  // codegen). Reachability defaults to 200, so the edit completes.
  h.recompileResult.value = { ok: false, errors: ['should not be called'], costUsd: 0 };
  await processJobMessage(h.cfg, msg);

  assert.equal(h.codegenCalls.length, 1); // no regeneration
  assert.equal(h.recompileCalls.length, 1); // no re-recompile
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'delivered');
  assert.deepEqual((await h.stores.tools.get(toolId))?.goldens, UPDATED_CALC_GOLDENS);
  assert.equal((await h.stores.edits.get(requestId))?.status, 'done');
});

// =============================================================================
// F2 — edit restore-last-good on a live-gate failure: an edit that promotes but then fails a
// LIVE gate must not leave the gate-failing version serving. Restore the prior-good render,
// abort the edit terminally (no throw/retry), release quota, and tell the buyer.
// =============================================================================

// Prior-good slots distinct from the codegen'd NEW slots (calcSlots()), so a restore is provable.
function priorGoodSlots(): SlotValues {
  return { ...calcSlots(), accentHex: '#123456' };
}

test('edit live goldens fail post-promote: restores last-good, aborts, releases quota, no throw (F2)', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00')); // passes staging (and would pass live)
  h.recompileResult.value = { ok: true, set: UPDATED_CALC_GOLDENS, costUsd: 0.05 };
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  const prior = priorGoodSlots();
  const { msg, jobKey, toolId, contractId, requestId } = await h.seedEditJob({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
    slots: prior,
    instruction: 'change the headline',
  });

  // Swap the page to a FAILING one on the reachability probe — it fires after staging-green and
  // before the live goldens — so staging passes but the live 'computes total' golden fails.
  h.cfg.fetchImpl = (async () => {
    h.setPage(calcLivePage('$0.00'));
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;

  await processJobMessage(h.cfg, msg); // TERMINAL restore — no throw

  const tool = await h.stores.tools.get(toolId);
  assert.equal(tool?.status, 'live');
  // Restored to the prior-good slots (DB) + the goldens are unchanged (the edit did not take).
  assert.deepEqual(tool?.slots, prior);
  assert.deepEqual(tool?.goldens, CALC_GOLDENS);
  // The LAST putScript on the live slug is the restore (prior script), not the gate-failing one.
  const livePuts = h.deployerPuts.filter((p) => p.slug === tool!.slug);
  assert.ok(livePuts.length >= 2, 'expected a failing promote then a restore putScript');
  // Quota released, request failed, job aborted, buyer told it was restored.
  assert.equal((await h.stores.edits.get(requestId))?.status, 'failed');
  assert.equal(await h.stores.usage.getUsed(`edit:${toolId}`, contractId), 0);
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'aborted');
  assert.match(h.messages[h.messages.length - 1].content, /previous working version|restored/i);
  const audits = await h.stores.audit.listByScope(contractId);
  assert.ok(audits.some((a) => a.gate === 'edit' && a.result === 'restored'));
});

test('edit live PSI below threshold: restores last-good, aborts (F2)', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00'));
  h.recompileResult.value = { ok: true, set: UPDATED_CALC_GOLDENS, costUsd: 0.05 };
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  h.psiResult.value = { ok: true, performance: 96, accessibility: 85 }; // below the a11y floor
  const prior = priorGoodSlots();
  const { msg, jobKey, toolId, contractId, requestId } = await h.seedEditJob({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
    slots: prior,
    instruction: 'change the headline',
  });

  await processJobMessage(h.cfg, msg); // TERMINAL restore — no throw

  const tool = await h.stores.tools.get(toolId);
  assert.equal(tool?.status, 'live');
  assert.deepEqual(tool?.slots, prior); // restored to prior-good
  assert.deepEqual(tool?.goldens, CALC_GOLDENS);
  assert.equal((await h.stores.edits.get(requestId))?.status, 'failed');
  assert.equal(await h.stores.usage.getUsed(`edit:${toolId}`, contractId), 0);
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'aborted');
  const audits = await h.stores.audit.listByScope(contractId);
  assert.ok(audits.some((a) => a.gate === 'edit' && a.result === 'restored'));
});

test('edit PSI outage then below-threshold on retry: restores from persisted priorSlots, not the overwritten tool.slots (F2)', async () => {
  const h = await makeHarness();
  h.setPage(calcLivePage('$100.00'));
  h.recompileResult.value = { ok: true, set: UPDATED_CALC_GOLDENS, costUsd: 0.05 };
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  h.psiResult.value = { ok: false, error: 'psi down' }; // first pass: outage → park
  const prior = priorGoodSlots();
  const { msg, jobKey, toolId, contractId, requestId } = await h.seedEditJob({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
    slots: prior,
    instruction: 'change the headline',
  });

  // First pass: promote runs (NEW slots go live), PSI outage parks psi_outage (resumable).
  await processJobMessage(h.cfg, msg);
  let job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.status, 'parked');
  assert.equal(job?.parkReason, 'psi_outage');
  // The prior-good slots were captured before the promote and persisted on the checkpoint.
  assert.deepEqual(job?.checkpoint?.priorSlots, prior);
  // The DB live slots are now the NEW slots — promote overwrote them.
  assert.deepEqual((await h.stores.tools.get(toolId))?.slots, calcSlots());

  // Retry (staged short-circuit): PSI now below-threshold → restore. Recompile MUST NOT re-run.
  h.recompileResult.value = { ok: false, errors: ['should not be called'], costUsd: 0 };
  h.psiResult.value = { ok: true, performance: 96, accessibility: 85 };
  await h.stores.jobs.unpark(jobKey);
  await processJobMessage(h.cfg, msg); // TERMINAL restore — no throw

  const tool = await h.stores.tools.get(toolId);
  assert.equal(tool?.status, 'live');
  // Restored to the PERSISTED priorSlots, NOT the overwritten tool.slots (which were calcSlots()).
  assert.deepEqual(tool?.slots, prior);
  assert.equal(h.recompileCalls.length, 1); // no re-recompile (staged short-circuit)
  assert.equal(h.codegenCalls.length, 1); // no regeneration
  assert.equal((await h.stores.edits.get(requestId))?.status, 'failed');
  assert.equal(await h.stores.usage.getUsed(`edit:${toolId}`, contractId), 0);
  job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.outcome, 'aborted');
});
