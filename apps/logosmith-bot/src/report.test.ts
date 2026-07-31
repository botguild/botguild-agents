import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REGENS_PER_SLOT, MAX_SPEND_USD } from './config.js';
import { checkTrueVector, hammingDistance, fromHex } from './gates/index.js';
import type { ConceptRow, GateAuditRow } from './jobs.js';
import { MODERATION_MODEL, MODERATION_VENDOR, type ModerationVerdict } from './moderation.js';
import type { PackGateReport } from './pack/index.js';
import {
  buildLicenseManifest,
  buildValidationReport,
  summarizeInputScreening,
  VENDOR_TERMS,
  type LicenseRow,
  type ReportInput,
} from './report.js';

// The three fixture hashes below stand in for three real concepts. Their
// pairwise distances are asserted inline wherever a test's meaning depends on
// them being distinct — a fixture that quietly became three identical hashes
// would otherwise drain the matrix tests without failing one.
const PHASH = {
  a: '0000000000000000',
  b: 'ffffffffffff0000',
  c: '0f0f0f0f0f0f0f0f',
} as const;

const conceptRow = (over: Partial<ConceptRow> = {}): ConceptRow => ({
  contractId: 'contract-1',
  slot: 1,
  axisId: 'wordmark',
  vendor: 'ideogram',
  vendorRequestId: 'req-wordmark',
  r2Key: 'token/concept-1.png',
  nativeSvgKey: null,
  phash: PHASH.a,
  ocrTranscription: 'Harbor & Vine',
  ocrScore: 0.97,
  ocrModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
  ocrPass: true,
  attemptsUsed: 1,
  ...over,
});

const CONCEPTS: ConceptRow[] = [
  conceptRow(),
  conceptRow({
    slot: 2,
    axisId: 'lockup',
    vendorRequestId: 'req-lockup',
    r2Key: 'token/concept-2.png',
    phash: PHASH.b,
    attemptsUsed: 2,
  }),
  conceptRow({
    slot: 3,
    axisId: 'emblem',
    vendor: 'recraft',
    vendorRequestId: 'req-emblem',
    r2Key: 'token/concept-3.png',
    nativeSvgKey: 'token/concept-3.svg',
    phash: PHASH.c,
    attemptsUsed: 3,
  }),
];

// A real-shaped OpenAI moderations body, not a stub: the point of copying the
// verdict verbatim is that the vendor's own response survives into the
// deliverable, so the fixture has to carry something that would be visibly lost
// if only the top-level flags were copied.
const MODERATION_VERDICT: ModerationVerdict = {
  vendor: MODERATION_VENDOR,
  model: MODERATION_MODEL,
  flagged: false,
  response: {
    id: 'modr-6f21c0',
    model: MODERATION_MODEL,
    results: [
      {
        flagged: false,
        categories: { violence: false, hate: false },
        category_scores: { violence: 0.000012, hate: 0.0000034 },
      },
    ],
  },
  checkedAt: '2026-07-30T11:58:00.000Z',
};

const auditRow = (over: Partial<GateAuditRow> = {}): GateAuditRow => ({
  id: 1,
  jobKey: 'abc:concepts',
  contractId: 'contract-1',
  slot: null,
  gate: 'moderation',
  result: 'clear',
  detail: MODERATION_VERDICT,
  createdAt: '2026-07-30T11:58:00.000Z',
  ...over,
});

/** Two vendor outages, then the screening that authorized generation. */
const MODERATION_AUDITS: GateAuditRow[] = [
  auditRow({ id: 1, result: 'unavailable', detail: { error: 'moderation vendor returned 503' } }),
  auditRow({ id: 2, result: 'unavailable', detail: { error: 'moderation vendor returned 503' } }),
  auditRow({ id: 3, result: 'clear', detail: MODERATION_VERDICT }),
];

const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M10 10 H90 V90 H10 Z" fill="#0F3D3E"/></svg>';

const RASTER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<image href="data:image/png;base64,AAAA" width="100" height="100"/></svg>';

