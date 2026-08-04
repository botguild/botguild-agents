// Cron sweeps (Task 22): the default-selection rule, the FR-9 selection poll,
// parked-job re-enqueue with its give-up bound, §12 stuck-claim recovery, and
// the free/paid proposer split.
//
// Real D1-backed stores (in-memory sqlite with the shipped migrations applied)
// so the state machine, the checkpoint and the audit trail are exercised for
// real; the platform client, the queue and `fetch` are scripted fakes. The
// thread is served through a fake `fetch` rather than a stubbed ThreadReader on
// purpose — the selection poll then runs the actual wire mapping in threads.ts,
// so a wire-format regression fails here instead of passing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import type { D1Like } from '@botguild/agent-core-workers';
import type { AgentClient, Gig, ProposalDraft } from '@botguild/agent-core';
import { applyMigrations } from './testSupport.js';
import {
  buildJobKey,
  createConceptStore,
  createJobStore,
  createSelectionStore,
  loadReputationSnapshot,
  type ConceptRow,
  type ConceptStore,
  type JobStore,
  type SelectionStore,
} from './jobs.js';
import { findSelection, parseSelection, type ThreadMessage } from './threads.js';
import {
  MAX_SELECTION_INFERENCES_PER_CONTRACT,
  type SelectionInference,
} from './inferSelection.js';
import {
  HAIKU_MODEL_ID,
  MAX_SPEND_USD,
  PARKED_GIVE_UP_HOURS,
  SELECTION_TIMEOUT_HOURS,
  STUCK_CLAIM_MINUTES,
} from './config.js';
import {
  decideDefaultSelection,
  maybePropose,
  resolveSelectionForContract,
  runDailySweep,
  runFifteenMinuteSweep,
  type SweepServices,
} from './sweeps.js';
import type {
  ConceptState,
  FetchLike,
  JobCheckpoint,
  JobMessage,
  JobStage,
  LogoBrief,
} from './types.js';
import { parseLogoBrief, type BriefResult } from './brief.js';
import type { ProseGig } from './proseBrief.js';

const logger = createConsoleLogger({ service: 'test', botId: 'bot-logosmith', level: 'silent' });
const BOT_ID = 'bot-logosmith';
const API_URL = 'https://api.example.com';
const BUYER = 'handler-buyer';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// --- Fixtures ------------------------------------------------------------------

interface WireMessage {
  id: string;
  sender_id: string;
  sender_bot_id: string | null;
  content: string;
  created_at: string;
}

const buyerSays = (id: string, content: string, at: Date): WireMessage => ({
  id,
  sender_id: BUYER,
  sender_bot_id: null,
  content,
  created_at: at.toISOString(),
});

const botSays = (id: string, content: string, at: Date): WireMessage => ({
  id,
  // The platform reports the *handler* account in sender_id; only
  // sender_bot_id names the bot. Getting this wrong is what would make the
  // bot's own M1 note indistinguishable from a buyer reply.
  sender_id: 'handler-logosmith',
  sender_bot_id: BOT_ID,
  content,
  created_at: at.toISOString(),
});

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: 'gig-1',
    title: 'Logo needed',
    description: 'A logo for my brand.',
    payerId: 'payer-1',
    payerName: 'Buyer',
    payerAvatar: '',
    category: 'Design / Brand Identity', // scorerConfig.categories[0] — full relevance
    subcategory: '',
    deliverables: [],
    acceptanceCriteria: [],
    budget: 25,
    timeline: '2 business days',
    urgency: 'medium',
    warrantyRequired: false,
    warrantyMinDuration: '',
    dataConstraints: [],
    status: 'open',
    proposalCount: 0,
    postedDate: '2026-07-01T00:00:00.000Z',
    tags: [],
    ...overrides,
  } as unknown as Gig;
}

const STUB_DRAFT: ProposalDraft = {
  price: 25,
  timeline: '2 business days',
  milestones: [{ title: 'Milestone 1', duration: '1 business day', deliverables: ['a'] }],
  assumptions: [],
};

const axisFor = (slot: number): ConceptState['axis'] => ({
  id: `axis-${slot}`,
  label: `Axis ${slot}`,
  prompt: `prompt ${slot}`,
  vendor: 'ideogram',
});

function slotState(slot: number, status: ConceptState['status'], score: number): ConceptState {
  return {
    slot,
    axis: axisFor(slot),
    status,
    attempts: 1,
    phash: `${slot}${slot}${slot}${slot}${slot}${slot}${slot}${slot}`,
    r2Key: `token/concept-${slot}.png`,
    ocr: {
      model: 'model-x',
      transcription: 'ACME',
      score,
      pass: true,
      unsafe: false,
      checkedAt: '2026-07-30T00:00:00.000Z',
    },
  };
}

// --- Harness -------------------------------------------------------------------

interface Harness {
  db: D1Like;
  jobs: JobStore;
  concepts: ConceptStore;
  selection: SelectionStore;
  services: SweepServices;
  clock: { value: Date };
  queueSent: JobMessage[];
  messagesSent: Array<{ contractId: string; body: string }>;
  proposalsSent: Array<{ gigId: string; draft: ProposalDraft; proposer: 'paid' | 'free' }>;
  openGigs: { value: Gig[] };
  threads: Map<string, WireMessage[]>;
  fetchedUrls: string[];
  breakNegotiation: { value: boolean };
  /** Contract ids whose thread read throws, standing in for a platform 5xx. */
  failThreadsFor: Set<string>;
  /** Every gig handed to the prose-brief extractor, in order. */
  extractorCalls: ProseGig[];
  /** What the scripted extractor returns; a valid brief by default. */
  extractorResult: { value: BriefResult<LogoBrief> };
  /**
   * Every message handed to the FR-9 Haiku selection fallback, in order. This
   * is how "was a model ever asked about this?" becomes directly assertable —
   * the guarantee that a strict-parseable reply never reaches a model is a
   * statement about this array being empty.
   */
  inferenceCalls: Array<{ messageId: string; body: string; allowed: number[] }>;
  /** Scripted answer per message body; declines everything by default. */
  inferenceScript: { value: (message: ThreadMessage) => SelectionInference };
  at<T>(when: Date, fn: () => Promise<T>): Promise<T>;
}

const BASE = new Date('2026-07-30T09:00:00.000Z');

