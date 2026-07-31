import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DisputeResponseInput, WebhookEvent } from '@botguild/agent-core';
import { createConsoleLogger, type D1Like } from '@botguild/agent-core-workers';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import {
  assembleDisputeEvidence,
  createDisputeResponder,
  formatDisputeResponse,
  type DisputeDeps,
  type DisputeEvidence,
} from './disputes.js';
import { createDisputeHandlers } from './index.js';
import {
  buildJobKey,
  createConceptStore,
  createJobStore,
  createSelectionStore,
  type ConceptUpsert,
} from './jobs.js';
import { MODERATION_MODEL, MODERATION_VENDOR, type ModerationVerdict } from './moderation.js';
import { applyMigrations } from './testSupport.js';
import type { JobOutcome } from './types.js';

const CONTRACT = 'contract-disputed-1';
const OTHER_CONTRACT = 'contract-someone-else';
const BASE_URL = 'https://logosmith.example.com';
const NOW = new Date('2026-07-31T09:00:00.000Z');

const silentLogger = createConsoleLogger({ service: 'logosmith-test', level: 'silent' });

/** A real-shaped screening verdict — `summarizeInputScreening` only quotes a
 *  row that carries every field of a ModerationVerdict. */
const SCREENING: ModerationVerdict = {
  vendor: MODERATION_VENDOR,
  model: MODERATION_MODEL,
  flagged: false,
  response: {
    id: 'modr-dispute-1',
    model: MODERATION_MODEL,
    results: [{ flagged: false, categories: { violence: false }, category_scores: {} }],
  },
  checkedAt: '2026-07-30T11:58:00.000Z',
};

/**
 * Three concepts as stage 1 actually wrote them. Slot 2's readback pair is
 * DELIBERATELY inconsistent with today's threshold (score 0.51, pass true):
 * anything that recomputed the verdict instead of reading the stored snapshot
 * would report `pass: false` here, so the fixture is what makes "drawn from the
 * table, not recomputed" a falsifiable claim.
 */
const CONCEPTS: ConceptUpsert[] = [
  {
    contractId: CONTRACT,
    slot: 1,
    axisId: 'wordmark',
    vendor: 'ideogram',
    vendorRequestId: 'ideogram-req-1',
    r2Key: 'tok1/concept-1.png',
    phash: '0000000000000000',
    ocrTranscription: 'Harbor & Vine',
    ocrScore: 0.97,
    ocrModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
    ocrPass: true,
    attemptsUsed: 1,
  },
  {
    contractId: CONTRACT,
    slot: 2,
    axisId: 'lockup',
    vendor: 'ideogram',
    vendorRequestId: 'ideogram-req-2',
    r2Key: 'tok1/concept-2.png',
    phash: 'ffffffffffff0000',
    ocrTranscription: 'Harbcr & Vine',
    ocrScore: 0.51,
    ocrModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
    ocrPass: true,
    attemptsUsed: 2,
  },
  {
    contractId: CONTRACT,
    slot: 3,
    axisId: 'emblem',
    vendor: 'recraft',
    vendorRequestId: 'recraft-req-3',
    r2Key: 'tok1/concept-3.png',
    phash: '0f0f0f0f0f0f0f0f',
    ocrTranscription: 'Harbor and Vine',
    ocrScore: 0.88,
    ocrModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
    ocrPass: true,
    attemptsUsed: 3,
  },
];

interface Seeded {
  db: D1Like;
  deps: DisputeDeps;
  posts: DisputeResponseInput[];
  conceptsKey: string;
  vectorKey: string;
}

interface SeedOptions {
  concepts?: ConceptUpsert[];
  /** Terminal disposition recorded on the concepts stage. */
  conceptsOutcome?: JobOutcome;
  /** Skip the selection row entirely (nothing was ever delivered at M1). */
  withoutSelection?: boolean;
  /** Skip the FR-2 screening row (no cleared screening on record). */
  withoutScreening?: boolean;
  /** Skip both stage claims (D1 holds no job row for this contract). */
  withoutJobs?: boolean;
  respondToDispute?: (input: DisputeResponseInput) => Promise<{ responseId: string }>;
}

