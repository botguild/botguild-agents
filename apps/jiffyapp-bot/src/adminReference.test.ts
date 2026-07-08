// Live reference-check probe (Task 23 / PART B): runReferenceCheck over scripted deployer/
// browser/PSI fakes + a real (memory-D1) audit store. Proves the relay-family golden filter
// (form drops its success-submission golden), that per-phase timings are recorded, and that the
// staging script is torn down even when the probe throws mid-run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import { applyMigrations } from './testSupport.js';
import { createAuditStore } from './jobs.js';
import type { PageDriver } from './assertPlan.js';
import type { PsiResult } from './psi.js';
import type { PipelineConfig } from './pipeline.js';
import type { TemplateId } from './types.js';
import { runReferenceCheck, referenceStagingSlug } from './adminReference.js';

const logger = createConsoleLogger({ service: 'test', level: 'silent' });
const TOOL_HOST_SUFFIX = 'jiffyapp.dev';
const PUBLIC_BASE_URL = 'https://jiffyapp-bot.example.com';

// A permissive page driver — the focused test asserts on filtering/timings/teardown, not on
// whether each reference golden passes, so it just answers every query benignly.
function fakeDriver(): PageDriver {
  return {
    async goto() {},
    async fill() {},
    async setChecked() {},
    async selectOption() {},
    async click() {},
    async uploadFile() {},
    async textContent() {
      return null;
    },
    async getAttribute() {
      return null;
    },
    async count() {
      return 1;
    },
    async isVisible() {
      return true;
    },
    async title() {
      return '';
    },
    async metaContent() {
      return null;
    },
    async screenshot() {
      return new Uint8Array([1]);
    },
    async close() {},
  };
}

interface Harness {
  cfg: PipelineConfig;
  puts: string[];
  deletes: string[];
  checkServesCalls: string[];
  psiCalls: string[];
  psiResult: { value: PsiResult };
  psiThrow: { value: boolean };
}

async function makeHarness(): Promise<Harness> {
  const db = createMemoryD1();
  await applyMigrations(db);
  const audit = createAuditStore(db);

  const puts: string[] = [];
  const deletes: string[] = [];
  const checkServesCalls: string[] = [];
  const psiCalls: string[] = [];
  const psiResult = { value: { ok: true, performance: 98, accessibility: 99 } as PsiResult };
  const psiThrow = { value: false };

  // Monotonic tick clock: every read advances 5ms, so each phase records a positive duration.
  let ms = Date.UTC(2026, 6, 1, 0, 0, 0);
  const now = (): Date => {
    const at = new Date(ms);
    ms += 5;
    return at;
  };

  const stub = (name: string): (() => never) => {
    return () => {
      throw new Error(`${name}: not used by the reference check`);
    };
  };

  const cfg = {
    audit,
    deployer: {
      async putScript(slug: string): Promise<void> {
        puts.push(slug);
      },
      async deleteScript(slug: string): Promise<void> {
        deletes.push(slug);
      },
      async checkServes(slug: string): Promise<{ ok: boolean; status: number }> {
        checkServesCalls.push(slug);
        return { ok: true, status: 200 };
      },
    },
    openPage: async (): Promise<PageDriver> => fakeDriver(),
    psi: {
      async run(url: string): Promise<PsiResult> {
        psiCalls.push(url);
        if (psiThrow.value) throw new Error('PSI fake: simulated mid-run throw');
        return psiResult.value;
      },
    },
    // Unused seams — throwing stubs prove the reference check never touches them.
    jobs: stub('jobs'),
    tools: stub('tools'),
    gigs: stub('gigs'),
    cycles: stub('cycles'),
    usage: stub('usage'),
    edits: stub('edits'),
    relay: stub('relay'),
    buildLog: stub('buildLog'),
    client: stub('client'),
    codegen: stub('codegen'),
    compiler: stub('compiler'),
    emailRouting: stub('emailRouting'),
    closeBrowser: async (): Promise<void> => {},
    moderation: stub('moderation'),
    mailer: stub('mailer'),
    deliverables: stub('deliverables'),
    queue: stub('queue'),
    fetchImpl: stub('fetchImpl'),
    publicBaseUrl: PUBLIC_BASE_URL,
    toolHostSuffix: TOOL_HOST_SUFFIX,
    relayFromAddress: 'forms@jiffyapp.dev',
    logger,
    now,
  } as unknown as PipelineConfig;

  return { cfg, puts, deletes, checkServesCalls, psiCalls, psiResult, psiThrow };
}

test('runReferenceCheck (form): drops the success-submission golden and reports the filtered count', async () => {
  const h = await makeHarness();
  const result = await runReferenceCheck(h.cfg, 'form');

  const slug = referenceStagingSlug('form');
  assert.equal(result.stagingSlug, slug);
  assert.equal(result.templateId, 'form');
  // form has 3 reference goldens; the one asserting visible(success-msg) is filtered.
  assert.equal(result.goldensFiltered, 1);
  assert.equal(result.goldens.outcomes.length, 2);

  // Deploy → checkServes → teardown all hit the fixed staging slug.
  assert.deepEqual(h.puts, [slug]);
  assert.deepEqual(h.checkServesCalls, [slug]);
  assert.deepEqual(h.deletes, [slug]);
  assert.equal(result.teardown, 'deleted');

  // PSI ran against the CLEAN staging URL (no ?jiffytest).
  assert.deepEqual(h.psiCalls, [`https://${slug}.${TOOL_HOST_SUFFIX}`]);
  assert.equal(result.psi.ok, true);

  // The rendered FileSet is reported and includes the entry page.
  assert.ok(result.render.files.includes('/index.html'));

  // Every phase recorded a positive, finite duration.
  for (const key of ['renderMs', 'deployMs', 'assertMs', 'psiMs'] as const) {
    assert.equal(typeof result.timings[key], 'number');
    assert.ok(result.timings[key] >= 0, `${key} should be >= 0`);
  }

  // A reference-check audit row was written.
  const rows = await h.cfg.audit.listByScope('reference:form');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gate, 'reference-check');
});

test('runReferenceCheck (calculator): a non-relay template runs the full golden set (0 filtered)', async () => {
  const h = await makeHarness();
  const result = await runReferenceCheck(h.cfg, 'calculator');
  assert.equal(result.goldensFiltered, 0);
  assert.equal(result.goldens.outcomes.length, 3);
  assert.equal(result.teardown, 'deleted');
});

test('runReferenceCheck: a throw mid-run still tears down the staging script and propagates', async () => {
  const h = await makeHarness();
  h.psiThrow.value = true;

  await assert.rejects(() => runReferenceCheck(h.cfg, 'calculator'), /simulated mid-run throw/);

  // Teardown ran despite the throw — no orphan staging script left behind.
  const slug = referenceStagingSlug('calculator');
  assert.deepEqual(h.deletes, [slug]);
});

test('runReferenceCheck: quiz and waitlist are relay-family (quiz has no success-visible golden)', async () => {
  const h = await makeHarness();
  // quiz reference goldens never bind success-msg, so nothing is filtered even though it's relay.
  const quiz = await runReferenceCheck(h.cfg, 'quiz' as TemplateId);
  assert.equal(quiz.goldensFiltered, 0);

  const h2 = await makeHarness();
  const waitlist = await runReferenceCheck(h2.cfg, 'waitlist' as TemplateId);
  assert.equal(waitlist.goldensFiltered, 1);
});