async function makeHarness(): Promise<Harness> {
  const db = createMemoryD1();
  await applyMigrations(db);

  const clock = { value: new Date(BASE) };
  const now = (): Date => clock.value;

  const jobs = createJobStore(db, now);
  const concepts = createConceptStore(db, now);
  const selection = createSelectionStore(db, now);

  const queueSent: JobMessage[] = [];
  const messagesSent: Harness['messagesSent'] = [];
  const proposalsSent: Harness['proposalsSent'] = [];
  const openGigs = { value: [] as Gig[] };
  const threads = new Map<string, WireMessage[]>();
  const fetchedUrls: string[] = [];
  const breakNegotiation = { value: false };
  const failThreadsFor = new Set<string>();

  // The prose-brief extractor stands in for a Haiku call. It succeeds by
  // default so the proposer-routing tests keep testing routing, and records
  // every call so the "which gigs did we pay a model to read?" question — the
  // cost control in `maybePropose` — is directly assertable.
  const extractorCalls: ProseGig[] = [];
  const extractorResult: { value: BriefResult<LogoBrief> } = {
    value: { ok: true, brief: { brandName: 'Harbor & Vine', industry: 'boutique inn' } },
  };

  // The selection fallback stands in for a Haiku call. It DECLINES by default,
  // which is both the conservative direction and what keeps every pre-existing
  // selection test testing what its name says: with a declining double, the
  // strict parser and the 72-hour default rule are the only things that can
  // resolve a winner, exactly as before this fallback existed.
  const inferenceCalls: Harness['inferenceCalls'] = [];
  const inferenceScript: Harness['inferenceScript'] = {
    value: () => ({ slot: null, quote: null, costUsd: 0.0004, outage: false, reason: 'declined' }),
  };

  const client = {
    async listGigs(): Promise<Gig[]> {
      return openGigs.value;
    },
    async listProposals(): Promise<never[]> {
      return [];
    },
    async sendMessage(contractId: string, body: string): Promise<void> {
      messagesSent.push({ contractId, body });
    },
    // Which proposer produced the draft is the thing the routing tests need to
    // observe, so each proposer tags its draft and the client records the tag.
    async submitProposal(gigId: string, draft: ProposalDraft): Promise<{ proposalId: string }> {
      const tag = (draft as ProposalDraft & { __proposer?: 'paid' | 'free' }).__proposer ?? 'paid';
      proposalsSent.push({ gigId, draft, proposer: tag });
      return { proposalId: `prop-${gigId}` };
    },
    async getContract(): Promise<never> {
      throw new Error('getContract: not scripted for these tests');
    },
    async deliverMilestone(): Promise<never> {
      throw new Error('deliverMilestone: not scripted for these tests');
    },
  } as unknown as AgentClient;

  const tagProposer = (
    tag: 'paid' | 'free',
  ): { generateProposal(gig: Gig): Promise<ProposalDraft> } => ({
    async generateProposal(): Promise<ProposalDraft> {
      return { ...structuredClone(STUB_DRAFT), __proposer: tag } as ProposalDraft;
    },
  });

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const fetchImpl: FetchLike = async (url) => {
    fetchedUrls.push(url);
    const list = /\/threads\?scope=contract&scopeId=([^&]+)/.exec(url);
    if (list) {
      const contractId = decodeURIComponent(list[1]);
      if (failThreadsFor.has(contractId)) throw new Error(`thread read failed for ${contractId}`);
      return json(
        threads.has(contractId) ? { threads: [{ id: `th-${contractId}` }] } : { threads: [] },
      );
    }
    const read = /\/threads\/th-(.+)\/messages$/.exec(url);
    if (read) return json({ messages: threads.get(read[1]) ?? [] });
    throw new Error(`unexpected fetch: ${url}`);
  };

  const services: SweepServices = {
    db,
    client,
    jobs,
    concepts,
    selection,
    queue: {
      async send(message: JobMessage): Promise<unknown> {
        queueSent.push(message);
        return {};
      },
    },
    seen: { has: async () => false, add: async () => {} },
    negotiationStore: {
      async loadCounteredSet() {
        return new Set<string>();
      },
      async hydrate() {
        // `runNegotiationSweep` awaits hydrate() outside its own try/finally, so
        // this is the sweep step that can genuinely throw at the caller.
        if (breakNegotiation.value) throw new Error('negotiation store is down');
        return {
          memory: { hasCountered: () => false, markCountered: () => {}, clear: () => {} },
          flush: async () => {},
        };
      },
    },
    reputationSource: {
      async getMyReputation() {
        return { handler: { handlerId: BOT_ID, reputationScore: 78, disputeRate: 0 }, bots: [] };
      },
      async getMyEarnings() {
        return {
          summary: {
            funded: 0,
            released: 0,
            refunded: 0,
            fees: 0,
            balance: 0,
            transactionCount: 0,
          },
          transactions: [],
        };
      },
    } as unknown as SweepServices['reputationSource'],
    proposer: tagProposer('paid'),
    freeProposer: tagProposer('free'),
    briefExtractor: {
      async extract(gig: ProseGig): Promise<BriefResult<LogoBrief>> {
        extractorCalls.push(gig);
        return extractorResult.value;
      },
    },
    selectionInferrer: {
      async infer({ message, allowed }): Promise<SelectionInference> {
        inferenceCalls.push({
          messageId: message.id,
          body: message.body,
          allowed: [...allowed].sort((a, b) => a - b),
        });
        return inferenceScript.value(message);
      },
    },
    costEstimator: {
      async estimate(): Promise<never> {
        throw new Error('costEstimator.estimate: not scripted for these tests');
      },
    } as unknown as SweepServices['costEstimator'],
    apiUrl: API_URL,
    apiKey: 'key-123',
    botId: BOT_ID,
    logger,
    fetchImpl,
    now,
  };

  return {
    db,
    jobs,
    concepts,
    selection,
    services,
    clock,
    queueSent,
    messagesSent,
    proposalsSent,
    openGigs,
    threads,
    fetchedUrls,
    breakNegotiation,
    failThreadsFor,
    extractorCalls,
    extractorResult,
    inferenceCalls,
    inferenceScript,
    async at<T>(when: Date, fn: () => Promise<T>): Promise<T> {
      const previous = clock.value;
      clock.value = when;
      try {
        return await fn();
      } finally {
        clock.value = previous;
      }
    },
  };
}

/**
 * Seed a contract that has reached M1: a delivered concepts-stage job whose
 * checkpoint records exactly `delivered` as passed, plus concept rows for every
 * slot in `scores` — including any slot NOT in `delivered`, which is how a
 * distinctness-demoted concept looks in D1 (`ocr_pass = 1` on the row,
 * `status: 'failed'` on the checkpoint).
 */
async function seedDeliveredM1(
  h: Harness,
  args: { contractId: string; delivered: number[]; scores: Record<number, number>; m1At: Date },
): Promise<string> {
  const { contractId, delivered, scores, m1At } = args;
  const conceptsJobKey = await buildJobKey(contractId, 'concepts');

  await h.at(m1At, async () => {
    await h.jobs.claim(conceptsJobKey, contractId, 'concepts');
    const checkpoint: JobCheckpoint = {
      slots: Object.keys(scores)
        .map(Number)
        .sort((a, b) => a - b)
        .map((slot) =>
          slotState(slot, delivered.includes(slot) ? 'passed' : 'failed', scores[slot]),
        ),
      spendUsd: 1.2,
    };
    await h.jobs.saveCheckpoint(conceptsJobKey, checkpoint);
    for (const [slot, score] of Object.entries(scores)) {
      await h.concepts.upsert({
        contractId,
        slot: Number(slot),
        axisId: `axis-${slot}`,
        vendor: 'ideogram',
        r2Key: `token/concept-${slot}.png`,
        phash: `${slot}${slot}${slot}${slot}${slot}${slot}${slot}${slot}`,
        ocrTranscription: 'ACME',
        ocrScore: score,
        ocrModel: 'model-x',
        // Every row passes its OWN lettering gate — that is exactly why the row
        // for a demoted slot looks legitimate to a query.
        ocrPass: true,
        attemptsUsed: 1,
      });
    }
    await h.jobs.markDelivered(conceptsJobKey, delivered.length >= 3 ? 'delivered' : 'partial');
    await h.selection.open(contractId);
  });

  return conceptsJobKey;
}

const row = (rows: ConceptRow[], slot: number): ConceptRow => {
  const found = rows.find((candidate) => candidate.slot === slot);
  assert.ok(found, `fixture expects a concept row for slot ${slot}`);
  return found;
};

const conceptRow = (slot: number, score: number | null, pass: boolean): ConceptRow => ({
  contractId: 'c',
  slot,
  axisId: `axis-${slot}`,
  vendor: 'ideogram',
  vendorRequestId: null,
  r2Key: `k/${slot}`,
  nativeSvgKey: null,
  phash: 'aaaaaaaa',
  ocrTranscription: 'ACME',
  ocrScore: score,
  ocrModel: 'model-x',
  ocrPass: pass,
  attemptsUsed: 1,
});

// ===============================================================================
// decideDefaultSelection
// ===============================================================================

describe('decideDefaultSelection', () => {
  it('picks the highest lettering-readback score among passing concepts', () => {
    assert.equal(
      decideDefaultSelection([
        conceptRow(1, 0.88, true),
        conceptRow(2, 0.95, true),
        conceptRow(3, 0.9, true),
      ]),
      2,
    );
  });

  it('breaks a tie on the lowest slot', () => {
    assert.equal(
      decideDefaultSelection([
        conceptRow(3, 0.91, true),
        conceptRow(1, 0.91, true),
        conceptRow(2, 0.91, true),
      ]),
      1,
    );
  });

  it('returns null when nothing passed', () => {
    assert.equal(
      decideDefaultSelection([conceptRow(1, 0.4, false), conceptRow(2, 0.99, false)]),
      null,
    );
    assert.equal(decideDefaultSelection([]), null);
  });

  it('never picks a concept that failed, however high it scored', () => {
    const rows = [conceptRow(1, 0.86, true), conceptRow(2, 0.99, false)];
    // Fixture precondition, asserted inline: slot 2 outscores slot 1 and is the
    // only thing keeping this from being a "picks the highest score" test.
    assert.ok(rows[1].ocrScore! > rows[0].ocrScore!);
    assert.equal(decideDefaultSelection(rows), 1);
  });

  it('does not depend on the order the rows arrive in', () => {
    // listPassing() already sorts by (ocr_score DESC, slot ASC), so a
    // take-the-first-row implementation would pass every test above while being
    // one ORDER BY away in a different module from silently going wrong.
    const shuffled = [
      conceptRow(1, 0.7, true),
      conceptRow(3, 0.99, true),
      conceptRow(2, 0.8, true),
    ];
    assert.equal(decideDefaultSelection(shuffled), 3);
    assert.equal(decideDefaultSelection([...shuffled].reverse()), 3);
  });

  it('keeps a passing concept selectable when its score is unknown', () => {
    assert.equal(decideDefaultSelection([conceptRow(2, null, true)]), 2);
    // ...but never lets it outrank a scored one.
    assert.equal(decideDefaultSelection([conceptRow(1, null, true), conceptRow(2, 0.86, true)]), 2);
  });
});

// ===============================================================================
// The selection poll (FR-9)
// ===============================================================================

