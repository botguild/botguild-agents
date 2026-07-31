import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-wasm';
import type { AgentClient } from '@botguild/agent-core';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import type { D1Like } from '@botguild/agent-core-workers';
import {
  BRIEF_OUTAGE_PARK_REASON,
  IMAGE_COST_USD,
  MAX_REGENS_PER_SLOT,
  MAX_SPEND_USD,
  MODERATION_ATTEMPTS_BEFORE_NOTICE,
  OCR_SIMILARITY_THRESHOLD,
  SCOUT_MODEL_ID,
} from './config.js';
import { assembleDisputeEvidence } from './disputes.js';
import type { GenerateResult, Generator } from './generate.js';
import { readPngDimensions, type OcrGate, type OcrOutcome } from './gates/index.js';
import {
  buildJobKey,
  createConceptStore,
  createJobStore,
  createQuotaStore,
  createSelectionStore,
  type ConceptStore,
  type JobStore,
  type SelectionStore,
} from './jobs.js';
import type { ModerationClient } from './moderation.js';
import { parseLogoBrief, type BriefResult } from './brief.js';
import type { ProseGig } from './proseBrief.js';
import { renderSvgToPng } from './pack/render.js';
import { ensureResvgReady } from './pack/wasm.js';
import { nodeWasmSources } from './pack/wasm.node.js';
import { applyMigrations } from './testSupport.js';
import {
  decideSlotAction,
  milestoneIdForStage,
  processJobMessage,
  runConceptStage,
  runVectorStage,
  type DeliverableStore,
  type PipelineConfig,
  type StageOutcome,
} from './pipeline.js';
import { REQUIRED_ZIP_ENTRIES, unzipFiles } from './pack/zip.js';
import type { ValidationReport, LicenseManifest } from './report.js';
import type { Vectorizer } from './vectorize.js';
import type { ConceptState, JobMessage, LogoBrief, SelectionSource, StyleAxis } from './types.js';

const axis: StyleAxis = { id: 'wordmark', label: 'w', prompt: 'p', vendor: 'ideogram' };
const state = (over: Partial<ConceptState> = {}): ConceptState => ({
  slot: 1,
  axis,
  status: 'pending',
  attempts: 0,
  ...over,
});

describe('decideSlotAction', () => {
  it('generates a fresh slot', () => {
    assert.deepEqual(decideSlotAction(state(), 0), { action: 'generate' });
  });

  it('regenerates a failed slot while regens remain (attempts = 1 + regens used)', () => {
    // attempts=1: initial generation done, 0 regens used → regen #1 allowed.
    assert.deepEqual(decideSlotAction(state({ status: 'failed', attempts: 1 }), 0), {
      action: 'regenerate',
    });
    // attempts=MAX: regen #MAX still allowed (that's the last one).
    assert.deepEqual(
      decideSlotAction(state({ status: 'failed', attempts: MAX_REGENS_PER_SLOT }), 0),
      { action: 'regenerate' },
    );
  });

  it('stops after the initial attempt plus MAX_REGENS_PER_SLOT regenerations', () => {
    const action = decideSlotAction(
      state({ status: 'failed', attempts: MAX_REGENS_PER_SLOT + 1 }),
      0,
    );
    assert.deepEqual(action, { action: 'stop', reason: 'attempts-exhausted' });
  });

  it('stops every slot once the job hits the spend cap', () => {
    assert.deepEqual(decideSlotAction(state(), MAX_SPEND_USD), {
      action: 'stop',
      reason: 'spend-cap',
    });
  });

  it('checks the spend cap before anything else', () => {
    // A resumed job at the cap must not spend another cent, whatever the slot state.
    assert.deepEqual(decideSlotAction(state({ status: 'passed' }), MAX_SPEND_USD + 1), {
      action: 'stop',
      reason: 'spend-cap',
    });
  });

  it('never regenerates a slot that already passed', () => {
    assert.deepEqual(decideSlotAction(state({ status: 'passed', attempts: 1 }), 0), {
      action: 'stop',
      reason: 'already-passed',
    });
  });
});