/**
 * Seeds a disputed contract through the real stores — the same calls the
 * pipeline makes — so the evidence is assembled from rows that a live job would
 * actually have left behind.
 */
async function seed(options: SeedOptions = {}): Promise<Seeded> {
  const db = createMemoryD1();
  await applyMigrations(db);
  const clock = (): Date => NOW;
  const jobs = createJobStore(db, clock);
  const concepts = createConceptStore(db, clock);
  const selection = createSelectionStore(db, clock);

  const conceptsKey = await buildJobKey(CONTRACT, 'concepts');
  const vectorKey = await buildJobKey(CONTRACT, 'vector');
  const otherKey = await buildJobKey(OTHER_CONTRACT, 'concepts');

  if (!options.withoutJobs) {
    await jobs.claim(conceptsKey, CONTRACT, 'concepts');
    await jobs.setInProgress(conceptsKey, {
      kind: 'logo',
      gigId: 'gig-1',
      payerId: 'payer-1',
      briefJson: JSON.stringify({ brandName: 'Harbor & Vine', industry: 'boutique inn' }),
    });
    await jobs.saveCheckpoint(conceptsKey, { slots: [], spendUsd: 0.42 });
    await jobs.markDelivered(conceptsKey, options.conceptsOutcome ?? 'delivered');

    await jobs.claim(vectorKey, CONTRACT, 'vector');
    await jobs.saveCheckpoint(vectorKey, { slots: [], spendUsd: 0.2 });
    await jobs.markDelivered(vectorKey, 'delivered');
  }

  // A third contract's trail, to prove the evidence is contract-scoped.
  await jobs.claim(otherKey, OTHER_CONTRACT, 'concepts');
  await jobs.recordGateAudit({
    jobKey: otherKey,
    contractId: OTHER_CONTRACT,
    gate: 'moderation',
    result: 'clear',
    detail: { ...SCREENING, response: { id: 'modr-not-ours' } },
  });

  for (const concept of options.concepts ?? CONCEPTS) {
    await concepts.upsert(concept);
  }

  if (!options.withoutSelection) {
    await selection.open(CONTRACT);
    await selection.select(CONTRACT, 2, 'buyer');
  }

  // INTERLEAVED ACROSS THE TWO STAGE KEYS, on purpose: a concepts row, then a
  // vector row, then another concepts row. Any assembly that reads one stage's
  // trail then concatenates the other's returns these out of order.
  if (!options.withoutScreening) {
    await jobs.recordGateAudit({
      jobKey: conceptsKey,
      contractId: CONTRACT,
      gate: 'moderation',
      result: 'clear',
      detail: SCREENING,
    });
  }
  await jobs.recordGateAudit({
    jobKey: conceptsKey,
    contractId: CONTRACT,
    slot: 1,
    gate: 'ocr',
    result: 'pass',
    detail: { score: 0.97 },
  });
  await jobs.recordGateAudit({
    jobKey: vectorKey,
    contractId: CONTRACT,
    slot: 2,
    gate: 'vectorize',
    result: 'vectorizer',
    detail: { source: 'vectorizer', costUsd: 0.2 },
  });
  await jobs.recordGateAudit({
    jobKey: conceptsKey,
    contractId: CONTRACT,
    gate: 'm1-delivery',
    result: 'delivered',
    detail: { milestoneId: 'ms-1' },
  });

  const posts: DisputeResponseInput[] = [];
  const deps: DisputeDeps = {
    db,
    jobs,
    concepts,
    selection,
    mcp: {
      respondToDispute: async (input) => {
        posts.push(input);
        return options.respondToDispute
          ? options.respondToDispute(input)
          : { responseId: `resp-${posts.length}` };
      },
    },
    publicBaseUrl: BASE_URL,
    logger: silentLogger,
    now: clock,
  };
  return { db, deps, posts, conceptsKey, vectorKey };
}