describe('selection poll', () => {
  it('selects the buyer’s pick and enqueues stage 2 exactly once', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - 2 * HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-buyer',
      delivered: [1, 2, 3],
      scores: { 1: 0.86, 2: 0.88, 3: 0.99 },
      m1At,
    });
    h.threads.set('c-buyer', [
      botSays('m0', 'PICK YOUR WINNER — reply with `concept 1|2|3`.', m1At),
      buyerSays('m1', 'concept 2', new Date(m1At.getTime() + MINUTE)),
    ]);
    // Fixture precondition, inline: the reply really is a pick under the
    // current parser. If a future tightening drains it, this fails loudly here
    // instead of quietly turning the test below into a tautology.
    assert.equal(parseSelection('concept 2'), 2);

    await runFifteenMinuteSweep(h.services);

    const vectorJobKey = await buildJobKey('c-buyer', 'vector');
    assert.deepEqual(await h.selection.get('c-buyer'), {
      contractId: 'c-buyer',
      state: 'winner_selected',
      winnerSlot: 2,
      // NOT the top-scoring concept (slot 3 scores 0.99) — proving the buyer's
      // pick beat the default rule rather than coinciding with it.
      source: 'buyer',
      m1DeliveredAt: m1At.toISOString(),
    });
    assert.deepEqual(h.queueSent, [
      { contractId: 'c-buyer', jobKey: vectorJobKey, stage: 'vector' },
    ]);
    assert.equal((await h.jobs.get(vectorJobKey))?.status, 'claimed');

    // A second sweep must not enqueue stage 2 again: the row is no longer at
    // concepts_delivered, so the whole resolution short-circuits.
    await runFifteenMinuteSweep(h.services);
    assert.equal(h.queueSent.length, 1);

    // The rest of the sweep ran too — step isolation must not have swallowed it.
    assert.ok(await loadReputationSnapshot(h.db));
  });

  it('default-selects the best DELIVERED concept once the window closes', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - (SELECTION_TIMEOUT_HOURS + 1) * HOUR);
    const conceptsJobKey = await seedDeliveredM1(h, {
      contractId: 'c-timeout',
      // A `partial` M1: slot 3 was demoted by the distinctness gate and never
      // delivered, but its concept row still carries ocr_pass = 1 AND the top
      // score — so an implementation that trusts listPassing() alone picks it.
      delivered: [1, 2],
      scores: { 1: 0.87, 2: 0.93, 3: 0.99 },
      m1At,
    });
    h.threads.set('c-timeout', [botSays('m0', 'reply with `concept 1|2`', m1At)]);

    // Fixture preconditions, inline: listPassing() really does offer slot 3,
    // and slot 3 really does outscore every delivered slot.
    const passing = await h.concepts.listPassing('c-timeout');
    assert.deepEqual(
      passing.map((concept) => concept.slot).sort((a, b) => a - b),
      [1, 2, 3],
    );
    assert.ok(row(passing, 3).ocrScore! > row(passing, 2).ocrScore!);

    await runFifteenMinuteSweep(h.services);

    const persisted = await h.selection.get('c-timeout');
    assert.equal(persisted?.state, 'winner_selected');
    assert.equal(persisted?.source, 'default');
    assert.equal(persisted?.winnerSlot, 2, 'must pick the best DELIVERED concept, not slot 3');
    assert.deepEqual(h.queueSent, [
      {
        contractId: 'c-timeout',
        jobKey: await buildJobKey('c-timeout', 'vector'),
        stage: 'vector',
      },
    ]);

    // FR-17: the selection event is on the audit trail with what decided it.
    const trail = await h.jobs.listGateAudit(conceptsJobKey, 'selection');
    assert.equal(trail.length, 1);
    assert.equal(trail[0].result, 'default');
    assert.deepEqual((trail[0].detail as { deliveredSlots: number[] }).deliveredSlots, [1, 2]);
  });

  it('leaves a contract alone while it is still inside the selection window', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - (SELECTION_TIMEOUT_HOURS - 1) * HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-waiting',
      delivered: [1, 2, 3],
      scores: { 1: 0.86, 2: 0.88, 3: 0.9 },
      m1At,
    });
    h.threads.set('c-waiting', [
      buyerSays('m1', 'looks great, let me think about it', new Date(m1At.getTime() + MINUTE)),
    ]);

    await runFifteenMinuteSweep(h.services);

    assert.equal((await h.selection.get('c-waiting'))?.state, 'concepts_delivered');
    assert.deepEqual(h.queueSent, []);
    assert.deepEqual(h.messagesSent, []);
    // Non-vacuity: the thread WAS read. Without this the test would pass just
    // as happily against a poll that never looked at the contract at all.
    assert.ok(h.fetchedUrls.some((url) => url.includes('/threads/th-c-waiting/messages')));
  });

  it('ignores a parseable reply the buyer typed BEFORE M1 was delivered', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-pre',
      delivered: [1, 2, 3],
      scores: { 1: 0.86, 2: 0.88, 3: 0.9 },
      m1At,
    });
    const early = new Date(m1At.getTime() - 30 * MINUTE);
    h.threads.set('c-pre', [buyerSays('m1', '2', early)]);

    // Fixture preconditions, inline. `findSelection` has no time awareness:
    // handed this message it returns 2, so the ONLY thing that can keep this
    // contract unselected is the caller slicing to messages after
    // m1_delivered_at. Delete the slice and this test fails.
    assert.equal(parseSelection('2'), 2);
    assert.equal(
      findSelection(
        [{ id: 'm1', senderId: BUYER, body: '2', createdAt: early.toISOString() }],
        BOT_ID,
      ),
      2,
    );
    assert.ok(early < m1At);

    await runFifteenMinuteSweep(h.services);

    assert.equal((await h.selection.get('c-pre'))?.state, 'concepts_delivered');
    assert.deepEqual(h.queueSent, []);
  });

  it('refuses a buyer pick naming a concept M1 never delivered, and says so once', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    const conceptsJobKey = await seedDeliveredM1(h, {
      contractId: 'c-wrong',
      delivered: [1, 2],
      scores: { 1: 0.87, 2: 0.93, 3: 0.99 },
      m1At,
    });
    h.threads.set('c-wrong', [buyerSays('m1', 'concept 3', new Date(m1At.getTime() + MINUTE))]);

    // Fixture preconditions: the reply parses, and slot 3's row looks entirely
    // legitimate — it passed its own lettering gate, so stage 2's ocrPass guard
    // would wave it straight through if this refusal did not exist.
    assert.equal(parseSelection('concept 3'), 3);
    assert.equal(row(await h.concepts.listPassing('c-wrong'), 3).ocrPass, true);

    await runFifteenMinuteSweep(h.services);

    assert.equal((await h.selection.get('c-wrong'))?.state, 'concepts_delivered');
    assert.deepEqual(h.queueSent, []);
    assert.equal(h.messagesSent.length, 1);
    assert.equal(h.messagesSent[0].contractId, 'c-wrong');
    assert.match(h.messagesSent[0].body, /concept 3 was not part of the Milestone 1 delivery/);
    assert.match(h.messagesSent[0].body, /concept 1 and concept 2/);

    // The 15-minute cron reaches this branch again and again; the buyer is told
    // exactly once.
    await runFifteenMinuteSweep(h.services);
    assert.equal(h.messagesSent.length, 1);
    assert.equal(
      (await h.jobs.listGateAudit(conceptsJobKey, 'selection')).filter(
        (entry) => entry.result === 'unselectable-pick',
      ).length,
      1,
    );

    // ...and at the timeout the default rule still lands on a DELIVERED slot.
    h.clock.value = new Date(m1At.getTime() + (SELECTION_TIMEOUT_HOURS + 1) * HOUR);
    await runFifteenMinuteSweep(h.services);
    assert.equal((await h.selection.get('c-wrong'))?.winnerSlot, 2);
    assert.equal((await h.selection.get('c-wrong'))?.source, 'default');
  });

  it('honours the correction after a refused pick, instead of fixating on it', async () => {
    // The whole point of scoping the scan: we TELL the buyer to reply with one
    // of the delivered concepts, so that reply has to work. Taking the first
    // parseable reply regardless means every later sweep re-reads the refused
    // one and the correction is ignored forever.
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-fix',
      delivered: [1, 2],
      scores: { 1: 0.87, 2: 0.93, 3: 0.99 },
      m1At,
    });
    h.threads.set('c-fix', [
      buyerSays('m1', 'concept 3', new Date(m1At.getTime() + MINUTE)),
      buyerSays('m2', 'concept 2', new Date(m1At.getTime() + 5 * MINUTE)),
    ]);
    // Fixture preconditions: both replies parse, and the refused one is FIRST.
    assert.equal(parseSelection('concept 3'), 3);
    assert.equal(parseSelection('concept 2'), 2);

    await runFifteenMinuteSweep(h.services);

    const persisted = await h.selection.get('c-fix');
    assert.equal(persisted?.state, 'winner_selected');
    assert.equal(persisted?.winnerSlot, 2);
    assert.equal(persisted?.source, 'buyer', 'the correction is the buyer’s choice, not a default');
    assert.deepEqual(h.queueSent, [
      { contractId: 'c-fix', jobKey: await buildJobKey('c-fix', 'vector'), stage: 'vector' },
    ]);
    // The refused pick is still explained — scanning past it must not silence
    // the note that told them to correct it.
    assert.equal(h.messagesSent.length, 1);
    assert.match(h.messagesSent[0].body, /concept 3 was not part of the Milestone 1 delivery/);
  });

  it('still takes the FIRST of two deliverable picks (first-wins is unchanged)', async () => {
    // The rule findSelectionIn must not have weakened: skipping a REFUSED pick
    // is safe because it writes nothing, but two picks that could each be built
    // still resolve to the earlier one — consistent with select()'s own
    // first-write-wins, so a buyer cannot re-point a job already in flight.
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-first',
      delivered: [1, 2, 3],
      scores: { 1: 0.87, 2: 0.93, 3: 0.99 },
      m1At,
    });
    h.threads.set('c-first', [
      buyerSays('m1', 'concept 1', new Date(m1At.getTime() + MINUTE)),
      buyerSays('m2', 'concept 3', new Date(m1At.getTime() + 5 * MINUTE)),
    ]);
    // Fixture preconditions: BOTH parse and BOTH are deliverable, so ordering is
    // the only thing deciding the outcome.
    assert.equal(parseSelection('concept 1'), 1);
    assert.equal(parseSelection('concept 3'), 3);

    await runFifteenMinuteSweep(h.services);

    assert.equal((await h.selection.get('c-first'))?.winnerSlot, 1);
    assert.equal((await h.selection.get('c-first'))?.source, 'buyer');
    assert.deepEqual(h.messagesSent, []);
  });

  it('asks the buyer for help when it cannot prove what M1 delivered', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    // A selection row with no stage-1 checkpoint behind it: nothing is provably
    // deliverable, so no pick can be honoured and nothing can be ranked.
    await h.at(m1At, () => h.selection.open('c-blind'));
    h.threads.set('c-blind', [buyerSays('m1', 'concept 2', new Date(m1At.getTime() + MINUTE))]);
    assert.equal(await h.jobs.get(await buildJobKey('c-blind', 'concepts')), null);

    await runFifteenMinuteSweep(h.services);

    // Refusing to select is right; going quiet on a funded contract is not.
    assert.equal((await h.selection.get('c-blind'))?.state, 'concepts_delivered');
    assert.deepEqual(h.queueSent, []);
    assert.equal(h.messagesSent.length, 1);
    assert.match(h.messagesSent[0].body, /needs a hand with this contract/);
    assert.match(h.messagesSent[0].body, /Reply in this thread naming the concept you want/);

    // Once, not once every fifteen minutes — and still once past the timeout.
    await runFifteenMinuteSweep(h.services);
    h.clock.value = new Date(m1At.getTime() + (SELECTION_TIMEOUT_HOURS + 1) * HOUR);
    await runFifteenMinuteSweep(h.services);
    assert.equal(h.messagesSent.length, 1);
    assert.equal((await h.selection.get('c-blind'))?.state, 'concepts_delivered');
  });

  it('does not treat a digits-only timestamp as later than M1', async () => {
    // `Date.parse('12345')` is the YEAR 12345, so a lenient parse would sort a
    // pre-M1 reply AFTER the delivery and select it — inverting the slice.
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-epoch',
      delivered: [1, 2, 3],
      scores: { 1: 0.86, 2: 0.88, 3: 0.9 },
      m1At,
    });
    h.threads.set('c-epoch', [
      { id: 'm1', sender_id: BUYER, sender_bot_id: null, content: '2', created_at: '12345' },
    ]);
    // Fixture preconditions: the reply parses, and a bare Date.parse really
    // does read that timestamp as being far in the future.
    assert.equal(parseSelection('2'), 2);
    assert.ok(Date.parse('12345') > m1At.getTime());

    await runFifteenMinuteSweep(h.services);

    assert.equal((await h.selection.get('c-epoch'))?.state, 'concepts_delivered');
    assert.deepEqual(h.queueSent, []);
  });
});