describe('milestoneIdForStage', () => {
  const contract = { milestones: [{ id: 'm1' }, { id: 'm2' }] } as Parameters<
    typeof milestoneIdForStage
  >[0];

  it('delivers stage 1 against the first checkpoint and stage 2 against the second', () => {
    assert.equal(milestoneIdForStage(contract, 'concepts'), 'm1');
    assert.equal(milestoneIdForStage(contract, 'vector'), 'm2');
  });

  it('falls back to the only checkpoint a single-milestone contract has', () => {
    const single = { milestones: [{ id: 'only' }] } as typeof contract;
    assert.equal(milestoneIdForStage(single, 'concepts'), 'only');
    assert.equal(milestoneIdForStage(single, 'vector'), 'only');
  });

  it('reports null when the contract exposes no milestone at all', () => {
    assert.equal(
      milestoneIdForStage({ milestones: [] } as unknown as typeof contract, 'concepts'),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// runConceptStage integration harness
//
// Real D1 (in-memory SQLite + the shipped migrations), real gates, real resvg;
// fakes only where a vendor would be: the image generator, the vision gate, the
// moderation vendor, and the platform client.
// ---------------------------------------------------------------------------

const logger = createConsoleLogger({ service: 'logosmith-test', level: 'silent' });
const sources = nodeWasmSources();

const CONTRACT_ID = 'contract-1';
const BRIEF: LogoBrief = { brandName: 'Harbor & Vine', industry: 'boutique inn' };
const GIG_DESCRIPTION = '```json\n' + JSON.stringify(BRIEF) + '\n```';

const AXES: StyleAxis[] = [
  { id: 'wordmark', label: 'lettering-forward wordmark', prompt: 'prompt-1', vendor: 'ideogram' },
  { id: 'lockup', label: 'icon + wordmark lockup', prompt: 'prompt-2', vendor: 'ideogram' },
  { id: 'emblem', label: 'emblem / monogram', prompt: 'prompt-3', vendor: 'recraft' },
];
/** The slot each axis lands in, so a test can talk in slots rather than indexes. */
const SLOT_OF: Record<string, number> = { wordmark: 1, lockup: 2, emblem: 3 };

const svgOf = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">` +
  `<rect width="256" height="256" fill="#ffffff"/>${inner}</svg>`;

// Broadband marks, not flat swatches: a DCT pHash's bit-vs-median comparison is
// only stable on images with real low-frequency energy (Task 4's ruling). These
// three measure 27-33 Hamming apart — comfortably over MIN_PHASH_HAMMING (10) —
// which is asserted below rather than assumed.
const MARK_SVGS: Record<string, string> = {
  leftHalf: svgOf('<rect width="128" height="256" fill="#000"/>'),
  topHalf: svgOf('<rect width="256" height="128" fill="#000"/>'),
  checker: svgOf(
    Array.from({ length: 64 }, (_, i) => {
      const x = (i % 8) * 32;
      const y = Math.floor(i / 8) * 32;
      return ((i % 8) + Math.floor(i / 8)) % 2 === 0
        ? `<rect x="${x}" y="${y}" width="32" height="32" fill="#000"/>`
        : '';
    }).join(''),
  ),
};

/** Rendered once for the whole file — resvg init is the expensive part. */
const MARKS: Record<string, Uint8Array> = {};

before(async () => {
  for (const [name, svg] of Object.entries(MARK_SVGS)) {
    MARKS[name] = await renderSvgToPng(svg, 256, sources);
  }
});

/** Which fixture a PNG is, by content — survives the R2 round-trip. */
function identify(png: Uint8Array): string {
  for (const [name, bytes] of Object.entries(MARKS)) {
    if (bytes.length === png.length && bytes.every((byte, i) => png[i] === byte)) return name;
  }
  return 'rasterized';
}

const verdict = (pass: boolean, transcription = BRIEF.brandName): OcrOutcome => ({
  status: 'ok',
  verdict: {
    model: SCOUT_MODEL_ID,
    transcription,
    score: pass ? 0.97 : 0.41,
    pass,
    unsafe: false,
    checkedAt: '2026-07-30T12:00:00.000Z',
  },
});

const okConcept = (
  axisId: string,
  png: Uint8Array,
  costUsd: number = IMAGE_COST_USD.ideogram,
  /** Vendor RNG seed. Ideogram returns one; Recraft and FLUX do not. */
  seed?: number,
): GenerateResult => ({
  ok: true,
  costUsd,
  concept: {
    axisId,
    vendor: AXES.find((a) => a.id === axisId)?.vendor ?? 'ideogram',
    vendorRequestId: `req-${axisId}`,
    png,
    seed,
  },
});

interface MemoryR2 extends DeliverableStore {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
  /** Set to a message to make every `put` throw — the vendor was paid, the
   *  storage write then failed, and the queue is about to retry the message. */
  failPut: string | null;
}

function memoryR2(): MemoryR2 {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const store: MemoryR2 = {
    objects,
    failPut: null,
    async put(key, value, contentType) {
      if (store.failPut) throw new Error(store.failPut);
      objects.set(key, { bytes: value, contentType });
    },
    async get(key) {
      return objects.get(key)?.bytes ?? null;
    },
  };
  return store;
}

interface Delivery {
  contractId: string;
  milestoneId: string;
  note: string;
  attachments: string[];
}

interface Harness {
  config: PipelineConfig;
  jobKey: string;
  token: string;
  db: D1Like;
  jobs: JobStore;
  concepts: ConceptStore;
  selection: SelectionStore;
  r2: MemoryR2;
  deliveries: Delivery[];
  messages: string[];
  /** Axis id per generator call, in call order. */
  generated: string[];
  /** Every URL the pipeline handed to `fetchImpl`, in call order. */
  fetches: string[];
  axisCompilations: () => number;
  /** Every gig handed to the prose-brief extractor, in call order. */
  extractorCalls: ProseGig[];
}

interface SetupOptions {
  /** `attempt` is 1-based per axis. */
  generate?: (axisId: string, attempt: number) => GenerateResult;
  /** `attempt` is 1-based per fixture. */
  ocr?: (fixture: string, attempt: number) => OcrOutcome;
  moderation?: ModerationClient;
  description?: string;
  /** Omitted ⇒ the REAL vectorizer, wired to the network-refusing fetchImpl. */
  vectorizer?: Vectorizer;
  /** What the prose-brief extractor returns. Default: a refusal. */
  extractedBrief?: BriefResult<LogoBrief>;
}

/**
 * The verdict stage 1 records and stage 2's report must reproduce verbatim.
 * `response` carries a real-shaped vendor body on purpose: it is the part that
 * would be silently lost if the report ever copied only the top-level flags, or
 * if it went back to pointing at D1 instead of quoting the verdict.
 */
const CLEAR_VERDICT = {
  vendor: 'openai',
  model: 'omni-moderation-2024-09-26',
  flagged: false,
  response: {
    id: 'modr-harness-1',
    model: 'omni-moderation-2024-09-26',
    results: [
      { flagged: false, categories: { hate: false }, category_scores: { hate: 0.0000021 } },
    ],
  },
  checkedAt: '2026-07-30T12:00:00.000Z',
};

const clearModeration: ModerationClient = {
  screen: async () => ({ status: 'clear', verdict: CLEAR_VERDICT }),
};

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const db = createMemoryD1();
  await applyMigrations(db);
  const jobs = createJobStore(db);
  const concepts = createConceptStore(db);
  const selection = createSelectionStore(db);
  const jobKey = await buildJobKey(CONTRACT_ID, 'concepts');
  await jobs.claim(jobKey, CONTRACT_ID, 'concepts');
  const token = (await jobs.get(jobKey))!.deliverableToken!;

  const generated: string[] = [];
  const perAxis = new Map<string, number>();
  const generatePlan =
    options.generate ??
    ((axisId: string): GenerateResult => okConcept(axisId, MARKS[axisFixture(axisId)]!));
  const generator: Generator = {
    async generate(styleAxis) {
      const attempt = (perAxis.get(styleAxis.id) ?? 0) + 1;
      perAxis.set(styleAxis.id, attempt);
      generated.push(styleAxis.id);
      return generatePlan(styleAxis.id, attempt);
    },
  };

  const perFixture = new Map<string, number>();
  const ocrPlan = options.ocr ?? ((): OcrOutcome => verdict(true));
  const ocrGate: OcrGate = {
    async check(png) {
      const fixture = identify(png);
      const attempt = (perFixture.get(fixture) ?? 0) + 1;
      perFixture.set(fixture, attempt);
      return ocrPlan(fixture, attempt);
    },
  };

  let axisCompilations = 0;
  const extractorCalls: ProseGig[] = [];

  const deliveries: Delivery[] = [];
  const messages: string[] = [];
  const client = {
    getContract: async (id: string) => ({
      id,
      gigId: 'gig-1',
      payerId: 'payer-1',
      milestones: [{ id: 'm1' }, { id: 'm2' }],
    }),
    getGig: async () => ({
      id: 'gig-1',
      description: options.description ?? GIG_DESCRIPTION,
    }),
    deliverMilestone: async (
      contractId: string,
      milestoneId: string,
      payload: { note: string; attachments?: string[] },
    ) => {
      deliveries.push({
        contractId,
        milestoneId,
        note: payload.note,
        attachments: payload.attachments ?? [],
      });
    },
    sendMessage: async (_contractId: string, content: string) => {
      messages.push(content);
    },
  } as unknown as AgentClient;

  const r2 = memoryR2();
  const fetches: string[] = [];
  const config: PipelineConfig = {
    jobs,
    concepts,
    selection,
    quota: createQuotaStore(db),
    client,
    ai: { run: async () => ({}) },
    deliverables: r2,
    sources,
    secrets: {
      moderationApiKey: 'test',
      anthropicApiKey: 'test',
      ideogramApiKey: 'test',
      recraftApiKey: 'test',
      vectorizerToken: 'test',
      googleFontsApiKey: 'test',
    },
    // Records the URL before refusing, so a test can prove which vendors were
    // NOT called — and, just as importantly, that the recorder itself works.
    fetchImpl: async (url) => {
      fetches.push(url);
      throw new Error('no test may reach the network');
    },
    publicBaseUrl: 'https://logosmith.example.com',
    logger,
    services: {
      generator,
      ocrGate,
      moderation: options.moderation ?? clearModeration,
      axisCompiler: {
        compile: async () => {
          axisCompilations += 1;
          return AXES.map((a) => ({ ...a }));
        },
      },
      // Deliberately left undefined unless a test asks for a fake: the real
      // vectorizer then runs against the refusing fetchImpl above, so a
      // Recraft-native short-circuit that failed to fire is a hard failure
      // rather than a silently-mocked pass.
      ...(options.vectorizer ? { vectorizer: options.vectorizer } : {}),
      // ALWAYS wired, unlike `vectorizer` directly above — and the asymmetry is
      // load-bearing. The real extractor builds an `@anthropic-ai/sdk` client,
      // which issues its requests through the GLOBAL `fetch` and is therefore
      // NOT stopped by the network-refusing `fetchImpl` above. Left undefined,
      // every brief-resolution test would make a live HTTPS call and then pass
      // off whatever error came back — green for a reason that has nothing to
      // do with what it claims to test.
      briefExtractor: {
        async extract(gig: ProseGig): Promise<BriefResult<LogoBrief>> {
          extractorCalls.push(gig);
          return options.extractedBrief ?? { ok: false, reason: 'this gig names no brand' };
        },
      },
    },
  };

  return {
    config,
    jobKey,
    token,
    db,
    jobs,
    concepts,
    selection,
    r2,
    deliveries,
    messages,
    generated,
    fetches,
    axisCompilations: () => axisCompilations,
    extractorCalls,
  };
}

const message = (jobKey: string) => ({
  contractId: CONTRACT_ID,
  jobKey,
  stage: 'concepts' as const,
});

const seededSlot = (slot: number, over: Partial<ConceptState> = {}): ConceptState => ({
  slot,
  axis: AXES[slot - 1]!,
  status: 'pending',
  attempts: 0,
  ...over,
});

describe('runConceptStage — the §9 contractual outcomes', () => {
  it('delivers three concepts that pass first time', async () => {
    const h = await setup();
    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'delivered' });
    assert.equal(h.generated.length, 3, 'one generation per slot');

    const rows = await h.concepts.list(CONTRACT_ID);
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.r2Key, `${h.token}/concept-${row.slot}.png`);
      assert.ok(row.phash, 'every concept carries a perceptual hash');
      assert.equal(row.ocrPass, true);
      assert.equal(row.attemptsUsed, 1);
      assert.equal(row.vendorRequestId, `req-${AXES[row.slot - 1]!.id}`);
      assert.ok(h.r2.objects.has(row.r2Key!), 'the bytes are in R2, not just the row');
      assert.equal(h.r2.objects.get(row.r2Key!)!.contentType, 'image/png');
    }

    assert.equal((await h.selection.get(CONTRACT_ID))?.state, 'concepts_delivered');
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.deliveries[0]!.milestoneId, 'm1');
    assert.match(h.deliveries[0]!.note, /concept 1\|2\|3/);
    assert.match(h.deliveries[0]!.note, /Harbor & Vine/);
    assert.deepEqual(h.deliveries[0]!.attachments, [
      `https://logosmith.example.com/deliverables/${h.token}/concept-1.png`,
      `https://logosmith.example.com/deliverables/${h.token}/concept-2.png`,
      `https://logosmith.example.com/deliverables/${h.token}/concept-3.png`,
      `https://logosmith.example.com/p/${h.token}`,
    ]);

    const job = await h.jobs.get(h.jobKey);
    assert.equal(job?.status, 'delivered');
    assert.equal(job?.outcome, 'delivered');
    assert.equal(job?.checkpoint?.spendUsd, 3 * IMAGE_COST_USD.ideogram);
  });

  // The seed is what makes a disputed concept REGENERATABLE, and the gate audit
  // detail is the only place it is persisted (types.ts, `Concept.seed`). This
  // asserts the whole path in one run: the vendor returns it, stage 1 writes it
  // to D1, and the dispute response reads it back onto the right slot. Mixed on
  // purpose — Ideogram issues a seed, Recraft (slot 3) does not — so a null
  // reads as the vendor's silence, never as a lost value.
  it('records the generation seed in the audit trail, where the dispute response reads it', async () => {
    const SEEDS: Record<string, number> = { wordmark: 424242, lockup: 777001 };
    assert.equal(AXES[2]!.vendor, 'recraft', 'slot 3 is the vendor that returns no seed');
    assert.equal(SEEDS.emblem, undefined);

    const h = await setup({
      generate: (axisId) =>
        okConcept(axisId, MARKS[axisFixture(axisId)]!, IMAGE_COST_USD.ideogram, SEEDS[axisId]),
    });
    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'delivered' });

    // 1. It reached the audit detail, alongside the verdict it belongs to.
    const ocrRows = await h.jobs.listGateAudit(h.jobKey, 'ocr');
    assert.equal(ocrRows.length, 3, 'one readback row per slot');
    assert.deepEqual(
      ocrRows.map((row) => [row.slot, (row.detail as { seed?: number }).seed ?? null]),
      [
        [1, 424242],
        [2, 777001],
        [3, null],
      ],
    );

    // 2. And it surfaces in the dispute response, matched to the right slot.
    const evidence = await assembleDisputeEvidence(
      {
        jobs: h.jobs,
        concepts: h.concepts,
        selection: h.selection,
        publicBaseUrl: 'https://logosmith.example.com',
      },
      CONTRACT_ID,
    );
    assert.deepEqual(
      evidence.concepts.map((concept) => [concept.slot, concept.seed]),
      [
        [1, 424242],
        [2, 777001],
        [3, null],
      ],
    );
  });

  // REGRESSION (C1). A regenerated slot leaves one audit row per attempt, and
  // Ideogram's seed is optional per response (generate.ts) — so a slot can hold
  // attempt 3's bytes while attempt 1's row is the only one carrying a seed.
  // Naming that seed would tell the payer to regenerate an image we DISCARDED,
  // falsifying the document's own strongest claim on their first check. Every
  // row that could be this image's must vote, including the silent ones.
  it('names no seed when a regenerated slot leaves attempts that cannot be told apart', async () => {
    const h = await setup({
      // Ideogram answers with a seed on the wordmark's attempt 1 and omits it
      // afterwards. The lockup slot passes first time and keeps its seed —
      // the positive control, so a `seedForConcept` husk cannot pass this test.
      generate: (axisId, attempt) =>
        okConcept(
          axisId,
          MARKS[axisFixture(axisId)]!,
          IMAGE_COST_USD.ideogram,
          axisId === 'lockup'
            ? 222222
            : axisId === 'wordmark' && attempt === 1
              ? 111111
              : undefined,
        ),
      // The wordmark slot never reads back, so it regenerates to exhaustion and
      // R2 ends up holding attempt 3's bytes.
      ocr: (fixture) => verdict(fixture !== 'leftHalf'),
    });
    assert.equal(axisFixture('wordmark'), 'leftHalf', 'slot 1 is the exhausted slot');
    const result = await runConceptStage(h.config, message(h.jobKey));
    assert.deepEqual(result, { outcome: 'partial' }, 'two of three concepts delivered');

    // The fixture really is the reported scenario: three attempts on slot 1,
    // exactly one of which recorded a seed, and all three indistinguishable
    // (same pinned model, same transcription, same score, same request id).
    const slotOne = (await h.jobs.listGateAudit(h.jobKey, 'ocr')).filter((row) => row.slot === 1);
    assert.equal(slotOne.length, MAX_REGENS_PER_SLOT + 1);
    assert.deepEqual(
      slotOne.map((row) => (row.detail as { seed?: number }).seed ?? null),
      [111111, null, null],
    );
    assert.equal(
      new Set(
        slotOne.map((row) => {
          const d = row.detail as Record<string, unknown>;
          return JSON.stringify([d.model, d.transcription, d.score, d.pass, d.vendorRequestId]);
        }),
      ).size,
      1,
      'nothing recorded distinguishes the three attempts',
    );
    assert.equal((await h.concepts.list(CONTRACT_ID)).find((r) => r.slot === 1)?.attemptsUsed, 3);

    const evidence = await assembleDisputeEvidence(
      {
        jobs: h.jobs,
        concepts: h.concepts,
        selection: h.selection,
        publicBaseUrl: 'https://logosmith.example.com',
      },
      CONTRACT_ID,
    );
    const slot1 = evidence.concepts.find((concept) => concept.slot === 1);
    assert.equal(slot1?.seed, null, 'a seed for a discarded attempt must never be named');
    assert.equal(slot1?.ocr?.pass, false, 'the failed verdict is still reported in full');
    // Positive control in the SAME test: the slot that was NOT regenerated
    // still reports its seed, so a `seedForConcept` husk cannot pass this.
    assert.equal(evidence.concepts.find((concept) => concept.slot === 2)?.seed, 222222);
  });

  it('regenerates a failing slot twice, then delivers — attempts and spend both counted', async () => {
    const h = await setup({
      // The emblem slot's readback fails twice before it lands.
      ocr: (fixture, attempt) => verdict(!(fixture === 'checker' && attempt <= 2)),
    });
    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'delivered' });
    assert.equal(h.generated.filter((id) => id === 'emblem').length, 3);
    assert.equal(h.generated.length, 5, '1 + 1 + 3 generations across the three slots');

    const rows = await h.concepts.list(CONTRACT_ID);
    assert.equal(rows.find((row) => row.slot === 3)!.attemptsUsed, 3);

    const job = await h.jobs.get(h.jobKey);
    assert.equal(job?.checkpoint?.slots[2]?.attempts, 3, 'initial generation + both regenerations');
    // Every generation is paid for, pass or fail: 5 images, not 3.
    assert.equal(job?.checkpoint?.spendUsd, 5 * IMAGE_COST_USD.ideogram);
    assert.equal(job?.spentUsd, 5 * IMAGE_COST_USD.ideogram);
  });

  it('delivers two concepts with the shortfall itemized when the spend cap bites', async () => {
    const h = await setup({
      // Fake per-image cost, NOT IMAGE_COST_USD — chosen only so 3 generations
      // exercise the cap (see the comment below for the inequality it satisfies).
      generate: (axisId) => okConcept(axisId, MARKS[axisFixture(axisId)]!, 0.25),
      ocr: (fixture) => verdict(fixture !== 'checker'),
    });
    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'partial' });
    // Slots 1 and 2 pass at $0.25 each (spend 0.50 < $0.6 cap); slot 3 is
    // allowed one attempt at $0.75 (>= the $0.6 cap: 2x0.25 < 0.6 <= 3x0.25),
    // and the cap then stops every further regeneration.
    assert.equal(h.generated.length, 3);
    assert.equal((await h.jobs.get(h.jobKey))?.checkpoint?.spendUsd, 0.75);

    assert.equal(h.deliveries.length, 1);
    const note = h.deliveries[0]!.note;
    assert.match(note, /SHORTFALL — 2 of 3 concepts delivered/);
    assert.match(note, /Concept 3 \(emblem \/ monogram\)/);
    assert.match(note, /image-generation cap/);
    assert.match(note, /reply in this thread with `concept 1\|2`/);

    const job = await h.jobs.get(h.jobKey);
    assert.equal(job?.status, 'delivered');
    assert.equal(job?.outcome, 'partial');
  });

  it('screens EVERY free-text field of the brief, not an enumeration of some of them', async () => {
    // `palettePreference` was the one `moderationText` forgot, and it is not a
    // benign field: `buildAxisPrompt` interpolates it verbatim into the image
    // prompt sent to Ideogram/Recraft under our API keys, and `axes.ts`
    // JSON.stringify's the WHOLE brief into the axis compiler's user message —
    // so it was both an unscreened vendor input and an unmoderated
    // prompt-injection channel into the module that writes our image prompts.
    // Meanwhile the refusal copy told the buyer every brief is screened.
    const screened: string[] = [];
    const h = await setup({
      description:
        '```json\n' +
        JSON.stringify({
          brandName: 'Harbor & Vine',
          industry: 'boutique inn',
          brief: 'FIELD-BRIEF',
          palettePreference: ['FIELD-PALETTE-A', 'FIELD-PALETTE-B'],
          avoid: ['FIELD-AVOID'],
          script: 'FIELD-SCRIPT',
        }) +
        '\n```',
      moderation: {
        screen: async (text: string) => {
          screened.push(text);
          return { status: 'clear' as const, verdict: CLEAR_VERDICT };
        },
      },
    });
    await runConceptStage(h.config, message(h.jobKey));

    assert.equal(screened.length, 1);
    // Each sentinel named individually — deriving them from the brief would
    // pass however few of them the screen actually saw.
    for (const sentinel of [
      'Harbor & Vine',
      'boutique inn',
      'FIELD-BRIEF',
      'FIELD-PALETTE-A',
      'FIELD-PALETTE-B',
      'FIELD-AVOID',
      'FIELD-SCRIPT',
    ]) {
      assert.ok(screened[0]!.includes(sentinel), `${sentinel} never reached the moderation vendor`);
    }
  });

  it('parks fail-closed when the moderation vendor is unavailable', async () => {
    const h = await setup({
      moderation: { screen: async () => ({ status: 'unavailable', error: 'vendor 503' }) },
    });
    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'parked' });
    const job = await h.jobs.get(h.jobKey);
    assert.equal(job?.status, 'parked');
    assert.equal(job?.parkReason, 'moderation_outage');
    assert.equal(job?.moderationAttempts, 1);
    assert.equal(h.deliveries.length, 0, 'nothing is delivered on an unscreened brief');
    assert.equal(h.generated.length, 0, 'and nothing is generated either');
    assert.equal(h.messages.length, 0, 'the buyer is not pinged on the first outage');
  });

  it('tells the buyer once, after MODERATION_ATTEMPTS_BEFORE_NOTICE failed screenings', async () => {
    const h = await setup({
      moderation: { screen: async () => ({ status: 'unavailable', error: 'vendor 503' }) },
    });
    for (let i = 0; i < MODERATION_ATTEMPTS_BEFORE_NOTICE + 2; i++) {
      await runConceptStage(h.config, message(h.jobKey));
    }
    assert.equal(h.messages.length, 1, 'exactly one notice, not one per cron cycle');
    assert.match(h.messages[0]!, /content-safety/);
  });

  it('rejects a flagged brief without generating anything', async () => {
    const h = await setup({
      moderation: {
        screen: async () => ({
          status: 'flagged',
          verdict: {
            vendor: 'openai',
            model: 'omni-moderation-2024-09-26',
            flagged: true,
            response: {},
            checkedAt: '2026-07-30T12:00:00.000Z',
          },
        }),
      },
    });
    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'aborted' });
    assert.equal((await h.jobs.get(h.jobKey))?.outcome, 'rejected');
    assert.equal(h.generated.length, 0);
    assert.equal(h.deliveries.length, 0);
    assert.match(h.messages[0]!, /content-safety/);
  });

  it('rejects an unparseable brief before spending anything', async () => {
    // No fenced block AND the extractor finds no brand (the harness default) —
    // both rungs of `resolveBrief` have to miss for this to be a rejection.
    const h = await setup({ description: 'no fenced json here' });
    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'aborted' });
    assert.equal((await h.jobs.get(h.jobKey))?.outcome, 'rejected');
    assert.equal(h.extractorCalls.length, 1, 'the prose fallback was tried before giving up');
    assert.equal(h.generated.length, 0);
    assert.equal(h.deliveries.length, 0);
    assert.match(h.messages[0]!, /did not validate/);
  });

  it('aborts and requests cancellation when fewer than two concepts converge', async () => {
    const h = await setup({ ocr: () => verdict(false) });
    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'aborted' });
    // 1 initial + MAX_REGENS_PER_SLOT regenerations, per slot, and no more.
    assert.equal(h.generated.length, 3 * (MAX_REGENS_PER_SLOT + 1));
    assert.equal(h.deliveries.length, 0, 'nothing is delivered');
    assert.equal(await h.selection.get(CONTRACT_ID), null, 'no selection is opened');
    assert.match(h.messages[0]!, /cannot cancel or refund a contract itself/);
    assert.match(h.messages[0]!, /please cancel this contract from your side/);
    assert.equal((await h.jobs.get(h.jobKey))?.outcome, 'aborted');
  });
});