const gates = (over: Partial<PackGateReport> = {}): PackGateReport => ({
  vector: checkTrueVector(CLEAN_SVG),
  dimensions: [
    {
      file: 'logo-color-1024.png',
      pass: true,
      actual: { width: 1024, height: 1024 },
      expected: { width: 1024, height: 1024 },
    },
    {
      file: 'favicon-16.png',
      pass: true,
      actual: { width: 16, height: 16 },
      expected: { width: 16, height: 16 },
    },
  ],
  ico: { pass: true, sizes: [16, 32, 48] },
  zip: { pass: true, present: ['logo.svg', 'brand.json'], missing: [], reasons: [] },
  pass: true,
  ...over,
});

const reportInput = (over: Partial<ReportInput> = {}): ReportInput => ({
  contractId: 'contract-1',
  brandName: 'Harbor & Vine',
  generatedAt: '2026-07-30T12:00:00.000Z',
  concepts: CONCEPTS,
  visionChecks: [
    {
      slot: 1,
      model: '@cf/meta/llama-4-scout-17b-16e-instruct',
      unsafe: false,
      checkedAt: '2026-07-30T11:59:00.000Z',
    },
    {
      slot: 2,
      model: '@cf/meta/llama-4-scout-17b-16e-instruct',
      unsafe: false,
      checkedAt: '2026-07-30T11:59:30.000Z',
    },
  ],
  moderationAudits: MODERATION_AUDITS,
  winner: { slot: 3, source: 'buyer' },
  vectorization: { source: 'recraft-native', vendor: 'recraft', costUsd: 0 },
  gates: gates(),
  spend: { conceptStageUsd: 0.2, vectorStageUsd: 0 },
  idempotencyKeys: { concepts: 'abc:concepts', vector: 'abc:vector' },
  ...over,
});

describe('buildValidationReport — §8 per-concept provenance', () => {
  it('carries axis id, vendor, request id, OCR snapshot, attempts, and pHash for every concept', () => {
    const report = buildValidationReport(reportInput());
    assert.equal(report.concepts.length, CONCEPTS.length);

    for (const row of CONCEPTS) {
      const entry = report.concepts.find((c) => c.slot === row.slot);
      assert.ok(entry, `slot ${row.slot} is missing from the report`);
      assert.equal(entry.axisId, row.axisId);
      assert.equal(entry.vendor, row.vendor);
      assert.equal(entry.vendorRequestId, row.vendorRequestId);
      assert.equal(entry.attemptsUsed, row.attemptsUsed);
      assert.equal(entry.phash, row.phash);
      assert.deepEqual(entry.ocr, {
        model: row.ocrModel,
        transcription: row.ocrTranscription,
        score: row.ocrScore,
        pass: row.ocrPass,
      });
    }
    // The fixture must actually vary these, or "carries them" proves nothing.
    assert.equal(new Set(report.concepts.map((c) => c.axisId)).size, 3);
    assert.equal(new Set(report.concepts.map((c) => c.vendorRequestId)).size, 3);
    assert.deepEqual(
      report.concepts.map((c) => c.attemptsUsed),
      [1, 2, 3],
    );
  });

  it('reports a slot that never reached the vision model as ocr: null, keeping its attempt count', () => {
    const unreached = conceptRow({
      slot: 2,
      axisId: 'lockup',
      ocrModel: null,
      ocrTranscription: null,
      ocrScore: null,
      ocrPass: false,
      phash: null,
      attemptsUsed: 3,
    });
    const report = buildValidationReport(reportInput({ concepts: [CONCEPTS[0]!, unreached] }));
    const entry = report.concepts.find((c) => c.slot === 2)!;
    assert.equal(entry.ocr, null);
    assert.equal(entry.phash, null);
    assert.equal(entry.attemptsUsed, 3, 'the attempts a burned slot spent are still on the record');
  });
});

