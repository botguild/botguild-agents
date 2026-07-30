import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-wasm';
import type { AgentClient } from '@botguild/agent-core';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import type { D1Like } from '@botguild/agent-core-workers';
import {
  IMAGE_COST_USD,
  MAX_REGENS_PER_SLOT,
  MAX_SPEND_USD,
  MODERATION_ATTEMPTS_BEFORE_NOTICE,
  OCR_SIMILARITY_THRESHOLD,
  SCOUT_MODEL_ID,
} from './config.js';
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
import { renderSvgToPng } from './pack/render.js';
import { ensureResvgReady } from './pack/wasm.js';
import { nodeWasmSources } from './pack/wasm.node.js';
import { applyMigrations } from './testSupport.js';
import {
  decideSlotAction,
  milestoneIdForStage,
  processJobMessage,
  runConceptStage,
  type DeliverableStore,
  type PipelineConfig,
} from './pipeline.js';
import type { ConceptState, LogoBrief, StyleAxis } from './types.js';

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
): GenerateResult => ({
  ok: true,
  costUsd,
  concept: {
    axisId,
    vendor: AXES.find((a) => a.id === axisId)?.vendor ?? 'ideogram',
    vendorRequestId: `req-${axisId}`,
    png,
  },
});

interface MemoryR2 extends DeliverableStore {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
}

function memoryR2(): MemoryR2 {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    objects,
    async put(key, value, contentType) {
      objects.set(key, { bytes: value, contentType });
    },
    async get(key) {
      return objects.get(key)?.bytes ?? null;
    },
  };
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
  axisCompilations: () => number;
}

interface SetupOptions {
  /** `attempt` is 1-based per axis. */
  generate?: (axisId: string, attempt: number) => GenerateResult;
  /** `attempt` is 1-based per fixture. */
  ocr?: (fixture: string, attempt: number) => OcrOutcome;
  moderation?: ModerationClient;
  description?: string;
}

const clearModeration: ModerationClient = {
  screen: async () => ({
    status: 'clear',
    verdict: {
      vendor: 'openai',
      model: 'omni-moderation-2024-09-26',
      flagged: false,
      response: {},
      checkedAt: '2026-07-30T12:00:00.000Z',
    },
  }),
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
    fetchImpl: async () => {
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
    axisCompilations: () => axisCompilations,
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
      generate: (axisId) => okConcept(axisId, MARKS[axisFixture(axisId)]!, 1.0),
      ocr: (fixture) => verdict(fixture !== 'checker'),
    });
    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'partial' });
    // Slots 1 and 2 pass at $1 each; slot 3 is allowed one attempt at $2.00 <
    // $2.50, and the cap then stops every further regeneration.
    assert.equal(h.generated.length, 3);
    assert.equal((await h.jobs.get(h.jobKey))?.checkpoint?.spendUsd, 3.0);

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
    const h = await setup({ description: 'no fenced json here' });
    const result = await runConceptStage(h.config, message(h.jobKey));

    assert.deepEqual(result, { outcome: 'aborted' });
    assert.equal((await h.jobs.get(h.jobKey))?.outcome, 'rejected');
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
      spendUsd: 2.0,
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

  it('records a gate audit row for every verdict it reaches', async () => {
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

describe('processJobMessage', () => {
  it('routes a concepts message into the concept stage', async () => {
    const h = await setup();
    await processJobMessage(h.config, message(h.jobKey));
    assert.equal(h.deliveries.length, 1);
  });

  it('refuses the stages that later tasks own rather than silently no-opping', async () => {
    const h = await setup();
    await assert.rejects(
      processJobMessage(h.config, { contractId: CONTRACT_ID, jobKey: h.jobKey, stage: 'vector' }),
      /Task 21/,
    );
    await assert.rejects(
      processJobMessage(h.config, { contractId: CONTRACT_ID, jobKey: h.jobKey, stage: 'single' }),
      /Task 23/,
    );
  });
});

/** The fixture each axis normally returns. */
function axisFixture(axisId: string): string {
  return ['leftHalf', 'topHalf', 'checker'][SLOT_OF[axisId]! - 1]!;
}