describe('runConceptStage — brief resolution inside the funded pipeline (Task 27)', () => {
  // Measured live: 0 of 78 open gigs carried a fenced block. Before this, the
  // pipeline rejected — AFTER funding — the very gigs `maybePropose` had just
  // bid on off the strength of the same extraction.
  const PROSE = 'We need a logo for Harbor & Vine, our new seaside inn. Warm, understated.';
  assert.equal(parseLogoBrief(PROSE).ok, false, 'precondition: the prose carries no fenced brief');

  const STORED: LogoBrief = { brandName: 'Corrected Name', industry: 'corrected industry' };
  const EXTRACTED: LogoBrief = { brandName: 'Extracted Name', industry: 'extracted industry' };

  /** A moderation double that records every text it screened. */
  function recordingModeration(): { client: ModerationClient; screened: string[] } {
    const screened: string[] = [];
    return {
      screened,
      client: {
        async screen(text: string) {
          screened.push(text);
          return { status: 'clear' as const, verdict: CLEAR_VERDICT };
        },
      },
    };
  }

  it('runs a prose gig to delivery instead of rejecting it after funding', async () => {
    const h = await setup({ description: PROSE, extractedBrief: { ok: true, brief: BRIEF } });
    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'delivered' });
    assert.equal(h.extractorCalls.length, 1);
    assert.equal(h.deliveries.length, 1);
    assert.equal(
      (await h.jobs.get(h.jobKey))?.briefJson,
      JSON.stringify(BRIEF),
      'the extracted brief becomes the stored brief of record',
    );
  });

  it('PARKS on a brief-extraction outage instead of terminally rejecting a funded contract', async () => {
    // `markDelivered('rejected')` removes a job from the parked sweep's reach
    // for good, so collapsing an outage into "no brief" meant our vendor's bad
    // minute permanently killed a paid job. The moderation path two steps away
    // already parks; this now uses the same shape.
    const h = await setup({
      description: PROSE,
      extractedBrief: {
        ok: false,
        unavailable: true,
        reason:
          'the service LogoSmith uses to read a brief out of prose is temporarily unavailable',
      },
    });

    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'parked' });
    const job = await h.jobs.get(h.jobKey);
    assert.equal(job?.status, 'parked');
    assert.equal(job?.parkReason, BRIEF_OUTAGE_PARK_REASON);
    assert.notEqual(job?.outcome, 'rejected');
    assert.equal(h.generated.length, 0, 'nothing generated on an unread brief');
    assert.equal(h.messages.length, 0, 'the buyer is not pinged on the first outage');

    // ...and the cron can actually reach it again, which is the whole point.
    await h.jobs.unpark(h.jobKey);
    assert.equal((await h.jobs.get(h.jobKey))?.status, 'claimed');
  });

  it('tells the buyer once, and never republishes the vendor error', async () => {
    const h = await setup({
      description: PROSE,
      extractedBrief: {
        ok: false,
        unavailable: true,
        reason:
          'the service LogoSmith uses to read a brief out of prose is temporarily unavailable',
      },
    });
    for (let i = 0; i < MODERATION_ATTEMPTS_BEFORE_NOTICE + 2; i++) {
      await runConceptStage(h.config, message(h.jobKey));
      await h.jobs.unpark(h.jobKey);
    }
    assert.equal(h.messages.length, 1, 'exactly one notice, not one per cron cycle');
    assert.match(h.messages[0]!, /retries automatically/);
    assert.match(h.messages[0]!, /nothing has been generated or charged/);
  });

  it('still REJECTS a brief that is simply wrong — the two must not look alike', async () => {
    // The distinction is the decision: an outage parks and retries, an
    // unusable brief tells the buyer to fix their gig and closes the job.
    const h = await setup({
      description: PROSE,
      extractedBrief: { ok: false, reason: 'this gig does not clearly name a brand' },
    });
    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'aborted' });
    assert.equal((await h.jobs.get(h.jobKey))?.outcome, 'rejected');
  });

  it('hands the extractor the whole gig, not just its description', async () => {
    const h = await setup({ description: PROSE, extractedBrief: { ok: true, brief: BRIEF } });
    await runConceptStage(h.config, message(h.jobKey));

    assert.equal(h.extractorCalls.length, 1);
    assert.equal(h.extractorCalls[0]!.description, PROSE);
  });

  it('never pays for extraction when the gig carries a fenced brief', async () => {
    // The harness default description IS a fenced block.
    assert.equal(parseLogoBrief(GIG_DESCRIPTION).ok, true, 'precondition: fenced path resolves');
    const h = await setup({});
    await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(h.extractorCalls, [], 'rung 2 resolved; rung 3 must never run');
  });

  it('lets a stored brief_json beat a fresh extraction', async () => {
    const moderation = recordingModeration();
    const h = await setup({
      description: PROSE,
      moderation: moderation.client,
      extractedBrief: { ok: true, brief: EXTRACTED },
    });
    // The thread sweep's correction, as it lands in D1.
    await h.jobs.setInProgress(h.jobKey, {
      kind: 'logo',
      gigId: 'gig-1',
      payerId: 'payer-1',
      briefJson: JSON.stringify(STORED),
    });

    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'delivered' });
    assert.deepEqual(
      h.extractorCalls,
      [],
      'the buyer already restated the brief; never ask a model about it',
    );
    assert.ok(
      moderation.screened[0]!.includes(STORED.brandName),
      'the stored correction is the brief that was actually used',
    );
    assert.ok(!moderation.screened[0]!.includes(EXTRACTED.brandName));
  });

  it('re-validates a stored brief_json through the same parser rather than trusting it', async () => {
    // A stored brief that would NOT survive intake. It must not ride through on
    // the strength of being stored — the re-fence puts it back through
    // `parseLogoBrief`, it fails the v1 Latin-script rule, and resolution falls
    // on to the gig. This is the property that stops a thread "correction" from
    // being a bypass.
    const smuggled: LogoBrief = { brandName: '海港与藤', industry: 'inn' };
    assert.equal(
      parseLogoBrief('```json\n' + JSON.stringify(smuggled) + '\n```').ok,
      false,
      'precondition: this brief cannot pass intake',
    );

    const moderation = recordingModeration();
    const h = await setup({
      description: PROSE,
      moderation: moderation.client,
      extractedBrief: { ok: true, brief: EXTRACTED },
    });
    await h.jobs.setInProgress(h.jobKey, {
      kind: 'logo',
      gigId: 'gig-1',
      payerId: 'payer-1',
      briefJson: JSON.stringify(smuggled),
    });

    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'delivered' });
    assert.equal(h.extractorCalls.length, 1, 'the invalid stored brief did not win');
    assert.ok(
      moderation.screened[0]!.includes(EXTRACTED.brandName),
      'resolution fell through to the gig',
    );
    assert.ok(!moderation.screened[0]!.includes(smuggled.brandName), 'the smuggled name is gone');
  });

  it('re-screens the resolved brief through moderation whichever rung produced it', async () => {
    const moderation = recordingModeration();
    const h = await setup({
      description: PROSE,
      moderation: moderation.client,
      extractedBrief: { ok: true, brief: EXTRACTED },
    });
    await runConceptStage(h.config, message(h.jobKey));

    assert.equal(moderation.screened.length, 1, 'moderation ran');
    assert.ok(
      moderation.screened[0]!.includes(EXTRACTED.brandName),
      'an extracted brand is buyer-supplied free text and is screened like any other',
    );
    assert.ok(moderation.screened[0]!.includes(EXTRACTED.industry));
  });

  it('tells the buyer what a brief needs without demanding JSON of them', async () => {
    const h = await setup({ description: PROSE });
    await runConceptStage(h.config, message(h.jobKey));

    const note = h.messages[0]!;
    assert.doesNotMatch(
      note,
      /brief must be a fenced JSON block/,
      'prose is accepted now; do not ask the buyer for something we no longer require',
    );
    assert.match(note, /Plain prose is fine/);
    assert.match(note, /brand name/i);
    assert.match(note, /Latin/);
  });
});