describe('buildValidationReport — the pairwise pHash matrix', () => {
  it('is square, symmetric, and zero on the diagonal', () => {
    const report = buildValidationReport(reportInput());
    const { slots, distances } = report.phashMatrix;
    assert.deepEqual(slots, [1, 2, 3]);
    assert.equal(distances.length, 3);

    for (let i = 0; i < 3; i++) {
      assert.equal(distances[i]!.length, 3);
      assert.equal(distances[i]![i], 0, 'a concept is distance 0 from itself');
      for (let j = 0; j < 3; j++) {
        assert.equal(distances[i]![j], distances[j]![i], `matrix is asymmetric at ${i},${j}`);
      }
    }
    // Precondition: the fixture hashes are genuinely different, so symmetry is
    // being asserted over real distances rather than a matrix of zeroes.
    assert.ok(distances[0]![1]! > 0 && distances[0]![2]! > 0 && distances[1]![2]! > 0);
    assert.equal(distances[0]![1], hammingDistance(fromHex(PHASH.a), fromHex(PHASH.b)));
  });

  it('reports null rather than 0 where a concept has no usable hash', () => {
    const report = buildValidationReport(
      reportInput({
        concepts: [CONCEPTS[0]!, conceptRow({ slot: 2, phash: null })],
      }),
    );
    const { distances } = report.phashMatrix;
    assert.equal(distances[0]![1], null, 'a missing hash must never read as "identical"');
    assert.equal(distances[1]![0], null);
    assert.equal(distances[1]![1], null);
  });

  it('fails a corrupt hash closed instead of throwing the whole report away', () => {
    const report = buildValidationReport(
      reportInput({ concepts: [CONCEPTS[0]!, conceptRow({ slot: 2, phash: 'not-hex' })] }),
    );
    assert.equal(report.phashMatrix.distances[0]![1], null);
    assert.equal(report.concepts.length, 2, 'the rest of the evidence still ships');
  });
});

describe('buildValidationReport — winner and selection source', () => {
  it('records the winning slot, its axis, and that the buyer chose it', () => {
    const report = buildValidationReport(reportInput());
    assert.deepEqual(report.winner, { slot: 3, axisId: 'emblem', selectionSource: 'buyer' });
  });

  it('records a default selection as such', () => {
    const report = buildValidationReport(reportInput({ winner: { slot: 1, source: 'default' } }));
    assert.deepEqual(report.winner, { slot: 1, axisId: 'wordmark', selectionSource: 'default' });
  });
});

describe('buildValidationReport — the SVG gate', () => {
  it('carries the node census and asserts zero embedded rasters', () => {
    const report = buildValidationReport(reportInput());
    assert.equal(report.svgGate.pass, true);
    assert.equal(report.svgGate.census.path, 1);
    assert.equal(report.svgGate.census.image, 0);
    assert.equal(report.svgGate.census.hasViewBox, true);
    assert.equal(report.svgGate.zeroRasterEmbedded, true);
  });

  it('refuses the zero-raster assertion when the gate did not pass', () => {
    const failing = checkTrueVector(RASTER_SVG);
    // Precondition: this fixture must fail for the raster reason specifically.
    assert.equal(failing.pass, false);
    assert.equal(failing.census.image, 1);

    const report = buildValidationReport(reportInput({ gates: gates({ vector: failing }) }));
    assert.equal(report.svgGate.zeroRasterEmbedded, false);
    assert.equal(report.svgGate.census.image, 1);
    assert.ok(report.svgGate.violations.length > 0, 'and the violations are quoted verbatim');
  });

  it('still refuses the assertion when the gate failed for an unrelated reason', () => {
    // No <image> anywhere, but no viewBox either: the census alone would say
    // "zero rasters", and the gate is the only thing that also rules out a
    // data: or .png reference. The assertion must follow the gate, not the census.
    const noViewBox = checkTrueVector(
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
    );
    assert.equal(noViewBox.pass, false);
    assert.equal(noViewBox.census.image, 0);

    const report = buildValidationReport(reportInput({ gates: gates({ vector: noViewBox }) }));
    assert.equal(report.svgGate.zeroRasterEmbedded, false);
  });
});