const gapMatching = (evidence: DisputeEvidence, pattern: RegExp): string[] =>
  evidence.evidenceGaps.filter((gap) => pattern.test(gap));

// ---------------------------------------------------------------------------
// The OCR verdict snapshots (§9: the snapshot is the record)
// ---------------------------------------------------------------------------

describe('assembleDisputeEvidence — readback verdict snapshots', () => {
  it('returns every stored verdict as written, rather than recomputing it', async () => {
    const { deps } = await seed();
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);

    assert.equal(evidence.contractId, CONTRACT);
    assert.deepEqual(
      evidence.concepts.map((c) => c.slot),
      [1, 2, 3],
    );
    assert.deepEqual(
      evidence.concepts.map((c) => c.ocr),
      [
        {
          model: '@cf/meta/llama-4-scout-17b-16e-instruct',
          transcription: 'Harbor & Vine',
          score: 0.97,
          pass: true,
        },
        {
          model: '@cf/meta/llama-4-scout-17b-16e-instruct',
          transcription: 'Harbcr & Vine',
          score: 0.51,
          pass: true,
        },
        {
          model: '@cf/meta/llama-4-scout-17b-16e-instruct',
          transcription: 'Harbor and Vine',
          score: 0.88,
          pass: true,
        },
      ],
    );
    // Precondition, asserted inline: slot 2's stored pair is one no live gate
    // would produce today, so a recomputed `pass` could not match it.
    assert.equal(CONCEPTS[1]!.ocrScore, 0.51);
    assert.equal(CONCEPTS[1]!.ocrPass, true);
  });

  it('reports a genuinely zero readback score as a verdict, not as a missing one', async () => {
    const zeroed: ConceptUpsert = {
      ...CONCEPTS[0]!,
      ocrTranscription: '',
      ocrScore: 0,
      ocrPass: false,
    };
    const { deps } = await seed({ concepts: [zeroed] });
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);

    assert.equal(evidence.concepts.length, 1);
    assert.deepEqual(evidence.concepts[0]!.ocr, {
      model: '@cf/meta/llama-4-scout-17b-16e-instruct',
      transcription: '',
      score: 0,
      pass: false,
    });
    assert.deepEqual(
      gapMatching(evidence, /readback verdict/),
      [],
      'a score of 0 is a measurement, not a gap',
    );
  });

  it('names the slots whose verdict is missing instead of dropping the concept', async () => {
    const unreached: ConceptUpsert = {
      contractId: CONTRACT,
      slot: 2,
      axisId: 'lockup',
      vendor: 'ideogram',
      vendorRequestId: 'ideogram-req-2',
      attemptsUsed: 4,
    };
    const { deps } = await seed({ concepts: [CONCEPTS[0]!, unreached] });
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);

    assert.equal(evidence.concepts.length, 2, 'the concept is still reported');
    assert.equal(evidence.concepts[1]!.slot, 2);
    assert.equal(evidence.concepts[1]!.ocr, null);
    assert.equal(evidence.concepts[1]!.attemptsUsed, 4, 'what IS known is still reported');
    const gaps = gapMatching(evidence, /readback verdict/);
    assert.equal(gaps.length, 1);
    // Exactly slot 2 — slot 1 has a verdict and must not be named as missing.
    assert.match(gaps[0]!, /concept slots: 2\./);
  });
});

// ---------------------------------------------------------------------------
// The gate audit trail (FR-17)
// ---------------------------------------------------------------------------