describe('runConceptStage — caps are enforced from the persisted checkpoint', () => {
  it('spends the last allowed regeneration when attempts sit exactly at the cap', async () => {
    const h = await setup({ ocr: () => verdict(true) });
    await h.jobs.saveCheckpoint(h.jobKey, {
      spendUsd: 0,
      slots: [
        seededSlot(1, { status: 'failed', attempts: MAX_REGENS_PER_SLOT }),
        seededSlot(2, { status: 'passed', attempts: 1, phash: '0000000000000000' }),
        seededSlot(3, { status: 'passed', attempts: 1, phash: 'ffffffffffff0000' }),
      ],
    });

    const result = await runConceptStage(h.config, message(h.jobKey));
    assert.deepEqual(result, { outcome: 'delivered' });
    assert.deepEqual(h.generated, ['wordmark'], 'exactly the one regeneration still owed');
    assert.equal((await h.jobs.get(h.jobKey))?.checkpoint?.slots[0]?.attempts, 3);
  });

  it('spends nothing more once a slot is one attempt past the cap', async () => {
    const h = await setup();
    await h.jobs.saveCheckpoint(h.jobKey, {
      spendUsd: 0.42,
      slots: [
        seededSlot(1, { status: 'failed', attempts: MAX_REGENS_PER_SLOT + 1 }),
        seededSlot(2, { status: 'failed', attempts: MAX_REGENS_PER_SLOT + 1 }),
        seededSlot(3, { status: 'failed', attempts: MAX_REGENS_PER_SLOT + 1 }),
      ],
    });

    const result = await runConceptStage(h.config, message(h.jobKey));
    assert.deepEqual(result, { outcome: 'aborted' });
    assert.equal(h.generated.length, 0, 'a burned slot stays burned across redelivery');
    assert.equal(h.axisCompilations(), 0, 'and a resumed job never re-compiles its axes');
    assert.equal((await h.jobs.get(h.jobKey))?.checkpoint?.spendUsd, 0.42);
  });

  it('delivers the paid work already in the checkpoint without regenerating it', async () => {
    const h = await setup();
    await h.jobs.saveCheckpoint(h.jobKey, {
      // Under the $0.6 cap (not AT it) so slot 3's shortfall below is
      // attributed to attempts-exhausted, not spend-cap — that distinction is
      // the point of this test.
      spendUsd: 0.4,
      slots: [
        seededSlot(1, { status: 'passed', attempts: 1, phash: '0000000000000000' }),
        seededSlot(2, { status: 'passed', attempts: 1, phash: 'ffffffffffff0000' }),
        seededSlot(3, { status: 'failed', attempts: MAX_REGENS_PER_SLOT + 1 }),
      ],
    });

    const result = await runConceptStage(h.config, message(h.jobKey));
    assert.deepEqual(result, { outcome: 'partial' });
    assert.equal(h.generated.length, 0);
    assert.equal(h.deliveries.length, 1);
    assert.match(
      h.deliveries[0]!.note,
      /generation attempts \(1 initial \+ up to 2 regenerations\)/,
    );
  });

  it('stops every slot the moment the persisted spend is at the cap', async () => {
    const h = await setup();
    await h.jobs.saveCheckpoint(h.jobKey, {
      spendUsd: MAX_SPEND_USD,
      slots: [seededSlot(1), seededSlot(2), seededSlot(3)],
    });

    const result = await runConceptStage(h.config, message(h.jobKey));
    assert.deepEqual(result, { outcome: 'aborted' });
    assert.equal(h.generated.length, 0, 'a resumed job at the cap must not spend another cent');
  });

  it('treats a redelivered message for an already-delivered stage as a no-op', async () => {
    const h = await setup();
    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'delivered' });
    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'delivered' });
    assert.equal(h.generated.length, 3, 'the second delivery generates nothing');
    assert.equal(h.deliveries.length, 1, 'and delivers nothing');
  });
});