describe('buildValidationReport — pack gate evidence', () => {
  it('carries the per-file dimension table, the ICO parse-back, and the ZIP manifest', () => {
    const report = buildValidationReport(reportInput());
    assert.deepEqual(
      report.dimensions.map((d) => d.file),
      ['logo-color-1024.png', 'favicon-16.png'],
    );
    assert.deepEqual(report.dimensions[0]!.actual, { width: 1024, height: 1024 });
    assert.deepEqual(report.dimensions[0]!.expected, { width: 1024, height: 1024 });
    assert.deepEqual(report.ico, { pass: true, sizes: [16, 32, 48], reason: null });
    assert.deepEqual(report.zip, {
      pass: true,
      manifest: ['logo.svg', 'brand.json'],
      missing: [],
      reasons: [],
    });
    assert.equal(report.gatesPass, true);
  });

  it('quotes a failing ICO reason instead of dropping it', () => {
    const report = buildValidationReport(
      reportInput({
        gates: gates({
          ico: { pass: false, sizes: [16], reason: 'entry table is missing size(s): 32, 48' },
          pass: false,
        }),
      }),
    );
    assert.equal(report.ico.pass, false);
    assert.match(report.ico.reason!, /missing size/);
    assert.equal(report.gatesPass, false);
  });
});

describe('buildValidationReport — moderation, caps, and idempotency keys', () => {
  it('names the pinned moderation vendor and the outage count', () => {
    const report = buildValidationReport(reportInput());
    assert.equal(report.moderation.input.vendor, MODERATION_VENDOR);
    assert.equal(report.moderation.input.model, MODERATION_MODEL);
    assert.equal(report.moderation.input.outageAttempts, 2);
    assert.match(report.moderation.input.auditTrail, /gate_audit/);
  });

  it('copies the authorizing screening verdict in verbatim, response body and all', () => {
    // Precondition: the fixture's verdict carries a nested vendor response, so
    // a report that copied only the top-level flags would visibly fail below
    // rather than pass on a verdict-shaped husk.
    assert.ok(MODERATION_VERDICT.response, 'the fixture must carry a vendor response body');

    const report = buildValidationReport(reportInput());
    assert.deepEqual(
      report.moderation.input.verdict,
      MODERATION_VERDICT,
      'the delivered report must stand alone as evidence — no pointer to D1',
    );
    // Named individually, because deepEqual against the same fixture object
    // would also pass if the report simply held a reference to it and every
    // field were later dropped from the type.
    const verdict = report.moderation.input.verdict!;
    assert.equal(verdict.flagged, false);
    assert.equal(verdict.checkedAt, '2026-07-30T11:58:00.000Z');
    assert.deepEqual((verdict.response as { results: unknown[] }).results, [
      {
        flagged: false,
        categories: { violence: false, hate: false },
        category_scores: { violence: 0.000012, hate: 0.0000034 },
      },
    ]);
  });

  it('carries a per-image unsafe-content snapshot for every concept the gate saw', () => {
    const report = buildValidationReport(reportInput());
    assert.equal(report.moderation.images.length, 2);
    assert.deepEqual(
      report.moderation.images.map((i) => i.slot),
      [1, 2],
    );
    for (const image of report.moderation.images) {
      assert.equal(image.unsafe, false);
      assert.ok(image.model.length > 0);
      assert.ok(image.checkedAt.length > 0, 'the snapshot is dated — vision models drift');
    }
  });

  it('reports caps consumed against the declared cap constants', () => {
    const report = buildValidationReport(
      reportInput({ spend: { conceptStageUsd: 0.18, vectorStageUsd: 0.2 } }),
    );
    assert.equal(report.caps.maxSpendUsd, MAX_SPEND_USD);
    assert.equal(report.caps.maxRegensPerSlot, MAX_REGENS_PER_SLOT);
    assert.equal(report.caps.conceptStageUsd, 0.18);
    assert.equal(report.caps.vectorStageUsd, 0.2);
    assert.equal(report.caps.spentUsd, 0.38, 'both stages, summed without float dust');
    assert.equal(report.caps.generationAttempts, 6, '1 + 2 + 3 across the three slots');
  });

  it('records both stage idempotency keys', () => {
    const report = buildValidationReport(reportInput());
    assert.deepEqual(report.idempotencyKeys, {
      concepts: 'abc:concepts',
      vector: 'abc:vector',
    });
  });

  it('records how the winner was vectorized and what it cost', () => {
    const report = buildValidationReport(reportInput());
    assert.deepEqual(report.vectorization, {
      source: 'recraft-native',
      vendor: 'recraft',
      costUsd: 0,
    });
  });
});