describe('assembleDisputeEvidence — the gate audit trail', () => {
  it('merges both stage keys into one chronological trail', async () => {
    const { deps } = await seed();
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);

    assert.deepEqual(
      evidence.gateAudit.map((row) => [row.stage, row.gate, row.result]),
      [
        ['concepts', 'moderation', 'clear'],
        ['concepts', 'ocr', 'pass'],
        ['vector', 'vectorize', 'vectorizer'],
        ['concepts', 'm1-delivery', 'delivered'],
      ],
      'insert order across stages, not one stage then the other',
    );
    const ids = evidence.gateAudit.map((row) => row.id);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
    );
    assert.equal(new Set(ids).size, ids.length);
  });

  it('carries each row detail through verbatim', async () => {
    const { deps } = await seed();
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);
    const vectorize = evidence.gateAudit.find((row) => row.gate === 'vectorize');
    assert.deepEqual(vectorize?.detail, { source: 'vectorizer', costUsd: 0.2 });
    assert.equal(vectorize?.slot, 2);
  });

  it("excludes another contract's audit rows", async () => {
    const { deps } = await seed();
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);
    const serialized = JSON.stringify(evidence);
    assert.equal(serialized.includes('modr-not-ours'), false);
    assert.equal(serialized.includes(OTHER_CONTRACT), false);
  });

  it('quotes the cleared pre-generation screening from the trail', async () => {
    const { deps } = await seed();
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);
    assert.deepEqual(evidence.inputScreening.verdict, SCREENING);
    assert.equal(evidence.inputScreening.outageAttempts, 0);
  });

  it('names the gap when no cleared screening is on record', async () => {
    const { deps } = await seed({ withoutScreening: true });
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);
    assert.equal(evidence.inputScreening.verdict, null);
    assert.equal(gapMatching(evidence, /screening/).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Per-image provenance (§8, §14)
// ---------------------------------------------------------------------------

describe('assembleDisputeEvidence — vendor provenance', () => {
  it("carries every concept's vendor request id", async () => {
    const { deps } = await seed();
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);

    assert.deepEqual(
      evidence.concepts.map((c) => [c.vendor, c.vendorRequestId]),
      [
        ['ideogram', 'ideogram-req-1'],
        ['ideogram', 'ideogram-req-2'],
        ['recraft', 'recraft-req-3'],
      ],
    );
  });

  it('resolves each request id to the licence terms it was produced under', async () => {
    const { deps } = await seed();
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);

    assert.deepEqual(
      evidence.licenses.entries.map((entry) => [entry.artifact, entry.vendorRequestId]),
      [
        ['concept-1.png', 'ideogram-req-1'],
        ['concept-2.png', 'ideogram-req-2'],
        ['concept-3.png', 'recraft-req-3'],
      ],
    );
    assert.match(evidence.licenses.entries[0]!.scope, /Ideogram/);
    assert.match(evidence.licenses.entries[2]!.scope, /Recraft/);
  });

  it('reports a null request id as null rather than omitting the image', async () => {
    const noRequestId: ConceptUpsert = { ...CONCEPTS[0]!, vendorRequestId: undefined };
    const { deps } = await seed({ concepts: [noRequestId] });
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);
    assert.equal(evidence.concepts.length, 1);
    assert.equal(evidence.concepts[0]!.vendorRequestId, null);
    assert.equal(evidence.licenses.entries[0]!.vendorRequestId, null);
  });
});

// ---------------------------------------------------------------------------
// The winner (FR-9) — "you sent me the wrong concept"
// ---------------------------------------------------------------------------

describe('assembleDisputeEvidence — the winner and how it was chosen', () => {
  it('records the winner slot and the selection source', async () => {
    const { deps } = await seed();
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);
    assert.deepEqual(evidence.selection, {
      state: 'winner_selected',
      winnerSlot: 2,
      selectionSource: 'buyer',
      m1DeliveredAt: NOW.toISOString(),
    });
  });

  it('distinguishes a default selection from a buyer selection', async () => {
    const db = createMemoryD1();
    await applyMigrations(db);
    const selection = createSelectionStore(db, () => NOW);
    await selection.open(CONTRACT);
    await selection.select(CONTRACT, 3, 'default');

    const { deps } = await seed();
    const evidence = await assembleDisputeEvidence({ ...deps, selection }, CONTRACT);
    assert.equal(evidence.selection?.winnerSlot, 3);
    assert.equal(evidence.selection?.selectionSource, 'default');
  });
});

// ---------------------------------------------------------------------------
// A contract with nothing on record
// ---------------------------------------------------------------------------