describe('runConceptStage — vendor and gate outages park rather than burn', () => {
  it('parks on a retryable vendor failure without consuming an attempt or a cent', async () => {
    const h = await setup({
      generate: () => ({ ok: false, retryable: true, error: 'ideogram returned 503' }),
    });
    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'parked' });
    const job = await h.jobs.get(h.jobKey);
    assert.equal(job?.status, 'parked');
    assert.equal(job?.parkReason, 'vendor_outage');
    // A 503 produced no image and cost nothing, so the slot has still never
    // generated: burning an FR-5 attempt here would let a 45-minute vendor
    // outage kill a job through the very cron loop meant to recover it.
    assert.equal(job?.checkpoint?.slots[0]?.attempts, 0);
    assert.equal(job?.checkpoint?.spendUsd, 0);
    assert.equal(h.deliveries.length, 0);
  });

  it('credits a PAID vendor failure to the ledger BEFORE it parks', async () => {
    // The park loop's only bound. A retryable failure consumes no FR-5 attempt
    // (Task 18 Ruling 1), so `attempts` stays 0 forever — and a failure that
    // happened after the vendor billed us (a dead asset CDN link, an asset
    // that is not a PNG) spends real money on every one of the cron's
    // fifteen-minute re-enqueues. If that spend is not persisted here,
    // `decideSlotAction`'s `spendUsd >= MAX_SPEND_USD` and `sweepParkedJobs`'
    // spend bound are BOTH looking at $0.00 while the vendor bill climbs.
    const h = await setup({
      generate: () => ({
        ok: false,
        retryable: true,
        error: 'asset fetch returned 404',
        costUsd: IMAGE_COST_USD.ideogram,
      }),
    });
    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'parked' });

    const job = await h.jobs.get(h.jobKey);
    assert.equal(job?.status, 'parked');
    assert.equal(job?.parkReason, 'vendor_outage');
    // Still no attempt consumed — that ruling is unchanged and is exactly why
    // the ledger has to carry the weight.
    assert.equal(job?.checkpoint?.slots[0]?.attempts, 0);
    // ...and the dollars ARE recorded, on the persisted row the sweep reads.
    assert.equal(job?.checkpoint?.spendUsd, IMAGE_COST_USD.ideogram);
    assert.equal(job?.spentUsd, IMAGE_COST_USD.ideogram);

    // Each cron cycle adds one more billed image, so the ledger climbs rather
    // than sitting at zero: this is the accumulation the spend bound needs.
    await h.jobs.unpark(h.jobKey);
    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'parked' });
    assert.equal((await h.jobs.get(h.jobKey))?.spentUsd, IMAGE_COST_USD.ideogram * 2);
  });

  it('exhausts a slot immediately when the vendor refuses the request outright', async () => {
    const h = await setup({
      generate: (axisId) =>
        axisId === 'emblem'
          ? { ok: false, retryable: false, error: 'recraft returned 400' }
          : okConcept(axisId, MARKS[axisFixture(axisId)]!),
    });
    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'partial' });
    assert.equal(
      h.generated.filter((id) => id === 'emblem').length,
      1,
      'the same prompt draws the same 4xx — do not pay to be refused twice',
    );
    assert.equal((await h.jobs.get(h.jobKey))?.checkpoint?.slots[2]?.attempts, 3);
  });

  it('parks on an OCR outage and re-gates the already-paid bytes on resume', async () => {
    let vision = false;
    const h = await setup({
      ocr: () =>
        vision
          ? verdict(true)
          : { status: 'unavailable', error: 'vision request carried no image' },
    });

    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'parked' });
    const parked = await h.jobs.get(h.jobKey);
    assert.equal(parked?.parkReason, 'ocr_outage');
    assert.equal(h.generated.length, 1, 'the outage stops the loop at the first slot');
    // The bytes are already durable — the vendor URL they came from is expiring.
    assert.ok(h.r2.objects.has(`${h.token}/concept-1.png`));
    assert.equal(parked?.checkpoint?.slots[0]?.attempts, 1);
    assert.equal(parked?.checkpoint?.slots[0]?.r2Key, `${h.token}/concept-1.png`);
    assert.equal(parked?.checkpoint?.slots[0]?.ocr, undefined);

    vision = true;
    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'delivered' });
    assert.deepEqual(
      h.generated,
      ['wordmark', 'lockup', 'emblem'],
      'slot 1 is re-gated from R2, not regenerated and paid for twice',
    );
    assert.equal((await h.jobs.get(h.jobKey))?.checkpoint?.spendUsd, 3 * IMAGE_COST_USD.ideogram);
  });

  it('regenerates when the checkpointed R2 object has gone missing', async () => {
    let vision = false;
    const h = await setup({
      ocr: () => (vision ? verdict(true) : { status: 'unavailable', error: 'no image' }),
    });
    await runConceptStage(h.config, message(h.jobKey));
    h.r2.objects.delete(`${h.token}/concept-1.png`);

    vision = true;
    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'delivered' });
    assert.equal(h.generated.filter((id) => id === 'wordmark').length, 2, 'slot 1 is regenerated');
  });
});

// Regression guards for review finding #1. The ledger is mutated in memory the
// moment the vendor is paid, but four throwable awaits sit between that and the
// gates: resvg on a vendor SVG, both R2 puts, and the D1 upsert. If the
// checkpoint is not persisted BEFORE them, a throw loses the dollars and the
// attempt, the queue retries the message, and the same slot is paid for again —
// with the FR-5 cap none the wiser.
describe('runConceptStage — the spend ledger is durable before anything can throw', () => {
  it('persists the attempt and the dollars when the R2 write fails', async () => {
    const h = await setup();
    h.r2.failPut = 'R2 put failed';

    await assert.rejects(runConceptStage(h.config, message(h.jobKey)), /R2 put failed/);

    assert.equal(h.generated.length, 1, 'the vendor was called exactly once');
    const job = await h.jobs.get(h.jobKey);
    assert.equal(job?.checkpoint?.slots[0]?.attempts, 1, 'and that attempt is on the record');
    assert.equal(job?.checkpoint?.spendUsd, IMAGE_COST_USD.ideogram, 'as are its dollars');
    assert.equal(job?.spentUsd, IMAGE_COST_USD.ideogram);
  });

  it('does not let a retrying queue re-pay for slots whose storage write failed', async () => {
    const h = await setup();
    h.r2.failPut = 'R2 put failed';
    // Three redeliveries, exactly as the queue's max_retries would produce.
    for (let i = 0; i < 3; i++) {
      await assert.rejects(runConceptStage(h.config, message(h.jobKey)));
    }
    const job = await h.jobs.get(h.jobKey);
    assert.equal(h.generated.length, 3, 'three paid generations…');
    assert.equal(job?.checkpoint?.slots[0]?.attempts, 3, '…and all three are counted');
    assert.equal(job?.checkpoint?.spendUsd, 3 * IMAGE_COST_USD.ideogram);

    // Slot 1 has now spent its cap honestly, so a recovered fourth run must not
    // buy it a fourth image — while the two untouched slots still complete.
    h.r2.failPut = null;
    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'partial' });
    assert.equal(h.generated.filter((id) => id === 'wordmark').length, 3, 'never a 4th');
    assert.equal((await h.jobs.get(h.jobKey))?.checkpoint?.spendUsd, 5 * IMAGE_COST_USD.ideogram);
  });

  it('persists the attempt when resvg rejects a malformed vendor SVG', async () => {
    // Recraft's response shape has never been exercised live, so an SVG resvg
    // will not parse is a plausible first contact — and it throws from inside
    // renderSvgToPng, after the vendor has already been paid.
    const h = await setup({
      generate: (axisId) => ({
        ok: true,
        costUsd: IMAGE_COST_USD.recraft,
        concept: { axisId, vendor: 'recraft', png: new Uint8Array(0), nativeSvg: 'not an svg' },
      }),
    });

    await assert.rejects(runConceptStage(h.config, message(h.jobKey)), /SVG data parsing failed/);

    const job = await h.jobs.get(h.jobKey);
    assert.equal(h.generated.length, 1);
    assert.equal(job?.checkpoint?.slots[0]?.attempts, 1);
    assert.equal(job?.checkpoint?.spendUsd, IMAGE_COST_USD.recraft);
  });
});

