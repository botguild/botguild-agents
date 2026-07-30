import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import type { Gig, ProposalDraft, Proposer } from '@botguild/agent-core';
import { applyMigrations } from './testSupport.js';
import { classifyGig, createJiffyProposer } from './proposer.js';
import { createGigStore } from './gigStore.js';
import type { GoldenCompiler } from './goldenCompiler.js';
import type { GoldenSet } from './types.js';

const silentLogger = pino({ level: 'silent' });

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: 'gig-1',
    title: 'Untitled gig',
    description: 'no description',
    payerId: 'payer-1',
    payerName: 'Payer',
    payerAvatar: '',
    category: 'Web Development / Micro-tools',
    subcategory: '',
    deliverables: [],
    acceptanceCriteria: [],
    budget: 25,
    timeline: '1 day',
    urgency: 'low',
    warrantyRequired: false,
    warrantyMinDuration: '',
    dataConstraints: [],
    status: 'open',
    proposalCount: 0,
    postedDate: '2026-07-01',
    tags: [],
    ...overrides,
  } as unknown as Gig;
}

// ---- classifyGig ----

test('classifyGig: a description with toolId: <id> always means a hosting-cycle renewal', () => {
  const gig = makeGig({
    description: 'Please apply my edit. toolId: 9f8e7d6c5b4a3210',
  });
  assert.deepEqual(classifyGig(gig), { kind: 'cycle', toolId: '9f8e7d6c5b4a3210' });
});

test('classifyGig: a fenced calculator brief matches explicit', () => {
  const gig = makeGig({
    title: 'Need a rate calculator',
    description:
      '```json\n{"template":"calculator","name":"Rate Calc","description":"consulting rate calculator"}\n```',
  });
  const result = classifyGig(gig);
  assert.deepEqual(result, {
    kind: 'build',
    templateId: 'calculator',
    via: 'explicit',
    brief: { template: 'calculator', name: 'Rate Calc', description: 'consulting rate calculator' },
  });
});

test('classifyGig: a valid fenced brief with no template field falls through to keyword matching', () => {
  const gig = makeGig({
    title: 'Need a landing page for my homepage launch',
    description:
      '```json\n{"name":"Acme Launch","description":"Marketing copy for the launch"}\n```',
  });
  const result = classifyGig(gig);
  assert.equal(result.kind, 'build');
  if (result.kind === 'build') {
    assert.equal(result.templateId, 'landing');
    assert.equal(result.via, 'keywords');
  }
});

test('classifyGig: a prose-only landing gig (no JSON, >=2 keyword hits) builds via prose with a synthesized brief', () => {
  const gig = makeGig({
    title: 'Need a landing page',
    description:
      'Please build a homepage for my product launch, no JSON brief attached, just get it done quickly.',
  });
  const result = classifyGig(gig);
  assert.deepEqual(result, {
    kind: 'build',
    templateId: 'landing',
    via: 'prose',
    brief: { name: gig.title, description: gig.description },
  });
});

test('classifyGig: a prose-only form gig is skipped incomplete — a prose brief cannot carry notifyEmail', () => {
  const gig = makeGig({
    title: 'Need a contact form',
    description: 'Please build me a lead form, get in touch form quickly, no JSON here at all.',
  });
  const result = classifyGig(gig);
  assert.equal(result.kind, 'skip');
  if (result.kind === 'skip') {
    assert.match(result.reason, /^incomplete-brief:/);
    assert.match(result.reason, /notifyEmail/);
  }
});

test('classifyGig: ambiguous prose (no JSON, <2 keyword hits) is skipped no-brief', () => {
  const gig = makeGig({
    title: 'A generic request',
    description: 'I would like a nice tool please, thanks!',
  });
  assert.deepEqual(classifyGig(gig), { kind: 'skip', reason: 'no-brief' });
});

test('classifyGig: a valid JSON brief that matches no template keywords is off-catalog', () => {
  const gig = makeGig({
    title: 'Something unusual',
    description:
      '```json\n{"name":"Zeta","description":"A bespoke internal utility for our team"}\n```',
  });
  assert.deepEqual(classifyGig(gig), { kind: 'skip', reason: 'off-catalog' });
});

test('classifyGig: an explicit form brief missing notifyEmail is skipped incomplete', () => {
  const gig = makeGig({
    title: 'Contact us page',
    description:
      '```json\n{"template":"form","name":"Contact Us","description":"a contact form"}\n```',
  });
  const result = classifyGig(gig);
  assert.equal(result.kind, 'skip');
  if (result.kind === 'skip') {
    assert.match(result.reason, /^incomplete-brief:/);
    assert.match(result.reason, /notifyEmail/);
  }
});