describe('summarizeInputScreening', () => {
  it('reports the LAST clear screening — the one that authorized generation', () => {
    // Stage 1 re-screens on every run, because a thread correction can change
    // the brief between them. A resumed job therefore has more than one clear
    // row, and the report must quote the screening the delivered concepts were
    // actually generated under, not the first one ever recorded.
    const superseded: ModerationVerdict = {
      ...MODERATION_VERDICT,
      checkedAt: '2026-07-30T09:00:00.000Z',
      response: { id: 'modr-stale' },
    };
    const screening = summarizeInputScreening([
      auditRow({ id: 1, result: 'clear', detail: superseded }),
      auditRow({ id: 2, result: 'unavailable', detail: { error: '503' } }),
      auditRow({ id: 3, result: 'clear', detail: MODERATION_VERDICT }),
    ]);
    assert.deepEqual(screening.verdict, MODERATION_VERDICT);
    assert.notDeepEqual(screening.verdict, superseded, 'the stale screening is not the record');
    assert.equal(screening.outageAttempts, 1);
  });

  it('counts vendor outages and reports no verdict when none ever cleared', () => {
    const screening = summarizeInputScreening([
      auditRow({ id: 1, result: 'unavailable', detail: { error: '503' } }),
      auditRow({ id: 2, result: 'unavailable', detail: { error: '503' } }),
    ]);
    assert.equal(screening.verdict, null);
    assert.equal(screening.outageAttempts, 2);
    // The pinned vendor is still named — that is a property of the bot, not of
    // any particular screening.
    assert.equal(screening.vendor, MODERATION_VENDOR);
  });

  it('refuses a clear row whose detail is not verdict-shaped', () => {
    // `GateAuditRow.detail` is `unknown` — the column holds whatever the
    // writing call passed. Anything that is not a full verdict must be skipped
    // rather than half-copied into a customer-facing evidence pack.
    const notVerdicts: unknown[] = [
      null,
      'clear',
      42,
      {},
      { vendor: 'openai' },
      { vendor: 'openai', model: 'm', flagged: false, checkedAt: 'now' }, // no response
      { vendor: 'openai', model: 'm', flagged: 'no', checkedAt: 'now', response: {} }, // wrong type
    ];
    for (const detail of notVerdicts) {
      const screening = summarizeInputScreening([auditRow({ id: 1, result: 'clear', detail })]);
      assert.equal(
        screening.verdict,
        null,
        `${JSON.stringify(detail)} was accepted as a moderation verdict`,
      );
    }
  });

  it('falls back to the last well-formed verdict when a later row is malformed', () => {
    const screening = summarizeInputScreening([
      auditRow({ id: 1, result: 'clear', detail: MODERATION_VERDICT }),
      auditRow({ id: 2, result: 'clear', detail: { vendor: 'openai' } }),
    ]);
    assert.deepEqual(screening.verdict, MODERATION_VERDICT);
  });

  it('ignores audit rows belonging to other gates', () => {
    const screening = summarizeInputScreening([
      auditRow({ id: 1, gate: 'ocr', result: 'unavailable', detail: { error: 'no image' } }),
      auditRow({ id: 2, gate: 'generation', result: 'unavailable', detail: { error: '503' } }),
      auditRow({ id: 3, gate: 'moderation', result: 'clear', detail: MODERATION_VERDICT }),
    ]);
    assert.equal(screening.outageAttempts, 0, 'an OCR outage is not a moderation outage');
    assert.deepEqual(screening.verdict, MODERATION_VERDICT);
  });
});