// ===============================================================================
// The Haiku selection fallback (Task 28)
//
// The measured problem: 61 of 68 plausible affirmative replies return null from
// the strict parser, so those buyers wait the full 72 hours and are then handed
// an auto-pick. The fallback reads only what that parser refused.
// ===============================================================================

/** A reply the strict parser genuinely cannot read — asserted, not assumed. */
const SOFT_PICK = 'concept 2 works for us, thanks!';
assert.equal(
  parseSelection(SOFT_PICK),
  null,
  'the fallback fixtures must be replies the strict parser refuses',
);

/** Script the inferrer to read `slot` out of any message containing `quote`. */
const readsQuote = (slot: number, quote: string) => (message: ThreadMessage) =>
  message.body.includes(quote)
    ? ({ slot, quote, costUsd: 0.0008, outage: false, reason: null } as SelectionInference)
    : ({ slot: null, quote: null, costUsd: 0.0004, outage: false, reason: 'declined' } as const);

const auditResults = async (h: Harness, jobKey: string): Promise<string[]> =>
  (await h.jobs.listGateAudit(jobKey, 'selection')).map((entry) => entry.result);

describe('selection fallback — it is a fallback, and only a fallback', () => {
  it('never sends a reply the strict parser CAN read to a model', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-strict',
      delivered: [1, 2, 3],
      scores: { 1: 0.86, 2: 0.88, 3: 0.99 },
      m1At,
    });
    h.threads.set('c-strict', [buyerSays('m1', 'concept 2', new Date(m1At.getTime() + MINUTE))]);
    // Fixture precondition, inline: the reply parses. If a future change ever
    // drained it, this test would silently start asserting nothing.
    assert.equal(parseSelection('concept 2'), 2);
    // And the model WOULD have answered differently, so "source: buyer" cannot
    // be a coincidence of the double agreeing with the parser.
    h.inferenceScript.value = readsQuote(3, 'concept 2');

    await runFifteenMinuteSweep(h.services);

    assert.deepEqual(h.inferenceCalls, [], 'a strict-parser hit is never re-read by a model');
    assert.equal((await h.selection.get('c-strict'))?.winnerSlot, 2);
    assert.equal((await h.selection.get('c-strict'))?.source, 'buyer');
  });

  it('never sends the bot’s own messages to a model', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-botsays',
      delivered: [1, 2],
      scores: { 1: 0.86, 2: 0.88 },
      m1At,
    });
    h.threads.set('c-botsays', [
      // The M1 note names every concept by number and asks for one back — the
      // single most selection-shaped text in the whole thread, and ours.
      botSays('m0', 'PICK YOUR WINNER — reply with `concept 1|2`.', new Date(m1At.getTime() + 1)),
      buyerSays('m1', 'thanks, will look tonight', new Date(m1At.getTime() + MINUTE)),
    ]);

    await runFifteenMinuteSweep(h.services);

    assert.deepEqual(
      h.inferenceCalls.map((call) => call.messageId),
      ['m1'],
    );
  });

  it('never sends a message the buyer posted BEFORE M1 to a model', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-pre',
      delivered: [1, 2],
      scores: { 1: 0.86, 2: 0.88 },
      m1At,
    });
    h.threads.set('c-pre', [
      buyerSays('m0', 'the second option in your portfolio', new Date(m1At.getTime() - MINUTE)),
      buyerSays('m1', 'no rush on this', new Date(m1At.getTime() + MINUTE)),
    ]);
    // The pre-M1 message is the one the model would most likely read a "2" out
    // of, which is why the slice has to be upstream of the model, not after it.
    h.inferenceScript.value = readsQuote(2, 'second option');

    await runFifteenMinuteSweep(h.services);

    assert.deepEqual(
      h.inferenceCalls.map((call) => call.messageId),
      ['m1'],
    );
    assert.equal((await h.selection.get('c-pre'))?.state, 'concepts_delivered');
  });
});