describe('assembleDisputeEvidence — missing evidence', () => {
  it('returns a well-formed response for an aborted job with no concepts', async () => {
    const { deps } = await seed({
      concepts: [],
      conceptsOutcome: 'aborted',
      withoutSelection: true,
    });
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);

    assert.equal(evidence.version, 1);
    assert.equal(evidence.contractId, CONTRACT);
    assert.equal(evidence.assembledAt, NOW.toISOString());
    assert.deepEqual(evidence.concepts, []);
    assert.deepEqual(evidence.licenses.entries, []);
    assert.equal(evidence.selection, null);
    // The stage record is still there — an aborted job is not an absent one.
    assert.equal(evidence.stages.find((s) => s.stage === 'concepts')?.job?.outcome, 'aborted');
    assert.ok(evidence.gateAudit.length > 0, 'the trail that shows where it stopped is quoted');
    assert.equal(gapMatching(evidence, /concept row/).length, 1);
    assert.equal(gapMatching(evidence, /selection record/).length, 1);
    assert.equal(evidence.evidenceGaps.length, 2, 'and nothing else is claimed to be missing');
  });

  it('names every gap for a contract with nothing on record at all', async () => {
    const db = createMemoryD1();
    await applyMigrations(db);
    const deps = {
      jobs: createJobStore(db, () => NOW),
      concepts: createConceptStore(db, () => NOW),
      selection: createSelectionStore(db, () => NOW),
      publicBaseUrl: BASE_URL,
      now: (): Date => NOW,
    };
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);

    assert.deepEqual(evidence.evidenceGaps.length, 5);
    for (const pattern of [
      /no job row/,
      /concept row/,
      /selection record/,
      /screening/,
      /audit trail for this contract is empty/,
    ]) {
      assert.equal(gapMatching(evidence, pattern).length, 1, `missing gap for ${pattern.source}`);
    }
    assert.deepEqual(evidence.gateAudit, []);
    assert.deepEqual(evidence.evidenceUrls, []);
  });

  it('names the gap when D1 holds no job row for the contract at all', async () => {
    const { deps } = await seed({ withoutJobs: true, concepts: [], withoutSelection: true });
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);

    assert.deepEqual(
      evidence.stages.map((s) => s.job),
      [null, null, null],
    );
    for (const stage of evidence.stages) {
      assert.equal(typeof stage.jobKey, 'string');
      assert.ok(stage.jobKey.endsWith(`:${stage.stage}`));
    }
    assert.equal(gapMatching(evidence, /no job row/).length, 1);
    // The trail itself survived the missing job rows, so it is NOT reported as
    // a gap: gate_audit is keyed by the stage key, not by the jobs row.
    assert.ok(evidence.gateAudit.length > 0);
    assert.equal(gapMatching(evidence, /audit trail for this contract is empty/).length, 0);
  });

  it('reports no gaps at all for a contract whose record is complete', async () => {
    const { deps } = await seed();
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);
    assert.deepEqual(evidence.evidenceGaps, [], 'nothing is missing on the normal path');
  });

  it('reports a stage that was never claimed as absent, not as a gap', async () => {
    const { deps } = await seed();
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);
    const single = evidence.stages.find((stage) => stage.stage === 'single');
    assert.equal(single?.job, null, 'a paid contract never claims the free-gig stage');
    assert.deepEqual(evidence.evidenceGaps, []);
  });

  it('survives a JSON round-trip', async () => {
    const { deps } = await seed();
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);
    assert.deepEqual(JSON.parse(JSON.stringify(evidence)) as DisputeEvidence, evidence);
  });
});

// ---------------------------------------------------------------------------
// Evidence URLs
// ---------------------------------------------------------------------------

