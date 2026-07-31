// ---------------------------------------------------------------------------
// The delivered JSON validation report and per-image license manifest (§8,
// FR-17). Both are DISPUTE EVIDENCE, which drives every design choice here:
//
//   1. COMPLETENESS IS A TESTED PROPERTY, NOT A CONVENTION. §8 enumerates what
//      the report must carry — per-concept provenance, the pHash matrix, the
//      winner and how it was chosen, the SVG gate census, the dimension table,
//      the ICO parse-back, the ZIP manifest, moderation, caps, idempotency
//      keys. report.test.ts asserts each of them, so a field that quietly
//      stops being populated fails a test rather than shipping an evidence
//      pack with a hole in it.
//
//   2. EVERY VALUE IS JSON-ROUND-TRIPPABLE. No `undefined`, no `bigint`, no
//      `Date` — absent data is an explicit `null`. A report that does not
//      survive `JSON.parse(JSON.stringify(...))` is not evidence, it is a
//      lossy summary, and the round-trip is asserted directly.
//
//   3. NOTHING IS ASSERTED THAT WAS NOT MEASURED. The report never restates a
//      claim more strongly than the gate that produced it (see
//      `zeroRasterEmbedded`), and the license manifest refuses to name a
//      terms-verification date that no in-repo decision record backs — the
//      same rule pack/fonts.ts follows for font licences.
//
//   4. VENDOR LOOKUP IS AN ALLOW-LIST. An image from a vendor with no terms
//      record gets a loud "not attested" entry, never a default-permissive
//      one: enumerating the vendors we HAVE cleared fails closed, whereas
//      enumerating the ones we have not would fail open the moment a fourth
//      vendor is wired in.
//
// Pure functions only — no I/O, no clock, no bindings. `runVectorStage` in
// pipeline.ts reads the D1 records and hands them in.
// ---------------------------------------------------------------------------

import { MAX_REGENS_PER_SLOT, MAX_SPEND_USD } from './config.js';
import {
  fromHex,
  hammingDistance,
  type DimensionsResult,
  type IcoGateResult,
  type NodeCensus,
  type VectorGateResult,
  type ZipGateResult,
} from './gates/index.js';
import type { ConceptRow, GateAuditRow } from './jobs.js';
import { MODERATION_MODEL, MODERATION_VENDOR, type ModerationVerdict } from './moderation.js';
import type { PackGateReport } from './pack/index.js';
import type { SelectionSource } from './types.js';

// --- Validation report --------------------------------------------------------

/** The lettering-readback verdict as delivered (§9: the snapshot is the record). */
export interface ReportOcrSnapshot {
  model: string;
  transcription: string;
  score: number;
  pass: boolean;
}

export interface ReportConcept {
  slot: number;
  axisId: string;
  vendor: string;
  vendorRequestId: string | null;
  /**
   * Generation attempts this slot consumed (1 initial + up to
   * `MAX_REGENS_PER_SLOT` regenerations). Deliberately OUTSIDE `ocr` even
   * though §8 lists it inside the OCR snapshot's parenthetical: a slot that
   * burned attempts and never reached the vision model has an attempt count
   * and no verdict, and nesting it would drop that number exactly when a
   * shortfall dispute needs it most.
   */
  attemptsUsed: number;
  phash: string | null;
  ocr: ReportOcrSnapshot | null;
}

/**
 * The full pairwise pHash distance matrix (FR-6 evidence). Symmetric with a
 * zero diagonal by construction — `hammingDistance` is symmetric and every
 * cell is computed from the same parsed hashes — and `null` wherever a concept
 * carries no usable hash, so a missing measurement never reads as "distance 0".
 */
export interface PhashMatrix {
  slots: number[];
  distances: Array<Array<number | null>>;
}

export interface ReportWinner {
  slot: number;
  axisId: string | null;
  /** FR-9: a buyer thread reply, or the default-selection rule firing. */
  selectionSource: SelectionSource;
}

export interface ReportVectorization {
  /** `recraft-native` means the §13 single-vendor mitigation fired. */
  source: 'recraft-native' | 'vectorizer';
  vendor: string;
  costUsd: number;
}

export interface ReportSvgGate {
  pass: boolean;
  violations: string[];
  census: NodeCensus;
  /**
   * The §9 headline claim — "an SVG that wraps a raster fails, full stop" —
   * stated as its own field instead of left to be inferred from the census.
   *
   * Deliberately conjoined with the gate's own verdict. `census.image` counts
   * `<image>` ELEMENTS only, while a raster can also enter through a
   * `data:image/...` or `.png` reference on an otherwise legal element, and
   * only the full gate looks for those. Asserting raster-freedom on a gate
   * that did not pass would be a claim this report cannot back, so it is false
   * whenever the gate is false. The redundancy with `pass` is the point: the
   * assertion is never stronger than the evidence behind it.
   */
  zeroRasterEmbedded: boolean;
}