describe('selection fallback — an inferred pick', () => {
  it('selects immediately, well inside the 72-hour window, and starts stage 2', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-infer',
      delivered: [1, 2, 3],
      // Slot 3 scores highest, so the default rule would pick 3 — proving the
      // inferred pick beat it rather than coinciding with it.
      scores: { 1: 0.86, 2: 0.88, 3: 0.99 },
      m1At,
    });
    h.threads.set('c-infer', [buyerSays('m1', SOFT_PICK, new Date(m1At.getTime() + MINUTE))]);
    h.inferenceScript.value = readsQuote(2, 'concept 2 works for us');

    await runFifteenMinuteSweep(h.services);

    assert.deepEqual(await h.selection.get('c-infer'), {
      contractId: 'c-infer',
      state: 'winner_selected',
      winnerSlot: 2,
      source: 'inferred',
      m1DeliveredAt: m1At.toISOString(),
    });
    assert.deepEqual(h.queueSent, [
      { contractId: 'c-infer', jobKey: await buildJobKey('c-infer', 'vector'), stage: 'vector' },
    ]);
    // The delivered set reached the model, so it could never have answered with
    // a concept the buyer was not shown.
    assert.deepEqual(h.inferenceCalls, [{ messageId: 'm1', body: SOFT_PICK, allowed: [1, 2, 3] }]);
    // No new buyer-facing note: there is no revision path to point them at, and
    // an instruction no code path can honour is the exact class already stripped
    // from four other messages on this branch.
    assert.deepEqual(h.messagesSent, []);
  });

  it('records what it read, and out of which message, in the FR-17 trail', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    const conceptsJobKey = await seedDeliveredM1(h, {
      contractId: 'c-evidence',
      delivered: [1, 2],
      scores: { 1: 0.86, 2: 0.88 },
      m1At,
    });
    h.threads.set('c-evidence', [buyerSays('m7', SOFT_PICK, new Date(m1At.getTime() + MINUTE))]);
    h.inferenceScript.value = readsQuote(2, 'concept 2 works for us');

    await runFifteenMinuteSweep(h.services);

    const trail = await h.jobs.listGateAudit(conceptsJobKey, 'selection');
    const read = trail.find((entry) => entry.result === 'inference-selected');
    assert.ok(read, 'the reading itself is evidence and must be on the trail');
    assert.deepEqual(read.detail, {
      messageId: 'm7',
      slot: 2,
      quote: 'concept 2 works for us',
      model: HAIKU_MODEL_ID,
    });
    // ...and the selection event names the inferred source, not `buyer`.
    const chosen = trail.find((entry) => entry.result === 'inferred');
    assert.ok(chosen);
    assert.equal((chosen.detail as { source: string }).source, 'inferred');
    assert.equal((chosen.detail as { buyerReply: number | null }).buyerReply, null);
    assert.equal((chosen.detail as { inferredFrom: string }).inferredFrom, 'm7');
  });

  it('takes the FIRST message a pick can be read out of, oldest first', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-order',
      delivered: [1, 2],
      scores: { 1: 0.86, 2: 0.88 },
      m1At,
    });
    h.threads.set('c-order', [
      buyerSays('m1', 'concept 1 works for us', new Date(m1At.getTime() + MINUTE)),
      buyerSays('m2', 'concept 2 works for us', new Date(m1At.getTime() + 5 * MINUTE)),
    ]);
    // Both are readable by the model and neither by the parser, so ORDER is the
    // only thing deciding the outcome — first-wins, consistent with select()'s
    // own first-write-wins.
    assert.equal(parseSelection('concept 1 works for us'), null);
    assert.equal(parseSelection('concept 2 works for us'), null);
    h.inferenceScript.value = (message) =>
      ({
        slot: message.body.startsWith('concept 1') ? 1 : 2,
        quote: message.body,
        costUsd: 0.0008,
        outage: false,
        reason: null,
      }) as SelectionInference;

    await runFifteenMinuteSweep(h.services);

    assert.equal((await h.selection.get('c-order'))?.winnerSlot, 1);
    assert.deepEqual(
      h.inferenceCalls.map((call) => call.messageId),
      ['m1'],
      'it stops at the first message that yields a pick',
    );
  });
});

describe('selection fallback — uncertainty falls through to today’s behaviour', () => {
  it('leaves the contract awaiting when the model reads no pick, then defaults at the timeout', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-decline',
      delivered: [1, 2],
      scores: { 1: 0.99, 2: 0.88 },
      m1At,
    });
    h.threads.set('c-decline', [
      buyerSays('m1', 'is the mark available in navy?', new Date(m1At.getTime() + MINUTE)),
    ]);

    await runFifteenMinuteSweep(h.services);
    assert.equal((await h.selection.get('c-decline'))?.state, 'concepts_delivered');
    assert.deepEqual(h.queueSent, []);

    h.clock.value = new Date(m1At.getTime() + (SELECTION_TIMEOUT_HOURS + 1) * HOUR);
    await runFifteenMinuteSweep(h.services);
    assert.equal((await h.selection.get('c-decline'))?.winnerSlot, 1);
    assert.equal((await h.selection.get('c-decline'))?.source, 'default');
  });

  it('refuses a pick for a concept M1 never delivered, at the point of decision', async () => {
    // The delivered-set intersection re-checked where the winner is actually
    // chosen. A distinctness-demoted slot keeps `ocr_pass = 1`, so nothing about
    // its row looks wrong to a query — and here the model names it outright.
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    const conceptsJobKey = await seedDeliveredM1(h, {
      contractId: 'c-undelivered',
      delivered: [1, 2],
      scores: { 1: 0.86, 2: 0.88, 3: 0.99 },
      m1At,
    });
    h.threads.set('c-undelivered', [
      buyerSays('m1', 'concept 3 works for us', new Date(m1At.getTime() + MINUTE)),
    ]);
    h.inferenceScript.value = () =>
      ({
        slot: 3,
        quote: 'concept 3 works for us',
        costUsd: 0.0008,
        outage: false,
        reason: null,
      }) as SelectionInference;

    await runFifteenMinuteSweep(h.services);

    assert.equal((await h.selection.get('c-undelivered'))?.state, 'concepts_delivered');
    assert.deepEqual(h.queueSent, []);
    assert.deepEqual(await auditResults(h, conceptsJobKey), ['inference-declined']);
    // Silently, not with a note: the buyer typed nothing this bot could read, so
    // there is nothing to tell them they got wrong.
    assert.deepEqual(h.messagesSent, []);
  });
});

describe('selection fallback — the bill is bounded', () => {
  it('never asks about the same message twice, however many sweeps run', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    const conceptsJobKey = await seedDeliveredM1(h, {
      contractId: 'c-once',
      delivered: [1, 2],
      scores: { 1: 0.86, 2: 0.88 },
      m1At,
    });
    h.threads.set('c-once', [
      buyerSays('m1', 'looks good, let me think', new Date(m1At.getTime() + MINUTE)),
    ]);

    for (let sweep = 0; sweep < 5; sweep += 1) await runFifteenMinuteSweep(h.services);

    assert.equal(h.inferenceCalls.length, 1, 'the append-only trail is the marker');
    assert.deepEqual(await auditResults(h, conceptsJobKey), ['inference-declined']);
  });

  it('stops at the lifetime cap however many replies the buyer posts', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-chatty',
      delivered: [1, 2],
      scores: { 1: 0.86, 2: 0.88 },
      m1At,
    });
    const chatter = MAX_SELECTION_INFERENCES_PER_CONTRACT + 4;
    h.threads.set(
      'c-chatty',
      Array.from({ length: chatter }, (_, i) =>
        buyerSays(`m${i}`, `some thought number ${i}`, new Date(m1At.getTime() + (i + 1) * MINUTE)),
      ),
    );

    // Two sweeps: the cap has to hold ACROSS invocations, not just within one
    // loop, which is the whole reason it is derived from the persisted trail.
    await runFifteenMinuteSweep(h.services);
    await runFifteenMinuteSweep(h.services);

    assert.equal(h.inferenceCalls.length, MAX_SELECTION_INFERENCES_PER_CONTRACT);
  });

  it('leaves a message the model never saw askable, and retries it next sweep', async () => {
    // A vendor's bad minute must not permanently retire the message carrying the
    // buyer's pick — that is the H1 failure shape, and it is why an outage is
    // not a verdict.
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    const conceptsJobKey = await seedDeliveredM1(h, {
      contractId: 'c-outage',
      delivered: [1, 2],
      scores: { 1: 0.86, 2: 0.88 },
      m1At,
    });
    h.threads.set('c-outage', [buyerSays('m1', SOFT_PICK, new Date(m1At.getTime() + MINUTE))]);
    h.inferenceScript.value = () =>
      ({ slot: null, quote: null, costUsd: 0, outage: true, reason: 'model unavailable' }) as const;

    await runFifteenMinuteSweep(h.services);
    assert.deepEqual(await auditResults(h, conceptsJobKey), [], 'no marker for an unread message');

    h.inferenceScript.value = readsQuote(2, 'concept 2 works for us');
    await runFifteenMinuteSweep(h.services);

    assert.equal(h.inferenceCalls.length, 2, 'the same message is asked about again');
    assert.equal((await h.selection.get('c-outage'))?.winnerSlot, 2);
    assert.equal((await h.selection.get('c-outage'))?.source, 'inferred');
  });
});

// ===============================================================================
// resolveSelectionForContract — the FR-9 M1-acceptance trigger
// ===============================================================================