describe('assembleDisputeEvidence — evidence urls', () => {
  it('links the delivered report, licences and pack under the stage that wrote them', async () => {
    const { deps, db } = await seed();
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);
    const tokens = await db
      .prepare('SELECT stage, deliverable_token AS token FROM jobs WHERE contract_id = ?')
      .bind(CONTRACT)
      .all<{ stage: string; token: string }>();
    const tokenFor = (stage: string): string =>
      tokens.results.find((row) => row.stage === stage)!.token;

    assert.deepEqual(evidence.evidenceUrls, [
      `${BASE_URL}/p/${tokenFor('concepts')}`,
      `${BASE_URL}/p/${tokenFor('vector')}`,
      `${BASE_URL}/deliverables/${tokenFor('vector')}/pack.zip`,
      `${BASE_URL}/deliverables/${tokenFor('vector')}/report.json`,
      `${BASE_URL}/deliverables/${tokenFor('vector')}/licenses.json`,
    ]);
  });

  it('links no pack artifacts for a stage that never delivered one', async () => {
    const db = createMemoryD1();
    await applyMigrations(db);
    const jobs = createJobStore(db, () => NOW);
    const vectorKey = await buildJobKey(CONTRACT, 'vector');
    await jobs.claim(vectorKey, CONTRACT, 'vector');
    await jobs.markDelivered(vectorKey, 'aborted');

    const { deps } = await seed();
    const evidence = await assembleDisputeEvidence({ ...deps, jobs }, CONTRACT);
    assert.equal(
      evidence.evidenceUrls.some((url) => url.includes('/deliverables/')),
      false,
      'an aborted pack stage wrote no report.json to link',
    );
    assert.equal(evidence.evidenceUrls.length, 1, 'the evidence page is still linked');
  });
});

// ---------------------------------------------------------------------------
// respond() — exactly once
// ---------------------------------------------------------------------------

describe('createDisputeResponder', () => {
  it('posts the assembled evidence through the MCP client', async () => {
    const { deps, posts } = await seed();
    await createDisputeResponder(deps).respond(CONTRACT);

    assert.equal(posts.length, 1);
    const post = posts[0]!;
    assert.equal(post.contractId, CONTRACT);
    assert.equal(post.evidenceType, 'logs');

    const evidence = await assembleDisputeEvidence(deps, CONTRACT);
    assert.deepEqual(post.evidenceUrls, evidence.evidenceUrls);
    assert.equal(post.response, formatDisputeResponse(evidence));
    // The whole document has to reach the reader, not a summary of it: the
    // JSON tail parses back to exactly what was assembled.
    const embedded = JSON.parse(post.response.slice(post.response.indexOf('{'))) as DisputeEvidence;
    assert.deepEqual(embedded, evidence);
    assert.ok(
      post.response.slice(0, post.response.indexOf('{')).includes(CONTRACT),
      'the covering statement names the contract it answers',
    );
  });

  it('is idempotent across redelivered dispute webhooks', async () => {
    const { deps, posts, db } = await seed();
    const responder = createDisputeResponder(deps);
    await responder.respond(CONTRACT);
    await responder.respond(CONTRACT);
    await createDisputeResponder(deps).respond(CONTRACT);

    assert.equal(posts.length, 1, 'a redelivery must not file a second counter-statement');
    const claim = await db
      .prepare('SELECT contract_id, responded_at FROM dispute_responses WHERE contract_id = ?')
      .bind(CONTRACT)
      .first<{ contract_id: string; responded_at: string }>();
    assert.equal(claim?.responded_at, NOW.toISOString());
  });

  it('collapses concurrent redeliveries to exactly one post', async () => {
    // The MCP call is held open until every caller is inside `respond`, so a
    // responder that claimed AFTER posting (or read-then-wrote) would have all
    // three in flight at once and post three times.
    let release = (): void => {};
    const allInFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, posts } = await seed({
      respondToDispute: async () => {
        await allInFlight;
        return { responseId: 'resp-concurrent' };
      },
    });
    const responder = createDisputeResponder(deps);
    const flight = Promise.all([
      responder.respond(CONTRACT),
      responder.respond(CONTRACT),
      responder.respond(CONTRACT),
    ]);
    release();
    await flight;

    assert.equal(posts.length, 1);
  });

  it('releases the claim when the post fails, so a later delivery retries', async () => {
    let attempts = 0;
    const { deps, posts, db } = await seed({
      respondToDispute: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('mcp 503');
        return { responseId: 'resp-2' };
      },
    });
    const responder = createDisputeResponder(deps);

    await assert.rejects(responder.respond(CONTRACT), /mcp 503/);
    const afterFailure = await db
      .prepare('SELECT contract_id FROM dispute_responses WHERE contract_id = ?')
      .bind(CONTRACT)
      .first<{ contract_id: string }>();
    assert.equal(afterFailure, null, 'a failed post must not leave the contract claimed');

    await responder.respond(CONTRACT);
    assert.equal(posts.length, 2, 'the retry posted');
    assert.equal(attempts, 2);
  });

  it('answers a dispute on a contract with no work on record', async () => {
    const { deps, posts } = await seed({
      withoutJobs: true,
      concepts: [],
      withoutSelection: true,
      withoutScreening: true,
    });
    await createDisputeResponder(deps).respond(CONTRACT);

    assert.equal(posts.length, 1);
    const embedded = JSON.parse(
      posts[0]!.response.slice(posts[0]!.response.indexOf('{')),
    ) as DisputeEvidence;
    assert.ok(embedded.evidenceGaps.length > 0, 'the gaps are stated, not left blank');
    assert.deepEqual(posts[0]!.evidenceUrls, []);
  });
});