export type ReportDimension = { file: string } & DimensionsResult;

export interface ReportIco {
  pass: boolean;
  sizes: number[];
  reason: string | null;
}

export interface ReportZip {
  pass: boolean;
  /** The §8 "ZIP manifest": every entry the delivered archive actually holds. */
  manifest: string[];
  missing: string[];
  reasons: string[];
}

/** Per-image vision unsafe-content snapshot (§9's second moderation clause). */
export interface ReportImageModeration {
  slot: number;
  model: string;
  unsafe: boolean;
  checkedAt: string;
}

/**
 * The FR-2 pre-generation screening of the brand name and brief, summarized
 * from the concepts stage's D1 audit trail.
 *
 * The vendor's verdict is copied in VERBATIM, response body and all, rather
 * than referenced. The report is the evidence artifact: the buyer holding it
 * cannot query D1, and neither can a payer reading it during a dispute, so a
 * field that said "see `gate_audit`" would be evidence to nobody who needs it.
 * `auditTrail` still names where the full trail lives — that is a
 * cross-reference to the outage rows this summarizes, not a substitute for the
 * verdict itself.
 */
export interface ReportInputScreening {
  /** The vendor and model this bot pins for FR-2 screening. */
  vendor: string;
  model: string;
  /** Failed screening round-trips before generation started (FR-2 parking). */
  outageAttempts: number;
  verdict: ModerationVerdict | null;
  auditTrail: string;
}

export interface ReportModeration {
  input: ReportInputScreening;
  images: ReportImageModeration[];
}

export interface ReportCaps {
  maxSpendUsd: number;
  maxRegensPerSlot: number;
  /** Concept generation + winner vectorization, rounded to the cent-fraction. */
  spentUsd: number;
  conceptStageUsd: number;
  vectorStageUsd: number;
  generationAttempts: number;
}

/** FR-15 claim keys — one per stage, both quoted so a replay is traceable. */
export interface ReportIdempotencyKeys {
  concepts: string;
  vector: string;
}

export interface ValidationReport {
  version: 1;
  generatedAt: string;
  contractId: string;
  brandName: string;
  concepts: ReportConcept[];
  phashMatrix: PhashMatrix;
  winner: ReportWinner;
  vectorization: ReportVectorization;
  svgGate: ReportSvgGate;
  dimensions: ReportDimension[];
  ico: ReportIco;
  zip: ReportZip;
  moderation: ReportModeration;
  caps: ReportCaps;
  idempotencyKeys: ReportIdempotencyKeys;
  gatesPass: boolean;
}

export interface ReportInput {
  contractId: string;
  brandName: string;
  generatedAt: string;
  concepts: ConceptRow[];
  /** Read off the stage-1 checkpoint, which is the only store of the flag. */
  visionChecks: ReportImageModeration[];
  /** The concepts stage's FR-17 audit trail, for the FR-2 screening record. */
  moderationAudits: GateAuditRow[];
  winner: { slot: number; source: SelectionSource };
  vectorization: ReportVectorization;
  gates: PackGateReport;
  spend: { conceptStageUsd: number; vectorStageUsd: number };
  idempotencyKeys: ReportIdempotencyKeys;
}

/** Keep derived dollar sums free of float dust (mirrors pipeline.ts's roundUsd). */
const roundUsd = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * Parse a stored pHash, allow-listing the one form `toHex` produces. `fromHex`
 * is `BigInt('0x' + hex)`, which THROWS on anything else — so a single corrupt
 * column value would take down the whole report build. Failing that cell
 * closed to `null` keeps the rest of the evidence deliverable.
 */
function parsePhash(hex: string | null): bigint | null {
  if (hex === null || !/^[0-9a-f]{1,16}$/i.test(hex)) return null;
  return fromHex(hex);
}

/** The gate name stage 1 records its FR-2 screening under (pipeline.ts). */
const MODERATION_GATE = 'moderation';

const AUDIT_TRAIL_NOTE =
  'The full screening trail, including any vendor-outage rows this summarizes, is in D1 ' +
  'gate_audit under the concepts idempotency key recorded below.';

/**
 * Recognize a stored moderation verdict.
 *
 * `GateAuditRow.detail` is `unknown` by construction — the column holds
 * whatever the writing call passed it — so the shape is checked field by field
 * before any of it is copied into a customer-facing document. This is an
 * allow-list: a row that does not carry every field of a `ModerationVerdict` is
 * not a verdict, whatever else it may be, and is skipped rather than
 * half-copied into the evidence pack.
 */