describe('runConceptStage — gate behaviour', () => {
  it('rasterizes and persists a Recraft vector-native return', async () => {
    const nativeSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<script>alert(1)</script><path d="M10 10 H 90 V 90 H 10 Z" fill="#0F3D3E"/></svg>';
    const h = await setup({
      generate: (axisId) =>
        axisId === 'emblem'
          ? {
              ok: true,
              costUsd: IMAGE_COST_USD.recraft,
              concept: {
                axisId,
                vendor: 'recraft',
                vendorRequestId: 'req-emblem',
                png: new Uint8Array(0),
                nativeSvg,
              },
            }
          : okConcept(axisId, MARKS[axisFixture(axisId)]!),
    });

    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'delivered' });

    const svgKey = `${h.token}/concept-3.svg`;
    const stored = h.r2.objects.get(svgKey);
    assert.ok(stored, 'the sanitized SVG is persisted for stage 2 to short-circuit Vectorizer.ai');
    assert.equal(stored!.contentType, 'image/svg+xml');
    const svgText = new TextDecoder().decode(stored!.bytes);
    assert.doesNotMatch(svgText, /<script/i, 'and it is sanitized, not stored verbatim');
    assert.match(svgText, /<path/);

    // The empty PNG that Recraft returned is replaced by a real 1024px raster,
    // because no gate rasterizes for us.
    const png = h.r2.objects.get(`${h.token}/concept-3.png`)!.bytes;
    assert.deepEqual(readPngDimensions(png), { width: 1024, height: 1024 });

    const row = (await h.concepts.list(CONTRACT_ID)).find((r) => r.slot === 3)!;
    assert.equal(row.nativeSvgKey, svgKey);
    assert.equal(row.r2Key, `${h.token}/concept-3.png`);
    assert.ok(row.phash);
  });

  // Regression guard for review finding #2. `concepts.upsert` rewrites the
  // whole row, so the re-gate path must restore every column it does not
  // re-derive. `native_svg_key` is the one that costs money to lose: Task 21
  // reads it to skip Vectorizer.ai when the winner came from Recraft's vector
  // export, so a nulled pointer is a silent ~$0.20 regression invisible from
  // stage 2's side.
  it('keeps native_svg_key across a park and resume of a Recraft slot', async () => {
    let vision = false;
    const h = await setup({
      generate: (axisId) =>
        axisId === 'emblem'
          ? {
              ok: true,
              costUsd: IMAGE_COST_USD.recraft,
              concept: {
                axisId,
                vendor: 'recraft',
                vendorRequestId: 'req-emblem',
                png: new Uint8Array(0),
                nativeSvg:
                  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
                  '<path d="M1 1 H 9 V 9 H 1 Z" fill="#000"/></svg>',
              },
            }
          : okConcept(axisId, MARKS[axisFixture(axisId)]!),
      // The vision model goes dark exactly as the Recraft slot reaches it.
      ocr: (fixture) =>
        fixture === 'rasterized' && !vision
          ? { status: 'unavailable', error: 'vision request carried no image' }
          : verdict(true),
    });

    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'parked' });
    const svgKey = `${h.token}/concept-3.svg`;
    const parked = await h.jobs.get(h.jobKey);
    assert.equal(parked?.parkReason, 'ocr_outage');
    assert.equal(parked?.checkpoint?.slots[2]?.nativeSvgKey, svgKey, 'the checkpoint holds it');

    vision = true;
    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'delivered' });
    assert.equal(h.generated.filter((id) => id === 'emblem').length, 1, 'no regeneration');

    const row = (await h.concepts.list(CONTRACT_ID)).find((r) => r.slot === 3)!;
    assert.equal(row.nativeSvgKey, svgKey, 'and the resumed upsert did not null it');
    assert.ok(h.r2.objects.has(svgKey), 'the bytes were always safe; the pointer is the risk');
  });

  it('regenerates the newer of two indistinct concepts', async () => {
    const h = await setup({
      // Slots 1 and 2 come back byte-identical the first time round.
      generate: (axisId, attempt) =>
        okConcept(
          axisId,
          axisId === 'lockup' && attempt === 1 ? MARKS['leftHalf']! : MARKS[axisFixture(axisId)]!,
        ),
    });

    assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), { outcome: 'delivered' });
    assert.equal(
      h.generated.filter((id) => id === 'lockup').length,
      2,
      'the NEWER slot regenerates',
    );
    assert.equal(h.generated.filter((id) => id === 'wordmark').length, 1, 'the older one stands');

    const audits = await h.db
      .prepare("SELECT result FROM gate_audit WHERE gate = 'distinctness' ORDER BY id ASC")
      .all<{ result: string }>();
    assert.ok(
      audits.results.some((row) => row.result === 'fail'),
      'the collision is on the record',
    );
  });

  // `SELECT DISTINCT gate` proves each gate KIND is on the record at least
  // once — not that every individual verdict was written. Named accordingly.
  it('records a gate audit row for every gate it reaches', async () => {
    const h = await setup();
    await runConceptStage(h.config, message(h.jobKey));
    const { results } = await h.db
      .prepare('SELECT DISTINCT gate FROM gate_audit WHERE job_key = ?')
      .bind(h.jobKey)
      .all<{ gate: string }>();
    const gates = results.map((row) => row.gate).sort();
    assert.deepEqual(gates, [
      'dimensions',
      'distinctness',
      'm1-delivery',
      'moderation',
      'ocr',
      'phash',
    ]);
  });

  it('names the declared thresholds in the delivery note', async () => {
    const h = await setup();
    await runConceptStage(h.config, message(h.jobKey));
    const note = h.deliveries[0]!.note;
    assert.ok(note.includes(String(OCR_SIMILARITY_THRESHOLD)));
    assert.match(note, /Trademark clearance is NOT performed/);
    // The platform posts only the first ~500 characters as the thread summary,
    // so the instruction the buyer must act on cannot live below the fold.
    assert.ok(note.indexOf('PICK YOUR WINNER') < 300);
  });
});