describe('resolveSelectionForContract (force)', () => {
  it('default-selects immediately when M1 is accepted with no reply on the thread', async () => {
    const h = await makeHarness();
    // Deliberately far INSIDE the 72-hour window: only `force` can fire here.
    const m1At = new Date(BASE.getTime() - 10 * MINUTE);
    await seedDeliveredM1(h, {
      contractId: 'c-force',
      delivered: [1, 2],
      scores: { 1: 0.87, 2: 0.93, 3: 0.99 },
      m1At,
    });
    h.threads.set('c-force', [botSays('m0', 'reply with `concept 1|2`', m1At)]);

    // The same contract, unforced, must do nothing — otherwise this test proves
    // nothing about `force`.
    await resolveSelectionForContract(h.services, 'c-force');
    assert.equal((await h.selection.get('c-force'))?.state, 'concepts_delivered');

    await resolveSelectionForContract(h.services, 'c-force', { force: true });

    const persisted = await h.selection.get('c-force');
    assert.equal(persisted?.state, 'winner_selected');
    assert.equal(persisted?.source, 'default');
    assert.equal(persisted?.winnerSlot, 2);
    assert.deepEqual(h.queueSent, [
      { contractId: 'c-force', jobKey: await buildJobKey('c-force', 'vector'), stage: 'vector' },
    ]);
  });

  it('no-ops once a winner is already selected, and after the pack is delivered', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-done',
      delivered: [1, 2, 3],
      scores: { 1: 0.86, 2: 0.88, 3: 0.99 },
      m1At,
    });
    h.threads.set('c-done', [buyerSays('m1', 'concept 1', new Date(m1At.getTime() + MINUTE))]);
    await h.selection.select('c-done', 1, 'buyer');
    assert.equal((await h.selection.get('c-done'))?.state, 'winner_selected');

    await resolveSelectionForContract(h.services, 'c-done', { force: true });
    assert.deepEqual(h.queueSent, []);
    assert.equal((await h.selection.get('c-done'))?.winnerSlot, 1);

    await h.selection.markPackDelivered('c-done');
    assert.equal((await h.selection.get('c-done'))?.state, 'pack_delivered');

    await resolveSelectionForContract(h.services, 'c-done', { force: true });
    assert.deepEqual(h.queueSent, []);
    assert.equal((await h.selection.get('c-done'))?.state, 'pack_delivered');
  });

  it('no-ops for a contract that has no selection row at all', async () => {
    const h = await makeHarness();
    await resolveSelectionForContract(h.services, 'c-nothing', { force: true });
    assert.deepEqual(h.queueSent, []);
    assert.equal(await h.selection.get('c-nothing'), null);
  });
});

// ===============================================================================
// Parked jobs
// ===============================================================================

/**
 * Claim a job, park it, and optionally put it through one unpark -> re-park
 * cycle — which is what the cron does to every parked job it re-enqueues, and
 * therefore the state any give-up clock has to survive.
 */
async function seedParked(
  h: Harness,
  args: {
    contractId: string;
    stage: JobStage;
    reason: string;
    claimedAt: Date;
    firstParkAt: Date;
    reparkAt?: Date;
  },
): Promise<string> {
  const jobKey = await buildJobKey(args.contractId, args.stage);
  await h.at(args.claimedAt, () => h.jobs.claim(jobKey, args.contractId, args.stage));
  await h.at(args.firstParkAt, () => h.jobs.park(jobKey, args.reason));
  if (args.reparkAt) {
    await h.at(args.reparkAt, async () => {
      await h.jobs.unpark(jobKey);
      await h.jobs.park(jobKey, args.reason);
    });
  }
  return jobKey;
}