function isModerationVerdict(value: unknown): value is ModerationVerdict {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.vendor === 'string' &&
    typeof candidate.model === 'string' &&
    typeof candidate.flagged === 'boolean' &&
    typeof candidate.checkedAt === 'string' &&
    'response' in candidate
  );
}

/**
 * The FR-2 screening section, summarized from the concepts stage's audit trail.
 *
 * The verdict reported is the LAST `clear` screening on the record. Stage 1
 * re-screens on every run — including resumes, because a thread correction can
 * change the brief between them — parks on an outage, and only proceeds past a
 * `clear`. So the last clear row is the one that actually authorized the
 * generation these concepts came from; earlier rows are outages, which are
 * counted rather than copied.
 *
 * Filters by gate itself rather than trusting the caller to have narrowed the
 * query, so handing it a whole job's trail is safe.
 */
export function summarizeInputScreening(rows: GateAuditRow[]): ReportInputScreening {
  const screenings = rows.filter((row) => row.gate === MODERATION_GATE);
  const authorizing = screenings.filter(
    (row) => row.result === 'clear' && isModerationVerdict(row.detail),
  );
  const verdict = authorizing.at(-1)?.detail as ModerationVerdict | undefined;
  return {
    vendor: MODERATION_VENDOR,
    model: MODERATION_MODEL,
    outageAttempts: screenings.filter((row) => row.result === 'unavailable').length,
    verdict: verdict ? { ...verdict } : null,
    auditTrail: AUDIT_TRAIL_NOTE,
  };
}

function buildPhashMatrix(concepts: ConceptRow[]): PhashMatrix {
  const parsed = concepts.map((concept) => parsePhash(concept.phash));
  return {
    slots: concepts.map((concept) => concept.slot),
    distances: parsed.map((a) =>
      parsed.map((b) => (a === null || b === null ? null : hammingDistance(a, b))),
    ),
  };
}

function toReportConcept(row: ConceptRow): ReportConcept {
  const hasOcr = row.ocrModel !== null && row.ocrTranscription !== null && row.ocrScore !== null;
  return {
    slot: row.slot,
    axisId: row.axisId,
    vendor: row.vendor,
    vendorRequestId: row.vendorRequestId,
    attemptsUsed: row.attemptsUsed,
    phash: row.phash,
    ocr: hasOcr
      ? {
          model: row.ocrModel as string,
          transcription: row.ocrTranscription as string,
          score: row.ocrScore as number,
          pass: row.ocrPass,
        }
      : null,
  };
}

function toReportSvgGate(vector: VectorGateResult): ReportSvgGate {
  return {
    pass: vector.pass,
    violations: [...vector.violations],
    census: { ...vector.census },
    zeroRasterEmbedded: vector.pass && vector.census.image === 0,
  };
}

function toReportZip(zip: ZipGateResult): ReportZip {
  return {
    pass: zip.pass,
    manifest: [...zip.present],
    missing: [...zip.missing],
    reasons: [...zip.reasons],
  };
}

const toReportIco = (ico: IcoGateResult): ReportIco => ({
  pass: ico.pass,
  sizes: [...ico.sizes],
  // `?? null` rather than passing the optional through: an own key holding
  // `undefined` does not survive JSON.stringify, and the round-trip is a
  // contract of this module.
  reason: ico.reason ?? null,
});

export function buildValidationReport(input: ReportInput): ValidationReport {
  const winnerRow = input.concepts.find((row) => row.slot === input.winner.slot);
  return {
    version: 1,
    generatedAt: input.generatedAt,
    contractId: input.contractId,
    brandName: input.brandName,
    concepts: input.concepts.map(toReportConcept),
    phashMatrix: buildPhashMatrix(input.concepts),
    winner: {
      slot: input.winner.slot,
      axisId: winnerRow?.axisId ?? null,
      selectionSource: input.winner.source,
    },
    vectorization: { ...input.vectorization },
    svgGate: toReportSvgGate(input.gates.vector),
    dimensions: input.gates.dimensions.map((entry) => ({
      file: entry.file,
      pass: entry.pass,
      actual: { ...entry.actual },
      expected: { ...entry.expected },
    })),
    ico: toReportIco(input.gates.ico),
    zip: toReportZip(input.gates.zip),
    moderation: {
      input: summarizeInputScreening(input.moderationAudits),
      images: input.visionChecks.map((check) => ({ ...check })),
    },
    caps: {
      maxSpendUsd: MAX_SPEND_USD,
      maxRegensPerSlot: MAX_REGENS_PER_SLOT,
      spentUsd: roundUsd(input.spend.conceptStageUsd + input.spend.vectorStageUsd),
      conceptStageUsd: input.spend.conceptStageUsd,
      vectorStageUsd: input.spend.vectorStageUsd,
      generationAttempts: input.concepts.reduce((sum, row) => sum + row.attemptsUsed, 0),
    },
    idempotencyKeys: { ...input.idempotencyKeys },
    gatesPass: input.gates.pass,
  };
}