// ---------------------------------------------------------------------------
// Webhook routing (index.ts)
//
// The routing decision is the part that can silently be wrong: answering every
// status change would file a counter-statement on a healthy contract, and
// answering none would leave the platform's dispute unanswered. Neither is
// visible from inside `respond`, so it is asserted here.
// ---------------------------------------------------------------------------

const statusEvent = (payload: unknown): WebhookEvent =>
  ({ eventType: 'contract.status.changed', payload }) as unknown as WebhookEvent;

function routedHandlers(options: { throws?: string } = {}): {
  responded: string[];
  onContractStatusChanged: (event: WebhookEvent) => Promise<void>;
  onDisputeResponseSubmitted: (event: WebhookEvent) => Promise<void>;
} {
  const responded: string[] = [];
  const handlers = createDisputeHandlers({
    disputes: {
      respond: async (contractId: string) => {
        responded.push(contractId);
        if (options.throws) throw new Error(options.throws);
      },
    },
    logger: silentLogger,
  });
  return { responded, ...handlers };
}

describe('createDisputeHandlers', () => {
  it('responds when a contract enters the disputed status', async () => {
    const routed = routedHandlers();
    await routed.onContractStatusChanged(
      statusEvent({ contractId: CONTRACT, newStatus: 'disputed' }),
    );
    assert.deepEqual(routed.responded, [CONTRACT]);
  });

  it('leaves every other status change on the log-only path', async () => {
    const routed = routedHandlers();
    for (const newStatus of ['active', 'in-progress', 'completed', 'cancelled', undefined]) {
      await routed.onContractStatusChanged(statusEvent({ contractId: CONTRACT, newStatus }));
    }
    assert.deepEqual(routed.responded, [], 'a healthy contract must not be answered');
  });

  it('responds to a redelivered dispute.response_submitted unconditionally', async () => {
    const routed = routedHandlers();
    await routed.onDisputeResponseSubmitted(statusEvent({ contractId: CONTRACT }));
    assert.deepEqual(routed.responded, [CONTRACT]);
  });

  it('drops a payload that carries no contract id', async () => {
    const routed = routedHandlers();
    await routed.onContractStatusChanged(statusEvent({ newStatus: 'disputed' }));
    await routed.onDisputeResponseSubmitted(statusEvent({}));
    assert.deepEqual(routed.responded, []);
  });

  it('lets a failure reach the webhook app, so the platform redelivers', async () => {
    const routed = routedHandlers({ throws: 'mcp 503' });
    await assert.rejects(
      routed.onContractStatusChanged(statusEvent({ contractId: CONTRACT, newStatus: 'disputed' })),
      /mcp 503/,
    );
  });
});