describe('buildValidationReport — serialization', () => {
  it('round-trips through JSON without losing a field', () => {
    const report = buildValidationReport(reportInput());
    const roundTripped = JSON.parse(JSON.stringify(report)) as typeof report;
    assert.deepEqual(roundTripped, report);
  });

  it('round-trips a report full of nulls and failures too', () => {
    const report = buildValidationReport(
      reportInput({
        concepts: [
          conceptRow({ phash: null, ocrModel: null, ocrTranscription: null, ocrScore: null }),
        ],
        visionChecks: [],
        moderationAudits: [],
        gates: gates({
          vector: checkTrueVector(RASTER_SVG),
          ico: { pass: false, sizes: [], reason: 'buffer did not parse as an ICO' },
          zip: {
            pass: false,
            present: [],
            missing: ['logo.svg'],
            reasons: ['buffer did not unzip'],
          },
          pass: false,
        }),
      }),
    );
    const roundTripped = JSON.parse(JSON.stringify(report)) as typeof report;
    assert.deepEqual(roundTripped, report);
    // A round-trip that silently dropped an `undefined` key would still
    // deep-equal, so pin the fields that would carry one.
    assert.equal(roundTripped.ico.reason, 'buffer did not parse as an ICO');
    assert.equal(roundTripped.concepts[0]!.ocr, null);
    assert.equal(roundTripped.moderation.input.verdict, null);
    assert.equal(roundTripped.winner.axisId, null, 'the winning slot is not in this fixture');
  });
});

describe('buildLicenseManifest', () => {
  const rows: LicenseRow[] = [
    { artifact: 'concept-1.png', vendor: 'ideogram', vendorRequestId: 'req-wordmark' },
    { artifact: 'concept-3.png', vendor: 'recraft', vendorRequestId: 'req-emblem' },
    { artifact: 'logo.svg', vendor: 'vectorizer', vendorRequestId: null },
  ];

  it('emits one entry per generated or converted image, with vendor, request id, scope and date', () => {
    const manifest = buildLicenseManifest(rows);
    assert.equal(manifest.entries.length, rows.length);
    for (const [index, row] of rows.entries()) {
      const entry = manifest.entries[index]!;
      assert.equal(entry.artifact, row.artifact);
      assert.equal(entry.vendor, row.vendor);
      assert.equal(entry.vendorRequestId, row.vendorRequestId);
      assert.equal(entry.scope, VENDOR_TERMS[row.vendor]!.scope);
      assert.equal(entry.verifiedOn, VENDOR_TERMS[row.vendor]!.verifiedOn);
      assert.ok(entry.scope.length > 0, 'every entry names the terms it was produced under');
    }
  });

  it('says so loudly while the Phase 0 terms-verification record does not exist', () => {
    // Precondition: this assertion is only meaningful while some vendor still
    // has no recorded date. When Phase 0 lands and every date is filled in,
    // this test must be flipped to the verified branch, not deleted.
    assert.ok(
      Object.values(VENDOR_TERMS).some((terms) => terms.verifiedOn === null),
      'VENDOR_TERMS now carries dates — update this test to the verified branch',
    );
    const manifest = buildLicenseManifest(rows);
    assert.match(manifest.note, /INCOMPLETE/);
    assert.match(manifest.note, /Phase 0/);
    assert.ok(
      manifest.entries.every((entry) => entry.verifiedOn === null),
      'and no entry claims a date it does not have',
    );
  });

  it('fails an unrecorded vendor closed rather than defaulting it permissive', () => {
    const manifest = buildLicenseManifest([
      { artifact: 'concept-1.png', vendor: 'some-new-vendor', vendorRequestId: 'req-1' },
    ]);
    assert.equal(manifest.entries[0]!.verifiedOn, null);
    assert.match(manifest.entries[0]!.scope, /UNRECORDED VENDOR/);
    assert.doesNotMatch(manifest.entries[0]!.scope, /commercial use and resale of the delivered/);
  });

  it('does not let an inherited Object property masquerade as a terms record', () => {
    for (const vendor of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const manifest = buildLicenseManifest([{ artifact: 'x.png', vendor, vendorRequestId: null }]);
      assert.match(
        manifest.entries[0]!.scope,
        /UNRECORDED VENDOR/,
        `${vendor} resolved to an inherited value instead of failing closed`,
      );
    }
  });

  it('round-trips through JSON', () => {
    const manifest = buildLicenseManifest(rows);
    assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);
  });
});