describe('parked-job sweep', () => {
  it('unparks and re-enqueues a job that is still within the give-up bound', async () => {
    const h = await makeHarness();
    const firstParkAt = new Date(BASE.getTime() - 20 * MINUTE);
    const jobKey = await seedParked(h, {
      contractId: 'c-parked',
      stage: 'concepts',
      reason: 'vendor_outage',
      claimedAt: new Date(BASE.getTime() - 5 * HOUR),
      firstParkAt,
    });
    assert.ok(BASE.getTime() - firstParkAt.getTime() < PARKED_GIVE_UP_HOURS * HOUR);

    await runFifteenMinuteSweep(h.services);

    assert.deepEqual(h.queueSent, [{ contractId: 'c-parked', jobKey, stage: 'concepts' }]);
    const after = await h.jobs.get(jobKey);
    assert.equal(after?.status, 'claimed');
    assert.equal(after?.parkReason, null);
    // unpark() must NOT clear parked_since: the failing spell is not over
    // because the cron re-enqueued the job, and clearing it here would reset
    // the bound on every single cron tick.
    assert.equal(after?.parkedSince, firstParkAt.toISOString());
    assert.deepEqual(h.messagesSent, []);
  });

  it('re-enqueues a parked stage-2 job under its own stage', async () => {
    const h = await makeHarness();
    const jobKey = await seedParked(h, {
      contractId: 'c-v',
      stage: 'vector',
      reason: 'vectorizer_outage',
      claimedAt: new Date(BASE.getTime() - 30 * MINUTE),
      firstParkAt: new Date(BASE.getTime() - 20 * MINUTE),
    });

    await runFifteenMinuteSweep(h.services);

    assert.deepEqual(h.queueSent, [{ contractId: 'c-v', jobKey, stage: 'vector' }]);
  });

  it('does not abort a job that only just parked, however old its claim is', async () => {
    // The reviewer's scenario, and the reason `created_at` is the wrong clock:
    // a lost Queue send leaves the job claimed for a day, the daily sweep
    // recovers it, and it parks for the FIRST time on a transient blip. Reading
    // age-since-claim aborts it on the next sweep — converting a recoverable
    // blip into a dead contract, and saying so in a note that is false twice
    // over.
    const h = await makeHarness();
    const claimedAt = new Date(BASE.getTime() - 24 * HOUR);
    const firstParkAt = new Date(BASE.getTime() - 10 * MINUTE);
    const jobKey = await seedParked(h, {
      contractId: 'c-lostsend',
      stage: 'concepts',
      reason: 'ocr_outage',
      claimedAt,
      firstParkAt,
    });
    // Fixture preconditions, inline and in both directions.
    assert.ok(BASE.getTime() - claimedAt.getTime() > PARKED_GIVE_UP_HOURS * HOUR);
    assert.ok(BASE.getTime() - firstParkAt.getTime() < PARKED_GIVE_UP_HOURS * HOUR);

    await runFifteenMinuteSweep(h.services);

    assert.deepEqual(h.queueSent, [{ contractId: 'c-lostsend', jobKey, stage: 'concepts' }]);
    assert.deepEqual(h.messagesSent, [], 'a job blocked for ten minutes must not be aborted');
    assert.equal((await h.jobs.get(jobKey))?.status, 'claimed');
  });

  it('gives up on a job blocked past the bound: tells the buyer, then aborts it', async () => {
    const h = await makeHarness();
    // THE THREE CLOCKS ARE THE POINT, and only one of them is right:
    //   parked_since  6h05m old  -> past the bound, give up            (correct)
    //   updated_at    0m old     -> a re-park happened this instant    (too new)
    //   created_at    7h old     -> also past the bound, but see the test above
    // The re-park is what a park -> unpark -> fail -> park loop does at every
    // cron tick; an implementation reading updated_at re-enqueues this job
    // forever.
    const firstParkAt = new Date(BASE.getTime() - (PARKED_GIVE_UP_HOURS * HOUR + 5 * MINUTE));
    const jobKey = await seedParked(h, {
      contractId: 'c-dead',
      stage: 'concepts',
      reason: 'vendor_outage',
      claimedAt: new Date(BASE.getTime() - 7 * HOUR),
      firstParkAt,
      reparkAt: BASE,
    });
    const parked = await h.jobs.get(jobKey);
    assert.equal(parked?.parkedSince, firstParkAt.toISOString());
    assert.ok(BASE.getTime() - Date.parse(parked!.parkedSince!) > PARKED_GIVE_UP_HOURS * HOUR);
    assert.equal(Date.parse(parked!.updatedAt), BASE.getTime());

    await runFifteenMinuteSweep(h.services);

    assert.deepEqual(h.queueSent, [], 'a job given up on must not also be re-enqueued');
    const after = await h.jobs.get(jobKey);
    assert.equal(after?.status, 'delivered');
    assert.equal(after?.outcome, 'aborted');

    assert.equal(h.messagesSent.length, 1);
    assert.equal(h.messagesSent[0].contractId, 'c-dead');
    assert.match(h.messagesSent[0].body, /could not deliver this contract/);
    assert.match(h.messagesSent[0].body, /image-generation vendor/);
    assert.match(h.messagesSent[0].body, /cannot cancel or refund a contract itself/);
    // Every duration claim is substantiated: the note quotes the recorded
    // blocked-since instant and the elapsed hours, and does NOT assert the
    // vendor was continuously unavailable for a span the row cannot prove.
    assert.match(h.messagesSent[0].body, /blocked since 2026-07-30T\d\d:\d\d/);
    assert.match(h.messagesSent[0].body, /over 6 hours/);
    assert.doesNotMatch(h.messagesSent[0].body, /unavailable continuously/);

    const trail = await h.jobs.listGateAudit(jobKey, 'parked-give-up');
    assert.equal(trail.length, 1);
    assert.equal(trail[0].result, 'aborted');
    const detail = trail[0].detail as { parkReason: string; parkedSince: string };
    assert.equal(detail.parkReason, 'vendor_outage');
    assert.equal(detail.parkedSince, firstParkAt.toISOString());

    // Terminal: the next sweep does not see it at all.
    await runFifteenMinuteSweep(h.services);
    assert.equal(h.messagesSent.length, 1);
    assert.deepEqual(h.queueSent, []);
  });

  it('gives up on a job that has spent PAST the cap, long before the clock would', async () => {
    // THE SECOND BOUND, and the one the clock cannot supply. A retryable
    // failure consumes no FR-5 attempt, so a vendor that bills and then fails
    // (a dead asset link, an unreadable 200) is re-enqueued every fifteen
    // minutes and buys another image every time. At six hours that is
    // twenty-four of them. This job is only twenty minutes into its spell —
    // well inside the age bound — and must still be stopped.
    const h = await makeHarness();
    const firstParkAt = new Date(BASE.getTime() - 20 * MINUTE);
    const jobKey = await seedParked(h, {
      contractId: 'c-burn',
      stage: 'concepts',
      reason: 'vendor_outage',
      claimedAt: new Date(BASE.getTime() - 25 * MINUTE),
      firstParkAt,
    });
    // Fixture preconditions, inline: the age bound is NOT what fires here.
    assert.ok(BASE.getTime() - firstParkAt.getTime() < PARKED_GIVE_UP_HOURS * HOUR);
    await h.jobs.saveCheckpoint(jobKey, { slots: [], spendUsd: MAX_SPEND_USD + 0.06 });
    const parked = await h.jobs.get(jobKey);
    assert.ok(parked!.spentUsd > MAX_SPEND_USD);

    await runFifteenMinuteSweep(h.services);

    assert.deepEqual(h.queueSent, [], 'a job over the cap must not be bought another attempt');
    const after = await h.jobs.get(jobKey);
    assert.equal(after?.status, 'delivered');
    assert.equal(after?.outcome, 'aborted');

    assert.equal(h.messagesSent.length, 1);
    // The note quotes the two real numbers and claims nothing about duration —
    // a twenty-minute-old job is not "blocked for over 6 hours".
    assert.match(h.messagesSent[0].body, /\$0\.66 of its own vendor budget/);
    assert.match(h.messagesSent[0].body, new RegExp(`\\$${MAX_SPEND_USD.toFixed(2)} per-job cap`));
    assert.doesNotMatch(h.messagesSent[0].body, /blocked since/);
    assert.doesNotMatch(h.messagesSent[0].body, /hours/);

    const trail = await h.jobs.listGateAudit(jobKey, 'parked-give-up');
    assert.equal(trail.length, 1);
    const detail = trail[0].detail as { bound: string; spentUsd: number; blockedHours: null };
    assert.equal(detail.bound, 'spend');
    assert.equal(detail.spentUsd, MAX_SPEND_USD + 0.06);
    assert.equal(detail.blockedHours, null, 'no duration claim the row cannot substantiate');
  });

  it('keeps re-enqueueing a job that spent its full allowance but no more', async () => {
    // `>` not `>=`, and this is the case that decides it. Today's worst
    // LEGITIMATE stage-1 burn lands EXACTLY on MAX_SPEND_USD (config.ts's
    // zero-slack comment), so a job that used its whole contracted
    // regeneration budget and then hit one transient OCR outage sits at the
    // cap with paid bytes safe in R2 — and the next sweep re-gates them for
    // free and delivers. A `>=` bound would abort that job instead.
    const h = await makeHarness();
    const jobKey = await seedParked(h, {
      contractId: 'c-atcap',
      stage: 'concepts',
      reason: 'ocr_outage',
      claimedAt: new Date(BASE.getTime() - 40 * MINUTE),
      firstParkAt: new Date(BASE.getTime() - 10 * MINUTE),
    });
    await h.jobs.saveCheckpoint(jobKey, { slots: [], spendUsd: MAX_SPEND_USD });
    assert.equal((await h.jobs.get(jobKey))?.spentUsd, MAX_SPEND_USD);

    await runFifteenMinuteSweep(h.services);

    assert.deepEqual(h.queueSent, [{ contractId: 'c-atcap', jobKey, stage: 'concepts' }]);
    assert.deepEqual(h.messagesSent, []);
  });

  it('survives a full day of unpark/re-park cycles without resetting the clock', async () => {
    // Twenty-four cron ticks — the exact loop the bound exists to stop. If any
    // of them restarted the clock, this job would never be given up on.
    const h = await makeHarness();
    const firstParkAt = new Date(BASE.getTime() - 6 * HOUR - 15 * MINUTE);
    const jobKey = await buildJobKey('c-loop', 'concepts');
    await h.at(new Date(firstParkAt.getTime() - MINUTE), () =>
      h.jobs.claim(jobKey, 'c-loop', 'concepts'),
    );
    await h.at(firstParkAt, () => h.jobs.park(jobKey, 'vendor_outage'));
    for (let tick = 1; tick <= 24; tick++) {
      await h.at(new Date(firstParkAt.getTime() + tick * 15 * MINUTE), async () => {
        await h.jobs.unpark(jobKey);
        await h.jobs.park(jobKey, 'vendor_outage');
      });
    }
    const parked = await h.jobs.get(jobKey);
    assert.equal(parked?.parkedSince, firstParkAt.toISOString());
    assert.equal(Date.parse(parked!.updatedAt), firstParkAt.getTime() + 24 * 15 * MINUTE);

    await runFifteenMinuteSweep(h.services);

    assert.equal((await h.jobs.get(jobKey))?.outcome, 'aborted');
    assert.equal(h.messagesSent.length, 1);
  });

  it('clears the blocked-since clock when a job recovers and completes', async () => {
    const h = await makeHarness();
    const jobKey = await seedParked(h, {
      contractId: 'c-recovered',
      stage: 'concepts',
      reason: 'ocr_outage',
      claimedAt: new Date(BASE.getTime() - 3 * HOUR),
      firstParkAt: new Date(BASE.getTime() - 2 * HOUR),
    });
    await h.jobs.unpark(jobKey);
    await h.jobs.markDelivered(jobKey, 'delivered');
    // Nothing stale survives a terminal state: a later, unrelated park starts a
    // fresh clock rather than inheriting hours the job already recovered from.
    assert.equal((await h.jobs.get(jobKey))?.parkedSince, null);
  });

  it('tells a stage-2 give-up that Milestone 1 still stands', async () => {
    const h = await makeHarness();
    await seedParked(h, {
      contractId: 'c-dead2',
      stage: 'vector',
      reason: 'vectorizer_outage',
      claimedAt: new Date(BASE.getTime() - (PARKED_GIVE_UP_HOURS * HOUR + 2 * MINUTE)),
      firstParkAt: new Date(BASE.getTime() - (PARKED_GIVE_UP_HOURS * HOUR + MINUTE)),
    });

    await runFifteenMinuteSweep(h.services);

    assert.equal(h.messagesSent.length, 1);
    assert.match(h.messagesSent[0].body, /Milestone 1 concepts .* remain delivered/s);
    assert.match(h.messagesSent[0].body, /vectorization vendor/);
  });

  it('never tells a free-gig buyer to cancel an escrow that does not exist', async () => {
    const h = await makeHarness();
    await seedParked(h, {
      contractId: 'c-free',
      stage: 'single',
      reason: 'vendor_outage',
      claimedAt: new Date(BASE.getTime() - (PARKED_GIVE_UP_HOURS * HOUR + 2 * MINUTE)),
      firstParkAt: new Date(BASE.getTime() - (PARKED_GIVE_UP_HOURS * HOUR + MINUTE)),
    });

    await runFifteenMinuteSweep(h.services);

    assert.equal(h.messagesSent.length, 1);
    assert.doesNotMatch(h.messagesSent[0].body, /escrow/i);
    assert.doesNotMatch(h.messagesSent[0].body, /cancel this contract from your side/i);
    assert.match(h.messagesSent[0].body, /nothing has been charged/i);
    assert.match(h.messagesSent[0].body, /nothing for you to cancel/i);
  });

  it('never leaks an unrecognized park reason into the buyer-facing note', async () => {
    const h = await makeHarness();
    await seedParked(h, {
      contractId: 'c-odd',
      stage: 'concepts',
      reason: '__proto__',
      claimedAt: new Date(BASE.getTime() - (PARKED_GIVE_UP_HOURS * HOUR + 2 * MINUTE)),
      firstParkAt: new Date(BASE.getTime() - (PARKED_GIVE_UP_HOURS * HOUR + MINUTE)),
    });

    await runFifteenMinuteSweep(h.services);

    assert.equal(h.messagesSent.length, 1);
    assert.doesNotMatch(h.messagesSent[0].body, /__proto__|\[object/);
    assert.match(h.messagesSent[0].body, /a vendor LogoSmith depends on for this job/i);
  });
});

// ===============================================================================
// Daily sweep — §12 stuck-claim recovery
// ===============================================================================

describe('daily sweep', () => {
  it('re-enqueues stuck claims older than the cutoff and leaves fresher ones', async () => {
    const h = await makeHarness();
    const staleAt = new Date(BASE.getTime() - (STUCK_CLAIM_MINUTES + 15) * MINUTE);
    const freshAt = new Date(BASE.getTime() - (STUCK_CLAIM_MINUTES - 20) * MINUTE);
    // Fixture preconditions, inline: the two ages genuinely bracket the cutoff.
    assert.ok(BASE.getTime() - staleAt.getTime() > STUCK_CLAIM_MINUTES * MINUTE);
    assert.ok(BASE.getTime() - freshAt.getTime() < STUCK_CLAIM_MINUTES * MINUTE);

    const staleKey = await buildJobKey('c-stale', 'concepts');
    const freshKey = await buildJobKey('c-fresh', 'concepts');
    await h.at(staleAt, () => h.jobs.claim(staleKey, 'c-stale', 'concepts'));
    await h.at(freshAt, () => h.jobs.claim(freshKey, 'c-fresh', 'concepts'));

    await runDailySweep(h.services);

    assert.deepEqual(h.queueSent, [{ contractId: 'c-stale', jobKey: staleKey, stage: 'concepts' }]);
  });

  it('leaves a checkpointed job alone however old its claim is', async () => {
    const h = await makeHarness();
    const oldAt = new Date(BASE.getTime() - 6 * HOUR);
    const jobKey = await buildJobKey('c-running', 'concepts');
    await h.at(oldAt, async () => {
      await h.jobs.claim(jobKey, 'c-running', 'concepts');
      await h.jobs.saveCheckpoint(jobKey, { slots: [slotState(1, 'passed', 0.9)], spendUsd: 0.5 });
    });

    await runDailySweep(h.services);

    assert.deepEqual(h.queueSent, []);
  });
});

// ===============================================================================
// Gig discovery
// ===============================================================================

describe('maybePropose', () => {
  it('bids on a paid logo gig through the estimator-backed proposer', async () => {
    const h = await makeHarness();
    await maybePropose(h.services, makeGig({ id: 'g-paid', budget: 25 }));
    assert.equal(h.proposalsSent.length, 1);
    assert.equal(h.proposalsSent[0].gigId, 'g-paid');
    assert.equal(h.proposalsSent[0].proposer, 'paid');
  });

  it('routes a $0 free-funnel gig to the estimator-free proposer', async () => {
    const h = await makeHarness();
    await maybePropose(h.services, makeGig({ id: 'g-free', budget: 0 }));
    assert.equal(h.proposalsSent.length, 1);
    assert.equal(h.proposalsSent[0].proposer, 'free');
  });

  it('routes a favicon-brief gig to the free proposer even at a non-zero budget', async () => {
    const h = await makeHarness();
    await maybePropose(
      h.services,
      makeGig({
        id: 'g-favicon',
        budget: 25,
        description:
          '```json\n{"logoUrl":"https://cdn.example.com/logo.png"}\n```\nFavicon pack please.',
      }),
    );
    assert.equal(h.proposalsSent.length, 1);
    assert.equal(h.proposalsSent[0].proposer, 'free');
    assert.deepEqual(
      h.extractorCalls,
      [],
      'a favicon gig carries no LogoBrief; extracting a brand name from it would only refuse it',
    );
  });

  it('stays silent on an unrelated gig', async () => {
    const h = await makeHarness();
    await maybePropose(
      h.services,
      makeGig({
        id: 'g-off',
        category: 'Pet Care',
        title: 'Dog walking',
        description: 'Walk my dog.',
      }),
    );
    assert.deepEqual(h.proposalsSent, []);
  });

  it('discovers and bids through the 15-minute sweep', async () => {
    const h = await makeHarness();
    h.openGigs.value = [makeGig({ id: 'g-swept' })];
    await runFifteenMinuteSweep(h.services);
    assert.deepEqual(
      h.proposalsSent.map((entry) => entry.gigId),
      ['g-swept'],
    );
  });
});

describe('maybePropose — brief intake gates the bid (Task 27)', () => {
  // The default gig description is prose with no fenced JSON — the shape a
  // live probe measured on 78 of 78 open gigs — so these tests exercise the
  // fallback rather than a synthetic edge case.
  const PROSE = 'A logo for Harbor & Vine, our new seaside inn.';
  assert.equal(parseLogoBrief(PROSE).ok, false, 'precondition: prose has no fenced brief');

  it('bids on a prose gig once the extractor resolves a brief', async () => {
    const h = await makeHarness();
    await maybePropose(h.services, makeGig({ id: 'g-prose', description: PROSE }));

    assert.equal(h.extractorCalls.length, 1, 'the fenced path found nothing, so extraction ran');
    assert.deepEqual(
      h.proposalsSent.map((entry) => entry.gigId),
      ['g-prose'],
    );
  });

  it('does not bid when neither the fenced brief nor the prose yields one', async () => {
    const h = await makeHarness();
    h.extractorResult.value = { ok: false, reason: 'the gig names no brand' };

    await maybePropose(h.services, makeGig({ id: 'g-nameless', description: PROSE }));

    assert.equal(h.extractorCalls.length, 1, 'precondition: the extractor was consulted');
    assert.deepEqual(
      h.proposalsSent,
      [],
      'the pipeline would reject this contract after funding; do not win it',
    );
  });

  it('never pays for extraction on a gig that failed the relevance bar', async () => {
    const h = await makeHarness();
    // Scored first, extracted second — the difference between ~$0.0008 per
    // candidate and ~$0.0008 x every gig on the marketplace, every 15 minutes.
    await maybePropose(
      h.services,
      makeGig({
        id: 'g-off',
        category: 'Pet Care',
        title: 'Dog walking',
        description: 'Walk him.',
      }),
    );

    assert.deepEqual(h.proposalsSent, []);
    assert.deepEqual(h.extractorCalls, []);
  });

  it('never pays for extraction when the gig already carries a fenced brief', async () => {
    const h = await makeHarness();
    const description = '```json\n{"brandName":"Harbor & Vine","industry":"inn"}\n```';
    assert.equal(parseLogoBrief(description).ok, true, 'precondition: the fenced path resolves');

    await maybePropose(h.services, makeGig({ id: 'g-fenced', description }));

    assert.equal(h.proposalsSent.length, 1);
    assert.deepEqual(h.extractorCalls, [], 'the fenced fast path must stay free');
  });

  it('hands the extractor the structured gig fields, not just the description', async () => {
    const h = await makeHarness();
    await maybePropose(
      h.services,
      makeGig({
        id: 'g-rich',
        description: PROSE,
        deliverables: ['Primary lockup'],
        tags: ['logo', 'hospitality'],
      }),
    );

    assert.equal(h.extractorCalls.length, 1);
    assert.deepEqual(h.extractorCalls[0]!.deliverables, ['Primary lockup']);
    assert.deepEqual(h.extractorCalls[0]!.tags, ['logo', 'hospitality']);
  });
});

// ===============================================================================
// Step isolation
// ===============================================================================

describe('15-minute sweep step isolation', () => {
  it('completes the later steps when an earlier one throws', async () => {
    const h = await makeHarness();
    h.breakNegotiation.value = true;
    const m1At = new Date(BASE.getTime() - (SELECTION_TIMEOUT_HOURS + 1) * HOUR);
    await seedDeliveredM1(h, {
      contractId: 'c-iso',
      delivered: [1, 2],
      scores: { 1: 0.87, 2: 0.93 },
      m1At,
    });
    h.threads.set('c-iso', [botSays('m0', 'reply with `concept 1|2`', m1At)]);
    await seedParked(h, {
      contractId: 'c-iso-parked',
      stage: 'concepts',
      reason: 'ocr_outage',
      claimedAt: new Date(BASE.getTime() - 20 * MINUTE),
      firstParkAt: new Date(BASE.getTime() - 10 * MINUTE),
    });

    // Must not reject: a scheduled handler that throws loses every step after
    // the failure, and Workers kills the invocation the moment it settles.
    await runFifteenMinuteSweep(h.services);

    // Steps 3, 4 and 5 all landed despite step 2 blowing up.
    assert.equal((await h.selection.get('c-iso'))?.state, 'winner_selected');
    assert.deepEqual(h.queueSent.map((message) => message.stage).sort(), ['concepts', 'vector']);
    assert.ok(await loadReputationSnapshot(h.db));
  });

  it('carries on when one contract in the selection poll fails', async () => {
    const h = await makeHarness();
    const m1At = new Date(BASE.getTime() - (SELECTION_TIMEOUT_HOURS + 1) * HOUR);
    // The first contract's thread read throws; the second must still be
    // resolved in the same sweep. Both are past the timeout, so 'boom' would
    // otherwise have default-selected — its state below is evidence the
    // failure happened, not that the row was skipped.
    await seedDeliveredM1(h, {
      contractId: 'boom',
      delivered: [1],
      scores: { 1: 0.9 },
      m1At,
    });
    await seedDeliveredM1(h, {
      contractId: 'c-ok',
      delivered: [1, 2],
      scores: { 1: 0.87, 2: 0.93 },
      m1At,
    });
    h.threads.set('c-ok', [botSays('m0', 'reply with `concept 1|2`', m1At)]);
    h.failThreadsFor.add('boom');

    await runFifteenMinuteSweep(h.services);

    assert.equal((await h.selection.get('boom'))?.state, 'concepts_delivered');
    assert.equal((await h.selection.get('c-ok'))?.state, 'winner_selected');
    assert.equal((await h.selection.get('c-ok'))?.winnerSlot, 2);
  });
});