// Task 10 measured 129.5 MB against the 128 MB isolate ceiling from resvg
// handles that were never `.free()`d; the fix (free in `finally`, inner before
// outer) lives in pack/render.ts and dropped peak to 99.7 MB. The stage runs
// resvg once per concept — twice for a Recraft return — inside a regeneration
// loop, so this guard asserts at the PIPELINE level that every instance the
// stage causes to be created is also released. It fails if anyone reintroduces
// a bare `new Resvg` here rather than going through pack/render.ts.
describe('runConceptStage — wasm buffers are released', () => {
  it('frees one Resvg and one RenderedImage for every render the stage triggers', async () => {
    const sources = nodeWasmSources();
    await ensureResvgReady(sources.resvg);
    const probe = new Resvg(MARK_SVGS['leftHalf']!, { fitTo: { mode: 'width', value: 8 } });
    const probeImage = probe.render();
    const renderedImageProto = Object.getPrototypeOf(probeImage) as { free(): void };
    probeImage.free();
    probe.free();

    const h = await setup({
      generate: (axisId) =>
        axisId === 'emblem'
          ? {
              ok: true,
              costUsd: IMAGE_COST_USD.recraft,
              concept: {
                axisId,
                vendor: 'recraft',
                png: new Uint8Array(0),
                nativeSvg:
                  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
                  '<path d="M1 1 H 9 V 9 H 1 Z" fill="#000"/></svg>',
              },
            }
          : okConcept(axisId, MARKS[axisFixture(axisId)]!),
    });

    const render = mock.method(Resvg.prototype, 'render');
    const resvgFree = mock.method(Resvg.prototype, 'free');
    const imageFree = mock.method(renderedImageProto, 'free');
    try {
      assert.deepEqual(await runConceptStage(h.config, message(h.jobKey)), {
        outcome: 'delivered',
      });
      // 3 pHash decodes + 1 Recraft rasterization.
      assert.equal(render.mock.callCount(), 4);
      assert.equal(resvgFree.mock.callCount(), render.mock.callCount());
      assert.equal(imageFree.mock.callCount(), render.mock.callCount());
    } finally {
      render.mock.restore();
      resvgFree.mock.restore();
      imageFree.mock.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// runVectorStage integration harness
//
// Stage 2 fixtures are produced by RUNNING STAGE 1, not by hand-seeding D1 and
// R2. Everything stage 2 reads — the concept rows, the r2 keys, the
// native_svg_key pointer, the checkpoint's OCR verdicts, the spend ledger, the
// selection row — is then exactly what the real stage writes, so a change to
// stage 1's persistence shows up here as a failure instead of quietly leaving
// these tests asserting against a shape that no longer exists.
// ---------------------------------------------------------------------------

/** The proven Recraft vector-native return: an empty PNG plus a native SVG. */
const RECRAFT_NATIVE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M10 10 H 90 V 90 H 10 Z" fill="#0F3D3E"/></svg>';

const recraftEmblem = (axisId: string): GenerateResult =>
  axisId === 'emblem'
    ? {
        ok: true,
        costUsd: IMAGE_COST_USD.recraft,
        concept: {
          axisId,
          vendor: 'recraft',
          vendorRequestId: 'req-emblem',
          png: new Uint8Array(0),
          nativeSvg: RECRAFT_NATIVE_SVG,
        },
      }
    : okConcept(axisId, MARKS[axisFixture(axisId)]!);

/** A square true vector — a pack built from this clears every gate. */
const TRACED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M12 12 H88 V88 H12 Z" fill="#123456"/>' +
  '<circle cx="50" cy="50" r="18" fill="#E8C39E"/></svg>';

/**
 * A NON-SQUARE true vector. It passes `checkTrueVector` (real paths, valid
 * viewBox) but every render comes out at the wrong aspect, so the dimension and
 * ICO gates fail inside `buildPack` — the one realistic way to reach the
 * gates-failed abort leg without faking `buildPack` itself.
 */
const WIDE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">' +
  '<path d="M10 10 H190 V90 H10 Z" fill="#0F3D3E"/></svg>';

const fakeVectorizer = (result: Awaited<ReturnType<Vectorizer['toVector']>>): Vectorizer => ({
  toVector: async () => result,
});

interface VectorHarness extends Harness {
  vectorJobKey: string;
  vectorToken: string;
  vectorMessage: JobMessage;
}

async function setupVector(
  options: SetupOptions & {
    winner?: number;
    source?: SelectionSource;
    /** The M1 outcome this fixture is built on. `partial` is the §9 2-of-3 set. */
    expectStageOne?: StageOutcome['outcome'];
  } = {},
): Promise<VectorHarness> {
  const h = await setup(options);
  const stageOne = await runConceptStage(h.config, message(h.jobKey));
  // Precondition, asserted inline: every stage-2 assertion below is about what
  // happens to an M1 that reached a specific outcome. If stage 1 ever stops
  // reaching it under these options, these tests must fail here rather than
  // pass vacuously against an empty concept table.
  assert.deepEqual(
    stageOne,
    { outcome: options.expectStageOne ?? 'delivered' },
    'the stage-2 fixture did not get the M1 outcome it is written against',
  );

  const vectorJobKey = await buildJobKey(CONTRACT_ID, 'vector');
  await h.jobs.claim(vectorJobKey, CONTRACT_ID, 'vector');
  const vectorToken = (await h.jobs.get(vectorJobKey))!.deliverableToken!;
  assert.notEqual(vectorToken, h.token, 'each stage gets its own capability token');
  await h.selection.select(CONTRACT_ID, options.winner ?? 1, options.source ?? 'buyer');

  return {
    ...h,
    vectorJobKey,
    vectorToken,
    vectorMessage: { contractId: CONTRACT_ID, jobKey: vectorJobKey, stage: 'vector' },
  };
}

const readJson = <T>(h: VectorHarness, file: string): T =>
  JSON.parse(new TextDecoder().decode(h.r2.objects.get(`${h.vectorToken}/${file}`)!.bytes)) as T;

/**
 * Prove the M2 evidence link actually renders, rather than pinning its string.
 *
 * `/p/:token` looks the job up BY that token and emits
 * `<img src="/deliverables/<the same token>/concept-N.png">` (progress.ts). The
 * concept PNGs were written under STAGE 1's token, so a link carrying stage 2's
 * token resolves the vector job row and renders three 404s — a broken evidence
 * page attached to the delivery that is supposed to prove the work.
 */
function assertEvidenceLinkResolves(h: VectorHarness, url: string): void {
  const token = url.split('/p/')[1]!;
  assert.notEqual(token, h.vectorToken, 'the evidence page is stage 1s, not stage 2s');
  assert.equal(token, h.token);
  const rendered = [1, 2, 3].filter((slot) => h.r2.objects.has(`${token}/concept-${slot}.png`));
  assert.deepEqual(rendered, [1, 2, 3], 'every concept image on the evidence page must exist');
}

describe('runVectorStage — a Recraft-native winner never touches Vectorizer.ai', () => {
  it('delivers the full pack, report, and licenses with zero vendor spend', async () => {
    const h = await setupVector({ generate: recraftEmblem, winner: SLOT_OF['emblem']! });
    // Precondition: the winner really is the Recraft slot with a stored native
    // SVG. Without this, "never called Vectorizer.ai" could be true simply
    // because stage 1 never wrote the pointer and the leg aborted early.
    const winnerRow = (await h.concepts.list(CONTRACT_ID)).find(
      (row) => row.slot === SLOT_OF['emblem'],
    )!;
    assert.equal(winnerRow.nativeSvgKey, `${h.token}/concept-3.svg`);
    assert.ok(h.r2.objects.has(winnerRow.nativeSvgKey!));

    const result = await runVectorStage(h.config, h.vectorMessage);
    assert.deepEqual(result, { outcome: 'delivered' });

    // The §13 mitigation, proved structurally: no fake vectorizer was injected,
    // so the REAL one ran against a fetchImpl that refuses the network. The
    // fonts call proves the recorder itself works — without it, "no
    // vectorizer.ai call" would also be true of a broken recorder.
    assert.ok(
      h.fetches.some((url) => url.includes('googleapis.com/webfonts')),
      'the advisory font call is recorded, so the recorder is live',
    );
    assert.equal(
      h.fetches.filter((url) => url.includes('vectorizer.ai')).length,
      0,
      'a Recraft-native winner must not pay Vectorizer.ai',
    );
    assert.equal((await h.jobs.get(h.vectorJobKey))?.checkpoint?.spendUsd, 0);

    // Artifacts land under stage 2's own token, with the content types the
    // /deliverables route serves them as.
    for (const [file, type] of [
      ['pack.zip', 'application/zip'],
      ['report.json', 'application/json'],
      ['licenses.json', 'application/json'],
    ] as const) {
      const object = h.r2.objects.get(`${h.vectorToken}/${file}`);
      assert.ok(object, `${file} is missing from R2`);
      assert.equal(object.contentType, type);
    }

    const files = unzipFiles(h.r2.objects.get(`${h.vectorToken}/pack.zip`)!.bytes);
    for (const name of REQUIRED_ZIP_ENTRIES)
      assert.ok(name in files, `missing pack entry: ${name}`);

    // FR-12 is advisory and must survive the vendor being unreachable: the
    // refusing fetchImpl above means the pinned fallback pairing is what lands.
    const brand = JSON.parse(new TextDecoder().decode(files['brand.json']!)) as {
      fonts: { heading: { family: string } };
    };
    assert.equal(brand.fonts.heading.family, 'Inter', 'a fonts outage never fails the job');

    assert.equal(h.deliveries.length, 2);
    const m2 = h.deliveries[1]!;
    assert.equal(m2.milestoneId, 'm2');
    assert.deepEqual(m2.attachments, [
      `https://logosmith.example.com/deliverables/${h.vectorToken}/pack.zip`,
      `https://logosmith.example.com/deliverables/${h.vectorToken}/report.json`,
      `https://logosmith.example.com/deliverables/${h.vectorToken}/licenses.json`,
      // STAGE 1's token, not this stage's — see below.
      `https://logosmith.example.com/p/${h.token}`,
    ]);
    assertEvidenceLinkResolves(h, m2.attachments[3]!);
    assert.match(m2.note, /Harbor & Vine/);
    assert.match(m2.note, /Trademark clearance is NOT performed/);
    // The platform posts only the opening ~500 characters as the thread
    // summary, so the download link cannot live below the fold.
    assert.ok(m2.note.indexOf('DOWNLOAD:') < 200);

    assert.equal((await h.selection.get(CONTRACT_ID))?.state, 'pack_delivered');
    const job = await h.jobs.get(h.vectorJobKey);
    assert.equal(job?.status, 'delivered');
    assert.equal(job?.outcome, 'delivered');
  });

  it('writes a §8-complete validation report and license manifest beside the pack', async () => {
    const h = await setupVector({ generate: recraftEmblem, winner: SLOT_OF['emblem']! });
    await runVectorStage(h.config, h.vectorMessage);

    const report = readJson<ValidationReport>(h, 'report.json');
    assert.equal(report.contractId, CONTRACT_ID);
    assert.equal(report.brandName, BRIEF.brandName);
    assert.equal(report.gatesPass, true);
    assert.equal(report.concepts.length, 3);
    for (const concept of report.concepts) {
      assert.ok(concept.phash, 'every concept carries its hash');
      assert.ok(concept.ocr, 'and its readback snapshot');
      assert.equal(concept.ocr!.pass, true);
    }
    assert.deepEqual(report.winner, {
      slot: SLOT_OF['emblem'],
      axisId: 'emblem',
      selectionSource: 'buyer',
    });
    assert.deepEqual(report.vectorization, {
      source: 'recraft-native',
      vendor: 'recraft',
      costUsd: 0,
    });
    assert.equal(report.svgGate.zeroRasterEmbedded, true);
    assert.equal(report.svgGate.census.image, 0);
    assert.equal(report.dimensions.length, 9, 'two masters, six favicons, and the mono master');
    assert.ok(report.dimensions.every((entry) => entry.pass));
    assert.deepEqual(report.ico.sizes, [16, 32, 48]);
    assert.ok(report.zip.manifest.includes('logo.svg'));
    assert.equal(report.moderation.images!.length, 3, 'one unsafe-flag snapshot per concept');
    assert.ok(report.moderation.images!.every((image) => image.unsafe === false));
    assert.deepEqual(report.evidenceGaps, [], 'every record was sourced');
    // End to end: stage 1 wrote this verdict to D1 gate_audit, listGateAudit
    // read it back out of the real column, and it survived into the delivered
    // JSON byte-for-byte — response body included. The buyer holding
    // report.json can read the screening that authorized generation without
    // access to our database.
    assert.deepEqual(report.moderation.input.verdict, CLEAR_VERDICT);
    assert.equal(report.moderation.input.outageAttempts, 0);
    assert.equal(report.caps.conceptStageUsd, 2 * IMAGE_COST_USD.ideogram + IMAGE_COST_USD.recraft);
    assert.equal(report.caps.vectorStageUsd, 0);
    assert.deepEqual(report.idempotencyKeys, {
      concepts: h.jobKey,
      vector: h.vectorJobKey,
    });
    assert.equal(report.phashMatrix.distances[0]![1], report.phashMatrix.distances[1]![0]);

    const licenses = readJson<LicenseManifest>(h, 'licenses.json');
    assert.deepEqual(
      licenses.entries.map((entry) => entry.artifact),
      ['concept-1.png', 'concept-2.png', 'concept-3.png', 'logo.svg'],
    );
    assert.equal(licenses.entries[3]!.vendor, 'recraft', 'the conversion is credited to Recraft');
    assert.equal(licenses.entries[0]!.vendorRequestId, 'req-wordmark');
  });

  // The §9 2-of-3 shortfall is the LIKELIEST real M1 outcome, not an edge case:
  // the buyer accepts a partial set, picks from it, and M2 must build normally
  // from a contract whose concept table has a failed row in it.
  it('delivers normally from a partial M1, with the shortfall slot in the evidence', async () => {
    const h = await setupVector({
      ocr: (fixture) => verdict(fixture !== 'checker'),
      expectStageOne: 'partial',
      winner: 1,
      vectorizer: fakeVectorizer({ ok: true, svg: TRACED_SVG, source: 'vectorizer', costUsd: 0.2 }),
    });
    assert.deepEqual(await runVectorStage(h.config, h.vectorMessage), { outcome: 'delivered' });

    const report = readJson<ValidationReport>(h, 'report.json');
    // All three concepts are on the record — the failed one included, with its
    // failing verdict intact. A shortfall is evidence, not something to hide.
    assert.equal(report.concepts.length, 3);
    const failed = report.concepts.find((c) => c.slot === SLOT_OF['emblem'])!;
    assert.equal(failed.ocr!.pass, false);
    assert.equal(failed.attemptsUsed, MAX_REGENS_PER_SLOT + 1);
    assert.equal(report.winner.slot, 1);
    assert.equal(report.gatesPass, true, 'the pack itself is whole regardless');
    assert.equal(report.caps.generationAttempts, 5, '1 + 1 + 3 across the three slots');

    // Every generated concept still gets a licence entry: all three were paid
    // for, whether or not they were offered.
    const licenses = readJson<LicenseManifest>(h, 'licenses.json');
    assert.equal(licenses.entries.length, 4, 'three concepts plus the conversion');
    assertEvidenceLinkResolves(h, h.deliveries[1]!.attachments[3]!);
  });

  it('treats a redelivered vector message as a no-op', async () => {
    const h = await setupVector({ generate: recraftEmblem, winner: SLOT_OF['emblem']! });
    assert.deepEqual(await runVectorStage(h.config, h.vectorMessage), { outcome: 'delivered' });
    assert.deepEqual(await runVectorStage(h.config, h.vectorMessage), { outcome: 'delivered' });
    assert.equal(h.deliveries.length, 2, 'M1 and one M2 — the second run delivers nothing');
  });
});

describe('runVectorStage — the traced path and its spend ledger', () => {
  it('delivers a traced winner and books the conversion against the ledger', async () => {
    const h = await setupVector({
      winner: 1,
      vectorizer: fakeVectorizer({
        ok: true,
        svg: TRACED_SVG,
        source: 'vectorizer',
        costUsd: IMAGE_COST_USD.vectorizer,
      }),
    });
    assert.deepEqual(await runVectorStage(h.config, h.vectorMessage), { outcome: 'delivered' });

    const job = await h.jobs.get(h.vectorJobKey);
    assert.equal(job?.checkpoint?.spendUsd, IMAGE_COST_USD.vectorizer);
    assert.equal(job?.spentUsd, IMAGE_COST_USD.vectorizer);

    const report = readJson<ValidationReport>(h, 'report.json');
    assert.deepEqual(report.vectorization, {
      source: 'vectorizer',
      vendor: 'vectorizer',
      costUsd: IMAGE_COST_USD.vectorizer,
    });
    assert.equal(report.caps.vectorStageUsd, IMAGE_COST_USD.vectorizer);
    assert.equal(
      report.caps.spentUsd,
      3 * IMAGE_COST_USD.ideogram + IMAGE_COST_USD.vectorizer,
      'the report shows both stages summed, not just this one',
    );

    const licenses = readJson<LicenseManifest>(h, 'licenses.json');
    assert.equal(licenses.entries.at(-1)!.vendor, 'vectorizer');
  });

  // Regression guard, same shape as stage 1's. The vendor is paid the moment
  // toVector returns; ten wasm renders and three R2 puts sit between that and
  // the end of the stage. If the ledger is not persisted first, a failing R2
  // write loses the dollars, the queue retries, and the conversion is bought
  // twice.
  it('persists the conversion spend before anything that can throw', async () => {
    const h = await setupVector({
      winner: 1,
      vectorizer: fakeVectorizer({
        ok: true,
        svg: TRACED_SVG,
        source: 'vectorizer',
        costUsd: IMAGE_COST_USD.vectorizer,
      }),
    });
    h.r2.failPut = 'R2 put failed';

    await assert.rejects(runVectorStage(h.config, h.vectorMessage), /R2 put failed/);

    const job = await h.jobs.get(h.vectorJobKey);
    assert.equal(job?.checkpoint?.spendUsd, IMAGE_COST_USD.vectorizer, 'the dollars are on record');
    assert.equal(job?.spentUsd, IMAGE_COST_USD.vectorizer);
    assert.equal(h.deliveries.length, 1, 'and nothing was delivered');
  });
});

describe('runVectorStage — vendor and gate failures never deliver', () => {
  it('parks on a retryable vectorizer outage and tells the buyer exactly once', async () => {
    const h = await setupVector({
      winner: 1,
      vectorizer: fakeVectorizer({
        ok: false,
        retryable: true,
        error: 'vectorizer.ai returned 503',
      }),
    });

    assert.deepEqual(await runVectorStage(h.config, h.vectorMessage), { outcome: 'parked' });
    const parked = await h.jobs.get(h.vectorJobKey);
    assert.equal(parked?.status, 'parked');
    assert.equal(parked?.parkReason, 'vectorizer_outage');
    assert.equal(parked?.checkpoint?.spendUsd, 0, 'an outage produced nothing and cost nothing');
    assert.equal(h.deliveries.length, 1, 'M1 only — nothing is delivered');
    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0]!, /conversion service is currently unavailable/);

    // The cron unparks and re-enqueues every 15 minutes; the buyer hears about
    // it once, not once per cycle.
    await h.jobs.unpark(h.vectorJobKey);
    assert.deepEqual(await runVectorStage(h.config, h.vectorMessage), { outcome: 'parked' });
    assert.equal(h.messages.length, 1, 'exactly one notice, not one per cron cycle');
  });

  it('aborts rather than parks when the conversion fails permanently', async () => {
    const h = await setupVector({
      winner: 1,
      vectorizer: fakeVectorizer({
        ok: false,
        retryable: false,
        error: 'true-vector self-check failed: contains 1 <image> element(s)',
      }),
    });

    assert.deepEqual(await runVectorStage(h.config, h.vectorMessage), { outcome: 'aborted' });
    const job = await h.jobs.get(h.vectorJobKey);
    assert.equal(job?.status, 'delivered', 'terminal, not parked — the retry can never succeed');
    assert.equal(job?.outcome, 'aborted');
    assert.equal(h.deliveries.length, 1);
    assert.match(h.messages[0]!, /wraps a raster/);
  });

  it('takes the abort leg without delivering when the pack gates fail', async () => {
    const h = await setupVector({
      winner: 1,
      // A true vector by the gate's own reckoning, but non-square: every render
      // lands at the wrong aspect and the dimension + ICO gates fail.
      vectorizer: fakeVectorizer({ ok: true, svg: WIDE_SVG, source: 'vectorizer', costUsd: 0.2 }),
    });

    assert.deepEqual(await runVectorStage(h.config, h.vectorMessage), { outcome: 'aborted' });
    assert.equal(h.deliveries.length, 1, 'deliverMilestone is never called for M2');
    assert.equal(
      h.r2.objects.has(`${h.vectorToken}/pack.zip`),
      false,
      'and a failing pack is never even written to R2',
    );
    assert.equal((await h.selection.get(CONTRACT_ID))?.state, 'winner_selected');
    assert.equal((await h.jobs.get(h.vectorJobKey))?.outcome, 'aborted');
    assert.match(h.messages[0]!, /did not clear its own delivery gates/);
    assert.match(h.messages[0]!, /logo-color-1024\.png is 1024x512, expected 1024x1024/);

    const { results } = await h.db
      .prepare("SELECT result FROM gate_audit WHERE gate = 'pack' AND job_key = ?")
      .bind(h.vectorJobKey)
      .all<{ result: string }>();
    assert.deepEqual(
      results.map((row) => row.result),
      ['fail'],
      'the failing pack is on the audit record',
    );
  });

  // The delivery note this module writes says "Machine-verified before
  // delivery". That claim has to be true where it is made — not conditional on
  // the selection resolver, present or future, only ever offering slots that
  // passed. Without this guard a slot the buyer was never even shown can be
  // selected by number and shipped as a verified pack whose own report.json
  // records `ocr.pass: false`.
  it('refuses to build a pack from a concept that never passed its own gates', async () => {
    const h = await setupVector({
      // The emblem slot's readback fails on every attempt, so it is one of the
      // two §9 shortfall slots — generated, paid for, never offered.
      ocr: (fixture) => verdict(fixture !== 'checker'),
      expectStageOne: 'partial',
      winner: SLOT_OF['emblem']!,
    });
    // Precondition: the selected slot really is a failing one that the buyer
    // was never shown. Without this the abort below could be any other reason.
    const loser = (await h.concepts.list(CONTRACT_ID)).find(
      (row) => row.slot === SLOT_OF['emblem'],
    )!;
    assert.equal(loser.ocrPass, false);
    assert.equal(loser.attemptsUsed, MAX_REGENS_PER_SLOT + 1, 'it burned every attempt');
    assert.ok(h.r2.objects.has(loser.r2Key!), 'its bytes exist — only its verdict disqualifies it');
    assert.doesNotMatch(h.deliveries[0]!.note, /Concept 3\n/, 'M1 never offered it');

    assert.deepEqual(await runVectorStage(h.config, h.vectorMessage), { outcome: 'aborted' });
    assert.equal(h.deliveries.length, 1, 'M1 only — M2 is never delivered');
    assert.equal(h.r2.objects.has(`${h.vectorToken}/pack.zip`), false);
    assert.equal((await h.selection.get(CONTRACT_ID))?.state, 'winner_selected');
    assert.equal((await h.jobs.get(h.vectorJobKey))?.outcome, 'aborted');
    // The refusal quotes the verdict it rests on.
    assert.match(h.messages[0]!, /did not pass the lettering-readback gate/);
    assert.match(h.messages[0]!, new RegExp(String(OCR_SIMILARITY_THRESHOLD)));
    assert.match(h.messages[0]!, /machine-verified/i);

    const { results } = await h.db
      .prepare("SELECT result FROM gate_audit WHERE gate = 'winner-eligibility' AND job_key = ?")
      .bind(h.vectorJobKey)
      .all<{ result: string }>();
    assert.deepEqual(
      results.map((row) => row.result),
      ['fail'],
    );
  });

  it('aborts when the winning concept has gone missing from R2', async () => {
    const h = await setupVector({ winner: 1 });
    h.r2.objects.delete(`${h.token}/concept-1.png`);

    assert.deepEqual(await runVectorStage(h.config, h.vectorMessage), { outcome: 'aborted' });
    assert.equal(h.deliveries.length, 1);
    assert.match(h.messages[0]!, /no longer retrievable/);
  });

  it('throws rather than guessing when no winner has been selected', async () => {
    const h = await setup();
    await runConceptStage(h.config, message(h.jobKey));
    const vectorJobKey = await buildJobKey(CONTRACT_ID, 'vector');
    await h.jobs.claim(vectorJobKey, CONTRACT_ID, 'vector');

    await assert.rejects(
      runVectorStage(h.config, {
        contractId: CONTRACT_ID,
        jobKey: vectorJobKey,
        stage: 'vector',
      }),
      /no selected winner/,
    );
  });
});

// The stage-1 guard's twin (see above). buildPack drives ten resvg renders —
// two masters, six favicons, the mono pixmap, and the mono master — inside one
// stage invocation, which is precisely the kind of loop that put Task 10 at
// 129.5 MB against the 128 MB isolate ceiling. This fails if anyone adds a bare
// `new Resvg` to the vector stage rather than going through pack/render.ts.
describe('runVectorStage — wasm buffers are released', () => {
  it('frees one Resvg and one RenderedImage for every render the pack triggers', async () => {
    const sources = nodeWasmSources();
    await ensureResvgReady(sources.resvg);
    const probe = new Resvg(MARK_SVGS['leftHalf']!, { fitTo: { mode: 'width', value: 8 } });
    const probeImage = probe.render();
    const renderedImageProto = Object.getPrototypeOf(probeImage) as { free(): void };
    probeImage.free();
    probe.free();

    const h = await setupVector({
      winner: 1,
      vectorizer: fakeVectorizer({ ok: true, svg: TRACED_SVG, source: 'vectorizer', costUsd: 0 }),
    });

    const render = mock.method(Resvg.prototype, 'render');
    const resvgFree = mock.method(Resvg.prototype, 'free');
    const imageFree = mock.method(renderedImageProto, 'free');
    try {
      assert.deepEqual(await runVectorStage(h.config, h.vectorMessage), { outcome: 'delivered' });
      // 2 masters + 6 favicons + the mono pixmap + the mono master.
      assert.equal(render.mock.callCount(), 10);
      assert.equal(resvgFree.mock.callCount(), render.mock.callCount());
      assert.equal(imageFree.mock.callCount(), render.mock.callCount());
    } finally {
      render.mock.restore();
      resvgFree.mock.restore();
      imageFree.mock.restore();
    }
  });
});

describe('processJobMessage', () => {
  it('routes a concepts message into the concept stage', async () => {
    const h = await setup();
    await processJobMessage(h.config, message(h.jobKey));
    assert.equal(h.deliveries.length, 1);
  });

  it('routes a vector message into the vector stage', async () => {
    const h = await setupVector({ generate: recraftEmblem, winner: SLOT_OF['emblem']! });
    await processJobMessage(h.config, h.vectorMessage);
    assert.equal(h.deliveries.length, 2, 'M1 from the fixture, then M2 from the routed message');
    assert.equal(h.deliveries[1]!.milestoneId, 'm2');
  });

  // The free `single` stage is routed here too (Task 23); its own behaviour is
  // covered end-to-end in freeGigs.test.ts. What matters at THIS seam is that
  // the switch is exhaustive: an unrecognized stage must raise rather than
  // silently ack a queue message and drop a funded contract on the floor.
  it('refuses an unknown stage rather than silently no-opping', async () => {
    const h = await setup();
    await assert.rejects(
      processJobMessage(h.config, {
        contractId: CONTRACT_ID,
        jobKey: h.jobKey,
        stage: 'not-a-stage' as unknown as JobMessage['stage'],
      }),
      /unknown job stage: not-a-stage/,
    );
  });
});

/** The fixture each axis normally returns. */
function axisFixture(axisId: string): string {
  return ['leftHalf', 'topHalf', 'checker'][SLOT_OF[axisId]! - 1]!;
}
