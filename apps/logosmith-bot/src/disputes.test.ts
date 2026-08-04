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
    assert.equal(gapMatching(evidence, /No cleared pre-generation/).length, 1);
    assert.equal(gapMatching(evidence, /could not be read back/).length, 0);
  });

  it('says a damaged screening verdict is damaged, not absent', async () => {
    // The store degrades an unparseable `detail_json` to null rather than
    // throwing, so a corrupt row reaches the document as `detail: null` with
    // its `result: 'clear'` intact. Reporting that as "no screening is on
    // record" would have this document contradicting the trail it prints.
    const { deps, db } = await seed({ withoutScreening: true });
    await db
      .prepare(
        'INSERT INTO gate_audit (job_key, contract_id, gate, result, detail_json, created_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        await buildJobKey(CONTRACT, 'concepts'),
        CONTRACT,
        'moderation',
        'clear',
        '{not json',
        NOW.toISOString(),
      )
      .run();

    const evidence = await assembleDisputeEvidence(deps, CONTRACT);
    const row = evidence.gateAudit.find((entry) => entry.gate === 'moderation');
    assert.equal(row?.result, 'clear', 'the trail still shows a cleared screening');
    assert.equal(row?.detail, null, 'whose stored body no longer parses');
    assert.equal(evidence.inputScreening.verdict, null);
    assert.equal(gapMatching(evidence, /could not be read back/).length, 1);
    assert.equal(gapMatching(evidence, /No cleared pre-generation/).length, 0);
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
// The generation seed — the strongest answer to "this is not what I asked for",
// because the image can be regenerated from it. It lives only in the gate audit
// detail (types.ts, `Concept.seed`), so it has to be joined back to the concept
// row it belongs to.
// ---------------------------------------------------------------------------

const OCR_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

/** An `ocr` audit detail shaped as pipeline.ts writes it. */
const ocrDetail = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: OCR_MODEL,
  transcription: 'Harbor & Vine',
  score: 0.97,
  pass: true,
  unsafe: false,
  checkedAt: '2026-07-30T12:00:00.000Z',
  vendorRequestId: 'ideogram-req-1',
  ...over,
});

/** The audit detail for the CONTROL concept (slot 3), which always reports its
 *  seed. Every test below asserts it, so a `seedForConcept` that returned null
 *  unconditionally — the shape these tests would decay into — fails all of
 *  them rather than passing five. */
const CONTROL_SEED = 313131;
const controlDetail = (): Record<string, unknown> =>
  ocrDetail({
    transcription: CONCEPTS[2]!.ocrTranscription,
    score: CONCEPTS[2]!.ocrScore,
    vendorRequestId: CONCEPTS[2]!.vendorRequestId,
    seed: CONTROL_SEED,
  });

/** Slot 1 under test plus an untouched slot-3 control, assembled. */
async function withTrail(
  rows: Array<{ slot?: number; gate?: string; detail: unknown }>,
  stored: ConceptUpsert = CONCEPTS[0]!,
): Promise<DisputeEvidence> {
  const db = createMemoryD1();
  await applyMigrations(db);
  const jobs = createJobStore(db, () => NOW);
  const concepts = createConceptStore(db, () => NOW);
  const selection = createSelectionStore(db, () => NOW);
  const conceptsKey = await buildJobKey(CONTRACT, 'concepts');
  await concepts.upsert(stored);
  await concepts.upsert(CONCEPTS[2]!);
  const all = [...rows, { slot: 3, detail: controlDetail() }];
  for (const row of all) {
    await jobs.recordGateAudit({
      jobKey: conceptsKey,
      contractId: CONTRACT,
      slot: row.slot ?? stored.slot,
      gate: row.gate ?? 'ocr',
      result: 'pass',
      detail: row.detail,
    });
  }
  return assembleDisputeEvidence(
    { jobs, concepts, selection, publicBaseUrl: BASE_URL, now: () => NOW },
    CONTRACT,
  );
}

/** The seed under test, and the control that proves the reader still works. */
function seeds(evidence: DisputeEvidence): { subject: number | null; control: number | null } {
  const find = (slot: number): number | null =>
    evidence.concepts.find((concept) => concept.slot === slot)?.seed ?? null;
  return { subject: find(1), control: find(3) };
}

