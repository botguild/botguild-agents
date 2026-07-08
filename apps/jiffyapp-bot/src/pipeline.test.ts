// Build pipeline (Task 17): the codegen → stage → assert → repair loop driven to GREEN
// STAGING, exercised end-to-end over REAL D1-backed stores (in-memory sqlite, migrations
// applied) with every external effect behind a recording/scripted fake. `makeHarness()` is
// exported for Task 18 to extend (it adds the promote/live-gates/deliver cases on top of the
// same seams). The Task-18 stubs `promoteAndDeliver`/`abortJob` throw `not implemented`, so
// this task's happy path deliberately ends by catching `not implemented: promote`, and the
// cap/deadline paths by catching `not implemented: abort`.

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
import { getTemplate } from './templates/registry.js';
import { stagingSlug } from './slug.js';
import type { PageDriver } from './assertPlan.js';
import type { CodegenArgs, CodegenResult } from './codegen.js';
import type { ModerationOutcome } from './moderation.js';
import type { PsiResult } from './psi.js';
import type { GoldenSet, JiffyBrief, JobMessage, SlotValues, TemplateId } from './types.js';
import { processJobMessage, type PipelineClient, type PipelineConfig } from './pipeline.js';

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
    { title: 'success hidden on load', steps: [], expect: [{ testid: 'success-msg', hidden: true }] },
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
function formPage(): PageState {
  return newPage({ title: 'Get in touch', elements: { 'success-msg': [{ visible: false }] } });
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
  };
  page: PageState;
  setPage: (state: PageState) => void;
  codegenQueue: Array<{ result: CodegenResult; onCall?: (args: CodegenArgs) => void }>;
  codegenCalls: CodegenArgs[];
  moderationText: ModerationOutcome[];
  moderationTextCalls: string[];
  serves: { value: { ok: boolean; status: number } };
  deployerPuts: Array<{ slug: string; script: string }>;
  checkServesCalls: string[];
  messages: Array<{ contractId: string; content: string }>;
  queueSent: JobMessage[];
  mailerSent: Array<{ to: string; from: string; subject: string; text: string }>;
  ensuredDestinations: string[];
  verifiedDestinations: Set<string>;
  deliverables: Map<string, { value: string | Uint8Array; contentType: string }>;
  seedBuildGig: (opts: {
    templateId: TemplateId;
    brief: JiffyBrief;
    goldens: GoldenSet;
    contractId?: string;
    gigId?: string;
  }) => Promise<{ contractId: string; gigId: string; jobKey: string; token: string; msg: JobMessage }>;
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
  const moderation = {
    async moderate(text: string): Promise<ModerationOutcome> {
      moderationTextCalls.push(text);
      return moderationText.shift() ?? PASS;
    },
    async moderateImage(): Promise<ModerationOutcome> {
      return PASS;
    },
  };

  const serves = { value: { ok: true, status: 200 } };
  const deployerPuts: Array<{ slug: string; script: string }> = [];
  const checkServesCalls: string[] = [];
  const deployer = {
    async putScript(slug: string, script: string): Promise<void> {
      deployerPuts.push({ slug, script });
    },
    async deleteScript(): Promise<void> {},
    async checkServes(slug: string): Promise<{ ok: boolean; status: number }> {
      checkServesCalls.push(slug);
      return serves.value;
    },
  };

  const contracts = new Map<string, Contract>();
  const gigsById = new Map<string, Gig>();
  const messages: Array<{ contractId: string; content: string }> = [];
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

  const compiler = {
    async compile(): Promise<{ ok: false; errors: string[]; costUsd: number }> {
      return { ok: false, errors: ['compiler not scripted for this test'], costUsd: 0 };
    },
  };

  const psi = {
    async run(): Promise<PsiResult> {
      return { ok: true, performance: 96, accessibility: 97 };
    },
  };

  const fetchImpl = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;

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
    gigsById.set(gigId, { id: gigId, title: brief.name, description: brief.description } as unknown as Gig);
    const hash = await sha256Hex(contractId);
    const jobKey = jobKeyFor(hash, 'build');
    await jobs.claim({ jobKey, contractId, kind: 'build', gigId });
    const job = await jobs.get(jobKey);
    return { contractId, gigId, jobKey, token: job!.deliverableToken, msg: { kind: 'build', contractId, jobKey } };
  };

  return {
    cfg,
    db,
    clock,
    stores: { jobs, tools, gigs, relay, audit, buildLog },
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
    serves,
    deployerPuts,
    checkServesCalls,
    messages,
    queueSent,
    mailerSent,
    ensuredDestinations,
    verifiedDestinations,
    deliverables,
    seedBuildGig,
  };
}

// =============================================================================
// Cases
// =============================================================================