test('classifyGig: an explicit but bogus template is invalid-template, never falls through to keywords', () => {
  const gig = makeGig({
    title: 'Need a landing page please',
    description:
      '```json\n{"template":"not-a-real-template","name":"X","description":"landing page marketing site"}\n```',
  });
  assert.deepEqual(classifyGig(gig), {
    kind: 'skip',
    reason: 'invalid-template: not-a-real-template',
  });
});

// ---- createJiffyProposer ----

const STUB_GOLDENS: GoldenSet = {
  goldens: [{ title: 'load', steps: [], expect: [{ titleEquals: 'Rate Calc' }] }],
};

function stubBase(overrides: Partial<ProposalDraft> = {}): Proposer {
  return {
    async generateProposal(): Promise<ProposalDraft> {
      return {
        price: 25,
        timeline: '1 business day',
        milestones: [],
        assumptions: ['cover note'],
        ...overrides,
      };
    },
  };
}

function stubCompilerOk(): GoldenCompiler {
  return {
    async compile() {
      return { ok: true, set: STUB_GOLDENS, costUsd: 0.01 };
    },
    async recompileForEdit() {
      throw new Error('recompileForEdit: not used by the proposer');
    },
  };
}

function stubCompilerFail(): GoldenCompiler {
  return {
    async compile() {
      return { ok: false, errors: ['bad testid'], costUsd: 0.005 };
    },
    async recompileForEdit() {
      throw new Error('recompileForEdit: not used by the proposer');
    },
  };
}

test('proposeBuild: happy path embeds the golden block and persists the row', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  const gigs = createGigStore(db, () => new Date('2026-07-07T00:00:00Z'));

  const proposer = createJiffyProposer({
    base: stubBase(),
    compiler: stubCompilerOk(),
    gigs,
    logger: silentLogger,
  });

  const gig = makeGig({ id: 'gig-build-1' });
  const classified = {
    kind: 'build' as const,
    templateId: 'calculator' as const,
    via: 'explicit' as const,
    brief: { template: 'calculator', name: 'Rate Calc', description: 'a rate calculator' },
  };

  const draft = await proposer.proposeBuild(gig, classified);
  assert.ok(draft);
  assert.equal(draft?.assumptions?.length, 2);
  assert.equal(draft?.assumptions?.[0], 'cover note');
  assert.match(draft?.assumptions?.[1] ?? '', /```json/);
  assert.match(draft?.assumptions?.[1] ?? '', /rights to all copy/);

  const row = await gigs.get('gig-build-1');
  assert.ok(row);
  assert.equal(row?.kind, 'build');
  assert.equal(row?.templateId, 'calculator');
  assert.deepEqual(row?.goldens, STUB_GOLDENS);
});

test('proposeBuild: compiler failure returns null and persists nothing', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  const gigs = createGigStore(db);

  const proposer = createJiffyProposer({
    base: stubBase(),
    compiler: stubCompilerFail(),
    gigs,
    logger: silentLogger,
  });

  const gig = makeGig({ id: 'gig-build-2' });
  const classified = {
    kind: 'build' as const,
    templateId: 'calculator' as const,
    via: 'explicit' as const,
    brief: { template: 'calculator', name: 'Rate Calc', description: 'a rate calculator' },
  };

  const draft = await proposer.proposeBuild(gig, classified);
  assert.equal(draft, null);
  assert.equal(await gigs.get('gig-build-2'), null);
});

test('proposeCycle: appends the hosting-terms assumption and persists a cycle row', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  const gigs = createGigStore(db, () => new Date('2026-07-07T00:00:00Z'));

  const proposer = createJiffyProposer({
    base: stubBase(),
    compiler: stubCompilerOk(),
    gigs,
    logger: silentLogger,
  });

  const gig = makeGig({ id: 'gig-cycle-1' });
  const classified = { kind: 'cycle' as const, toolId: 'tool-xyz' };

  const draft = await proposer.proposeCycle(gig, classified);
  assert.equal(draft.assumptions?.length, 2);
  assert.equal(draft.assumptions?.[0], 'cover note');
  assert.match(draft.assumptions?.[1] ?? '', /hosting terms/i);
  assert.match(draft.assumptions?.[1] ?? '', /grace period/i);

  const row = await gigs.get('gig-cycle-1');
  assert.ok(row);
  assert.equal(row?.kind, 'cycle');
  assert.equal(row?.toolId, 'tool-xyz');
});