describe('assembleDisputeEvidence — the generation seed', () => {
  it('reports the seed recorded alongside the verdict the concept row stores', async () => {
    // Precondition: the audit detail really does describe the stored row.
    assert.equal(CONCEPTS[0]!.ocrScore, 0.97);
    assert.equal(CONCEPTS[0]!.ocrTranscription, 'Harbor & Vine');
    assert.deepEqual(seeds(await withTrail([{ detail: ocrDetail({ seed: 424242 }) }])), {
      subject: 424242,
      control: CONTROL_SEED,
    });
  });

  it('reports the seed of the attempt that was KEPT, not the newest one', async () => {
    // The free taster keeps its BEST-scoring attempt rather than its last, so
    // "the newest ocr row for this slot" would name a seed the delivered image
    // was never generated from. Here the discarded attempt is the LATER row.
    const evidence = await withTrail([
      { detail: ocrDetail({ seed: 111111 }) },
      {
        detail: ocrDetail({
          seed: 999999,
          transcription: 'Harbcr & Vine',
          score: 0.42,
          pass: false,
          vendorRequestId: 'ideogram-req-1-b',
        }),
      },
    ]);
    assert.deepEqual(seeds(evidence), { subject: 111111, control: CONTROL_SEED });
  });

  it('tells two attempts apart by the vendor request id, the only field that differs', async () => {
    // The rest of the join key is one degree of freedom: the model is a pinned
    // constant and the score is a pure function of the transcription and the
    // brand name, so two attempts reading back identically — the NORMAL case —
    // are distinguished by nothing else.
    const evidence = await withTrail([
      { detail: ocrDetail({ seed: 999999, vendorRequestId: 'ideogram-req-1-b' }) },
      { detail: ocrDetail({ seed: 424242 }) },
    ]);
    assert.deepEqual(seeds(evidence), { subject: 424242, control: CONTROL_SEED });
  });

  it('reports no seed when the vendor returned none', async () => {
    const evidence = await withTrail([{ detail: ocrDetail() }]);
    assert.deepEqual(seeds(evidence), { subject: null, control: CONTROL_SEED });
    assert.equal(evidence.concepts[0]!.ocr?.score, 0.97, 'the verdict is still reported');
  });

  it('refuses to name a seed when two indistinguishable rows disagree', async () => {
    const evidence = await withTrail([
      { detail: ocrDetail({ seed: 111111 }) },
      { detail: ocrDetail({ seed: 222222 }) },
    ]);
    assert.deepEqual(
      seeds(evidence),
      { subject: null, control: CONTROL_SEED },
      'a maybe-wrong seed is worse than none',
    );
  });

  it('lets a silent row outvote a seeded one it cannot be told apart from', async () => {
    // THE C1 SHAPE, unit-sized: attempt 1 recorded a seed, the attempt whose
    // bytes were kept recorded none, and nothing distinguishes them. Skipping
    // the silent row would read as unanimous for an image we discarded.
    const evidence = await withTrail([
      { detail: ocrDetail({ seed: 111111 }) },
      { detail: ocrDetail() },
    ]);
    assert.deepEqual(seeds(evidence), { subject: null, control: CONTROL_SEED });
  });

  it('lets an unreadable row outvote a seeded one', async () => {
    // A readable row can be ruled out as another attempt's; an unreadable one
    // cannot, so it votes rather than being skipped.
    const evidence = await withTrail([
      { detail: ocrDetail({ seed: 111111 }) },
      { detail: undefined },
    ]);
    assert.deepEqual(seeds(evidence), { subject: null, control: CONTROL_SEED });
  });

  it('ignores a seed that is not a number', async () => {
    const evidence = await withTrail([{ detail: ocrDetail({ seed: '424242' }) }]);
    assert.deepEqual(seeds(evidence), { subject: null, control: CONTROL_SEED });
  });

  it("never attaches another slot's seed", async () => {
    const evidence = await withTrail([{ slot: 2, detail: ocrDetail({ seed: 424242 }) }]);
    assert.deepEqual(seeds(evidence), { subject: null, control: CONTROL_SEED });
  });

  it('ignores a seed on a row from a different gate', async () => {
    const evidence = await withTrail([{ gate: 'phash', detail: ocrDetail({ seed: 424242 }) }]);
    assert.deepEqual(seeds(evidence), { subject: null, control: CONTROL_SEED });
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
      // A `buyer` source rests on a reply a strict parser recognized outright,
      // so there is no reading to quote and this must be null. A quote beside a
      // `buyer` source would imply a model was consulted when none was.
      inference: null,
      m1DeliveredAt: NOW.toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // An INFERRED winner (Task 28). "You told us" and "we read your reply as
  // saying so" are different claims, and a payer disputing "I never chose that"
  // is owed the difference plus the words it was read out of.
  // -------------------------------------------------------------------------

  /**
   * Re-point the seeded contract at an inferred winner, optionally recording the
   * reading that produced it. Returns deps whose selection row and gate_audit
   * trail are BOTH on the seeded database, so the join under test is real.
   */
  async function seedInferred(
    options: { reading?: unknown; slot?: number; extraReading?: unknown } = {},
  ): Promise<{ deps: DisputeDeps }> {
    const { db, deps, conceptsKey } = await seed({ withoutSelection: true });
    const selection = createSelectionStore(db, () => NOW);
    const jobs = createJobStore(db, () => NOW);
    await selection.open(CONTRACT);
    await selection.select(CONTRACT, options.slot ?? 2, 'inferred');

    for (const detail of [options.reading, options.extraReading]) {
      if (detail === undefined) continue;
      await jobs.recordGateAudit({
        jobKey: conceptsKey,
        contractId: CONTRACT,
        slot: 2,
        gate: 'selection',
        result: 'inference-selected',
        detail,
      });
    }
    return { deps: { ...deps, selection } };
  }

  const READING = {
    messageId: 'msg-42',
    slot: 2,
    quote: 'concept 2 works for us',
    model: 'claude-haiku-4-5',
  };

  it('says the winner was inferred and quotes the words it was read out of', async () => {
    const { deps } = await seedInferred({ reading: READING });
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);

    assert.equal(evidence.selection?.selectionSource, 'inferred');
    assert.deepEqual(evidence.selection?.inference, {
      messageId: 'msg-42',
      quote: 'concept 2 works for us',
      model: 'claude-haiku-4-5',
      at: NOW.toISOString(),
    });
    assert.deepEqual(evidence.evidenceGaps, [], 'a complete reading is not a gap');
    // The covering note has to explain what `inferred` means, or the field is a
    // word the arbitrator has to guess at.
    assert.match(evidence.note, /`inferred` means it was NOT/);
    // ...and the raw row it was summarized from is published too, so the
    // summary and the record a reader checks it against cannot diverge.
    assert.ok(
      evidence.gateAudit.some((row) => row.result === 'inference-selected'),
      'the reading is in the trail as written',
    );
  });

  it('names a gap when an inferred winner’s reading cannot be recovered', async () => {
    const { deps } = await seedInferred();
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);

    assert.equal(evidence.selection?.selectionSource, 'inferred');
    assert.equal(evidence.selection?.inference, null);
    assert.equal(gapMatching(evidence, /chosen by INFERENCE/).length, 1);
    // It must not assert the reply never existed — only that this record
    // cannot show it.
    assert.match(evidence.evidenceGaps.join(' '), /does not assert that no such reply existed/);
  });

  it('refuses a reading recorded against a DIFFERENT slot than the winner', async () => {
    // A reading that lost a race to another writer must never be presented as
    // the reason for a winner it did not choose.
    const { deps } = await seedInferred({ slot: 1, reading: READING });
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);

    assert.equal(evidence.selection?.winnerSlot, 1);
    assert.equal(evidence.selection?.inference, null);
    assert.equal(gapMatching(evidence, /chosen by INFERENCE/).length, 1);
  });

  it('reports NOTHING when two recorded readings disagree', async () => {
    // Task 25's seed election, same rule: naming one of two disagreeing rows is
    // a guess, and a quote attributed to the wrong message is worse than none.
    const { deps } = await seedInferred({
      reading: READING,
      extraReading: { ...READING, messageId: 'msg-99', quote: 'lets go with 2' },
    });
    const evidence = await assembleDisputeEvidence(deps, CONTRACT);

    assert.equal(evidence.selection?.inference, null);
    assert.equal(gapMatching(evidence, /chosen by INFERENCE/).length, 1);
  });

  it('refuses a damaged reading rather than half-copying it', async () => {
    for (const detail of [
      null,
      'not an object',
      [READING],
      { ...READING, quote: 42 },
      { ...READING, messageId: undefined },
      { messageId: 'm', slot: 2, quote: 'q' },
    ]) {
      const { deps } = await seedInferred({ reading: detail });
      const evidence = await assembleDisputeEvidence(deps, CONTRACT);
      assert.equal(
        evidence.selection?.inference,
        null,
        `detail ${JSON.stringify(detail)} must not be copied into the document`,
      );
    }
  });

  it('never attaches a reading to a buyer or default selection', async () => {
    // The reading is recorded under the concepts key regardless; what must not
    // happen is a quote appearing beside a source that did not rest on one.
    for (const source of ['buyer', 'default'] as const) {
      const { db, deps, conceptsKey } = await seed({ withoutSelection: true });
      const selection = createSelectionStore(db, () => NOW);
      const jobs = createJobStore(db, () => NOW);
      await selection.open(CONTRACT);
      await selection.select(CONTRACT, 2, source);
      await jobs.recordGateAudit({
        jobKey: conceptsKey,
        contractId: CONTRACT,
        slot: 2,
        gate: 'selection',
        result: 'inference-selected',
        detail: READING,
      });

      const evidence = await assembleDisputeEvidence({ ...deps, selection }, CONTRACT);
      assert.equal(evidence.selection?.selectionSource, source);
      assert.equal(evidence.selection?.inference, null, `a ${source} winner rests on no reading`);
      assert.deepEqual(gapMatching(evidence, /chosen by INFERENCE/), []);
    }
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