test('happy path: reaches green staging in round 0 and hands off to promote', async () => {
  const h = await makeHarness();
  h.setPage(calcPage('$100.00'));
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  const { msg, token, jobKey } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await assert.rejects(processJobMessage(h.cfg, msg), /not implemented: promote/);

  // One staging PUT under stg-<token24>, checked by the in-namespace serve probe.
  const stg = stagingSlug(token);
  assert.equal(h.deployerPuts.length, 1);
  assert.equal(h.deployerPuts[0].slug, stg);
  assert.ok(h.checkServesCalls.includes(stg));

  // Golden run hit the browser-reachable staging URL with test mode on.
  assert.ok(h.page.gotoUrls.length > 0);
  assert.ok(h.page.gotoUrls.every((u) => u === `https://${stg}.${TOOL_HOST_SUFFIX}/?jiffytest=1`));

  // Screenshots for every golden, stored under <token>/stg-r0-shot-*.png.
  for (let i = 0; i < CALC_GOLDENS.goldens.length; i++) {
    assert.ok(h.deliverables.has(`${token}/stg-r0-shot-${i}.png`), `missing screenshot ${i}`);
  }

  // Checkpoint: staged, round 0, active time banked.
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.checkpoint?.staged, true);
  assert.equal(job?.checkpoint?.round, 0);
  assert.ok((job?.checkpoint?.activeMs ?? 0) > 0);

  // Build log carries codegen / stage / assert entries.
  const stages = new Set((await h.stores.buildLog.since(token, 0)).map((e) => e.stage));
  assert.ok(stages.has('codegen') && stages.has('stage') && stages.has('assert'));
});

test('repair loop: round 0 fails, round 1 gets failures + priorSlots and passes', async () => {
  const h = await makeHarness();
  h.setPage(calcPage('$0.00')); // round 0: result is wrong
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.1) });
  h.codegenQueue.push({
    result: okCodegen(calcSlots(), 0.1),
    onCall: () => {
      h.page.elements.result = [{ text: '$100.00', visible: true }]; // repair fixes the page
    },
  });
  const { msg, token, jobKey } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await assert.rejects(processJobMessage(h.cfg, msg), /not implemented: promote/);

  // Round 1 codegen received the prior slots + the round-0 failures.
  assert.equal(h.codegenCalls.length, 2);
  assert.ok(h.codegenCalls[1].priorSlots !== undefined);
  assert.deepEqual(h.codegenCalls[1].priorSlots, getTemplate('calculator').referenceSlots);
  assert.ok((h.codegenCalls[1].failures ?? []).length > 0);

  // Two staging PUTs (r0 + r1); checkpoint records repair round 1.
  assert.equal(h.deployerPuts.length, 2);
  const job = await h.stores.jobs.get(jobKey);
  assert.equal(job?.checkpoint?.round, 1);
  assert.equal(job?.repairRounds, 1);
  assert.equal(job?.checkpoint?.staged, true);

  // Screenshots exist for both rounds.
  assert.ok(h.deliverables.has(`${token}/stg-r0-shot-0.png`));
  assert.ok(h.deliverables.has(`${token}/stg-r1-shot-0.png`));
});

test('spend cap: exhausting MAX_SPEND_USD aborts (never promotes) and audits cap-exhausted', async () => {
  const h = await makeHarness();
  h.setPage(calcPage('$0.00')); // goldens never pass
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.3) });
  h.codegenQueue.push({ result: okCodegen(calcSlots(), 0.3) });
  const { msg, contractId } = await h.seedBuildGig({
    templateId: 'calculator',
    brief: CALC_BRIEF,
    goldens: CALC_GOLDENS,
  });

  await assert.rejects(processJobMessage(h.cfg, msg), /not implemented: abort/);

  // Two rounds ran (0.3 + 0.3 = 0.6 ≥ 0.5), then the spend precheck broke to abort.
  assert.equal(h.codegenCalls.length, 2);
  assert.equal(h.deployerPuts.length, 2);
  const audits = await h.stores.audit.listByScope(contractId);
  assert.ok(audits.some((a) => a.result === 'cap-exhausted'));
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
  h.setPage(formPage());
  h.codegenQueue.push({ result: okCodegen(formSlots(), 0.1) });
  h.clock.advance(2 * 24 * 60 * 60 * 1000);
  await h.stores.jobs.unpark(msg.jobKey);

  // It must proceed all the way to the promote hand-off — an abort would mean the parked
  // wait was wrongly counted against the active-time cap.
  await assert.rejects(processJobMessage(h.cfg, msg), /not implemented: promote/);

  const job = await h.stores.jobs.get(msg.jobKey);
  assert.equal(job?.checkpoint?.staged, true);
  assert.ok((job?.checkpoint?.activeMs ?? 0) < 25 * 60_000);
  assert.equal(h.mailerSent.length, 1); // not re-sent on resume
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
  };
  await h.stores.jobs.saveCheckpoint(jobKey, over);

  await assert.rejects(processJobMessage(h.cfg, msg), /not implemented: abort/);
  assert.equal(h.deployerPuts.length, 0);
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