// --- License manifest ---------------------------------------------------------

export interface VendorTerms {
  /** What this manifest asserts about the vendor's output. */
  scope: string;
  /** ISO date the terms were read, or null while no record backs a date. */
  verifiedOn: string | null;
}

export interface LicenseRow {
  /** The delivered file this provenance belongs to. */
  artifact: string;
  vendor: string;
  vendorRequestId: string | null;
}

export type LicenseEntry = LicenseRow & VendorTerms;

export interface LicenseManifest {
  version: 1;
  note: string;
  entries: LicenseEntry[];
}

/**
 * The vendors whose commercial/resale terms this bot has a place to record.
 *
 * `verifiedOn` is `null` for every one of them TODAY, and that is not an
 * oversight: PRD §14 Phase 0 makes "vendor commercial/resale terms verified
 * and recorded in-repo with the date" an ops precondition that blocks LISTING
 * the bot, not building it, and no such decision record exists in this repo
 * yet. Inventing a date would put an unverified legal assertion inside a
 * customer-facing deliverable — the exact thing pack/fonts.ts refuses to do
 * for font licences. When Phase 0 lands, fill the dates in here; the
 * manifest's own note stops warning as soon as every entry carries one.
 */
export const VENDOR_TERMS: Readonly<Record<string, VendorTerms>> = {
  ideogram: {
    scope: 'Ideogram 3.0 API image generation — commercial use and resale of the delivered mark',
    verifiedOn: null,
  },
  recraft: {
    scope:
      'Recraft V3 API image generation and native SVG vector export — commercial use and resale ' +
      'of the delivered mark',
    verifiedOn: null,
  },
  flux: {
    scope: 'FLUX.2 [klein] via Workers AI (free taster only) — commercial use of the hosted output',
    verifiedOn: null,
  },
  vectorizer: {
    scope: 'Vectorizer.ai raster-to-vector conversion of an image we already hold rights to',
    verifiedOn: null,
  },
};

/**
 * The fail-closed entry for a vendor with no record at all. Reached only if an
 * image is ever produced by a vendor nobody added to `VENDOR_TERMS` — which is
 * precisely when a silent permissive default would be most expensive.
 */
const UNRECORDED_VENDOR: VendorTerms = {
  scope:
    'UNRECORDED VENDOR — no commercial/resale terms record exists for this vendor id, so nothing ' +
    'is attested about reusing this image',
  verifiedOn: null,
};

const VERIFIED_NOTE =
  'Every generated or converted image below names the vendor that produced it, the vendor-side ' +
  'request id identifying that exact generation, the terms scope it was produced under, and the ' +
  'date those terms were read.';

const UNVERIFIED_NOTE =
  'INCOMPLETE: one or more entries below carry no terms-verification date. The vendor ' +
  'commercial/resale terms verification (PRD §14, Phase 0) has no in-repo decision record yet, ' +
  'so this manifest names the vendor and the request id for every image but does NOT attest ' +
  'that those resale terms were read. Every entry with `verifiedOn: null` is unattested.';

/**
 * One entry per generated or converted image, with the terms scope resolved
 * from the allow-list above.
 *
 * `Object.hasOwn` rather than a bare lookup for the same reason index.ts's
 * `resolveDeliverable` uses it: `VENDOR_TERMS` is an object literal, so a
 * vendor id of `constructor` or `toString` would otherwise return a truthy
 * INHERITED value and sail past a falsy check instead of landing on
 * `UNRECORDED_VENDOR`.
 */
export function buildLicenseManifest(rows: LicenseRow[]): LicenseManifest {
  const entries: LicenseEntry[] = rows.map((row) => {
    const terms = Object.hasOwn(VENDOR_TERMS, row.vendor)
      ? (VENDOR_TERMS[row.vendor] as VendorTerms)
      : UNRECORDED_VENDOR;
    return {
      artifact: row.artifact,
      vendor: row.vendor,
      vendorRequestId: row.vendorRequestId,
      scope: terms.scope,
      verifiedOn: terms.verifiedOn,
    };
  });
  const complete = entries.length > 0 && entries.every((entry) => entry.verifiedOn !== null);
  return { version: 1, note: complete ? VERIFIED_NOTE : UNVERIFIED_NOTE, entries };
}
