// ---------------------------------------------------------------------------
// Calibration harness (§13/§14/§15) — freezes OCR_SIMILARITY_THRESHOLD and
// MIN_PHASH_HAMMING against evidence rather than intuition.
//
// This module is CODE because §14 requires a golden-set regression run every
// time the pinned vision model version changes; running it for real against
// live vendors is an OPS procedure (see README.md), not something this file
// does on its own — `runCalibration` takes every vendor call as an injected
// dependency and never reaches for a live key itself.
//
// WHAT "known-good" AND "known-bad" MEAN HERE. There is no way to get
// human-labelled ground truth for "is this specific vendor-generated image
// garbled" without a person looking at it, and that is not automatable. So
// each generated image is checked TWICE against the SAME OCR gate real
// production code path (`createOcrGate(...).check`) with two different
// target names:
//
//   - "known-good": checked against the brand name it was actually generated
//     for — the exact comparison the real pipeline performs. Its pass rate
//     IS the real "stylized-but-legible pass rate" §13 asks for, measured
//     over real generations spanning plain-to-ornate names on all three
//     style axes (`gates/phash.test.ts` makes the same call for the pHash
//     side: "real vendor images are broadband, and the Phase-2 calibration
//     validates the threshold on real batches").
//   - "known-bad": the SAME image, checked against `buildMismatchName(name)`
//     — a name we KNOW is wrong, by construction, independent of whatever
//     the image actually shows. Its correct-rejection rate is a proxy for
//     "if a vendor rendered garbled or wrong lettering, would this threshold
//     catch it" — the harness cannot force a vendor to garble text on
//     demand, but it CAN guarantee a mismatched comparison and measure
//     whether the gate correctly says no.
//
// Both checks run `n` times per image (default 5) because the vision model
// is nondeterministic even at temperature 0 (`gates/ocr.ts`'s own docstring)
// — repeatability, not just a single score, is what tells you whether a
// threshold is living dangerously close to the model's run-to-run noise
// floor. An image whose repeat runs land on both sides of the threshold is
// flagged `unstable`; that instability, not the mean, is the §13 drift risk.
//
// THE OCR CANARY MATTERS HERE TOO. `createOcrGate` returns `status:
// 'unavailable'` (never a verdict) when `usage.prompt_tokens` proves the
// image never reached the model. A run in that state carries no score and
// must never be counted as a pass OR a fail — `summarize` below excludes it
// from every rate, and an image with ZERO usable runs on either side blocks
// the freeze recommendation rather than silently reading as "fine".
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_AXES, buildAxisPrompt } from '../axes.js';
import { MIN_PHASH_HAMMING, OCR_SIMILARITY_THRESHOLD } from '../config.js';
import type { Generator } from '../generate.js';
import {
  fromHex,
  hammingDistance,
  normalizeForMatch,
  perceptualHash,
  readPngDimensions,
  sanitizeSvg,
  toHex,
  type OcrGate,
} from '../gates/index.js';
import { renderSvgToPixmap, renderSvgToPng } from '../pack/render.js';
import type { WasmSources } from '../pack/wasm.js';
import type { LogoBrief, Pixmap, StyleAxis } from '../types.js';

// --- Golden set ----------------------------------------------------------

export interface GoldenName {
  name: string;
  /** Operator-facing: why this entry is in the set (which hard case it covers). */
  note?: string;
}

const GOLDENS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'goldens.json');

/**
 * Read from disk rather than a static JSON import: this project's tsconfig
 * does not set `resolveJsonModule` (NodeNext, verified against
 * `tsconfig.base.json`), and this module never ships in the Worker bundle —
 * it is ops/test-only, exactly like `testSupport.ts`'s migration reader,
 * which this mirrors.
 */
function loadGoldenNames(): GoldenName[] {
  const raw = JSON.parse(readFileSync(GOLDENS_PATH, 'utf8')) as GoldenName[];
  return raw;
}

export const GOLDEN_NAMES: GoldenName[] = loadGoldenNames();

/** Neutral, constant across every golden entry — the axis being calibrated is lettering legibility, not industry framing. */
const GENERIC_INDUSTRY = 'general goods and services';

// --- Known-bad construction ------------------------------------------------

/**
 * Per-character Caesar-style shift over the two alphabets `normalizeForMatch`
 * can leave behind (lowercase ASCII letters and digits — diacritics,
 * punctuation and whitespace are already gone by the time this runs).
 *
 * A shift of 5, with NO reordering step, is deliberate — not an arbitrary
 * choice. An EARLIER draft of this function used an Atbash substitution
 * (a<->z, b<->y, ...) combined with a reversal, and that combination has a
 * real bug: Atbash is its own inverse, so for a short input built entirely
 * from one Atbash pair (e.g. "az": a<->z makes it "za", and reversing "za"
 * gives back "az" EXACTLY) the two transforms cancel and the "mismatch"
 * equals the original. Shifting by 5 has no fixed point on either alphabet
 * (5 is not a multiple of 26, nor of 10, so no character maps to itself),
 * so every position still differs from the original — but the fix that
 * actually matters is dropping the reversal: with no reordering step, there
 * is nothing left to cancel the per-character change, regardless of whether
 * the shift itself happens to be its own inverse (it is, on the 10-digit
 * alphabet alone — 5+5=10 — which is exactly why pairing it with a reversal
 * would reopen the same hole). `harness.test.ts` measures this — including
 * the exact adversarial inputs that broke the earlier design — rather than
 * trusting this reasoning alone.
 */
function shiftChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 97 && code <= 122) return String.fromCharCode(((code - 97 + 5) % 26) + 97);
  if (code >= 48 && code <= 57) return String.fromCharCode(((code - 48 + 5) % 10) + 48);
  return ch;
}

/**
 * A marker suffix that nothing in `GOLDEN_NAMES` ends with. This is the
 * PRIMARY guarantee the mismatch stays far from the original, on much firmer
 * ground than the character shift above: Levenshtein distance between two
 * strings is always >= the difference in their lengths, so appending these
 * 14 characters puts a floor of 14 under the edit distance — ALWAYS, for any
 * input, in any script. That raw floor is unconditional.
 *
 * What is NOT unconditional: the `<0.5` similarity RATIO this module's own
 * tests check for. `shiftChar` is a no-op outside `a-z`/`0-9`, so for a name
 * built entirely from characters outside that range (e.g. Cyrillic, CJK),
 * the shift contributes nothing and only the 14-character marker diverges —
 * measured directly, a 20-character Cyrillic name yields
 * `similarity = 0.588`, ABOVE the harness's own 0.5 bar (14 / (20+14) ≈
 * 0.412 edit-distance ratio, i.e. 0.588 similarity). This does not threaten
 * the shipped `GOLDEN_NAMES` fixture (every entry measures 0.00–0.17, per
 * `harness.test.ts`) because every entry is Latin-script, where the shift
 * genuinely scrambles the content too — but it means the `<0.5` guarantee
 * is proven for Latin-script names under roughly 40 characters, not for
 * "any name under ~50 characters" as an earlier draft of this comment
 * claimed. `harness.test.ts` enforces the Latin-script precondition on
 * `GOLDEN_NAMES` directly (matching `isLatinScript` in `../brief.ts`, this
 * bot's own intake rule) so that precondition stays load-bearing rather
 * than assumed.
 */
const MISMATCH_MARKER = 'zqxvwkmismatch';

/**
 * A deterministic "definitely the wrong name" target for the known-bad OCR
 * check. Not a claim that this is what a garbled vendor render would say —
 * see the module header — only that checking a real image against this
 * target is a REAL, unstaged exercise of the gate's rejection path.
 */
export function buildMismatchName(name: string): string {
  const normalized = normalizeForMatch(name);
  const shifted = [...normalized].map(shiftChar).join('');
  return `${shifted}${MISMATCH_MARKER}`;
}

// --- Calibration run shapes --------------------------------------------------

export type CalibrationRun = { status: 'ok'; score: number } | { status: 'unavailable' };

export interface CalibrationCheck {
  targetName: string;
  runs: CalibrationRun[];
}

export interface CalibrationImageResult {
  name: string;
  axisId: string;
  vendor: string;
  /** null when the generated bytes could not be decoded to a pixmap. */
  phash: string | null;
  knownGood: CalibrationCheck;
  knownBad: CalibrationCheck;
}

export interface CalibrationGenerationFailure {
  name: string;
  axisId: string;
  error: string;
}

export interface CalibrationReport {
  generatedAt: string;
  runsPerImage: number;
  goldenCount: number;
  imageCount: number;
  results: CalibrationImageResult[];
  generationFailures: CalibrationGenerationFailure[];
  summary: CalibrationSummary;
}

export const DEFAULT_RUNS_PER_IMAGE = 5;

export interface CalibrationDeps {
  generator: Generator;
  ocrGate: OcrGate;
  /** Once-per-isolate wasm sources for the pHash decode path (see pack/wasm.ts). */
  sources: WasmSources;
  /** Defaults to `GOLDEN_NAMES`. Overridable so tests can run a tiny subset. */
  golden?: GoldenName[];
  /** Defaults to `DEFAULT_AXES` (wordmark/lockup/emblem) — the three paid style axes. */
  axes?: readonly StyleAxis[];
  /** How many times to repeat each OCR check per image. Default 5. */
  runsPerImage?: number;
  ocrThreshold?: number;
  minGoldenNames?: number;
  now?: () => Date;
}

/** Concepts are generated at this edge everywhere else in the pipeline (§8: >=1024px) — mirrored here for realism. */
const CONCEPT_PX = 1024;

/** Matches pipeline.ts's PHASH_DECODE_PX: every image travels the identical decode path so distances stay like-for-like. */
const PHASH_DECODE_PX = 256;

/** base64 for Workers-shaped code (no Buffer): chunked to avoid the spread-arg limit. Mirrors the identical helper in gates/ocr.ts and pipeline.ts. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Decode an encoded PNG to a pixmap for the pHash calculation — the same
 * "wrap a data: PNG in a one-element SVG and let resvg decode it" trick
 * `pipeline.ts` uses (Workers has no canvas/ImageBitmap). Duplicated rather
 * than imported: `pipeline.ts` does not export its version, and this is only
 * the SECOND consumer of the trick (pipeline.ts is the first) — the plan's
 * own extraction rule for this codebase is a THIRD consumer, so this stays
 * local. Returns null for undecodable bytes rather than throwing: a
 * malformed vendor asset is a calibration data point (recorded as a missing
 * phash), not a crash.
 */
async function decodePngToPixmap(png: Uint8Array, sources: WasmSources): Promise<Pixmap | null> {
  const dimensions = readPngDimensions(png);
  if (!dimensions) return null;
  const { width, height } = dimensions;
  const wrapper =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<image width="${width}" height="${height}" href="data:image/png;base64,${toBase64(png)}"/>` +
    `</svg>`;
  return renderSvgToPixmap(wrapper, PHASH_DECODE_PX, sources);
}

async function runRepeatedChecks(
  gate: OcrGate,
  png: Uint8Array,
  targetName: string,
  n: number,
): Promise<CalibrationRun[]> {
  const runs: CalibrationRun[] = [];
  for (let i = 0; i < n; i++) {
    // Sequential by design: n repeats of the SAME image measure run-over-run
    // model repeatability, which a Promise.all would not change (each call
    // is independent) but would make harder to reason about under a shared
    // rate limit against a real vendor.
    const outcome = await gate.check(png, targetName);
    runs.push(
      outcome.status === 'ok'
        ? { status: 'ok', score: outcome.verdict.score }
        : { status: 'unavailable' },
    );
  }
  return runs;
}

/**
 * Generate every (golden name, style axis) image, check it `n` times each
 * against its own name and against a deliberate mismatch, and roll the
 * result into a `CalibrationSummary`.
 *
 * Never throws for a single vendor failure — a generation failure is
 * recorded in `generationFailures` and that (name, axis) combination is
 * simply absent from `results`, so one bad vendor call does not lose the
 * rest of an expensive, real-money calibration run.
 */
export async function runCalibration(deps: CalibrationDeps): Promise<CalibrationReport> {
  const golden = deps.golden ?? GOLDEN_NAMES;
  const axes = deps.axes ?? DEFAULT_AXES;
  const runsPerImage = deps.runsPerImage ?? DEFAULT_RUNS_PER_IMAGE;
  const now = deps.now ?? ((): Date => new Date());

  const results: CalibrationImageResult[] = [];
  const generationFailures: CalibrationGenerationFailure[] = [];

  for (const entry of golden) {
    const brief: LogoBrief = { brandName: entry.name, industry: GENERIC_INDUSTRY };
    const mismatchName = buildMismatchName(entry.name);

    for (const axis of axes) {
      const prompt = buildAxisPrompt(brief, axis);
      const generated = await deps.generator.generate(axis, prompt);
      if (!generated.ok) {
        generationFailures.push({ name: entry.name, axisId: axis.id, error: generated.error });
        continue;
      }

      // Recraft's vector-native return carries an empty png and the SVG
      // instead (generate.ts) — rasterize it here exactly as pipeline.ts
      // does, so the 'emblem' axis is measured on a real raster like the
      // other two, not silently skipped.
      let png = generated.concept.png;
      if (png.length === 0 && generated.concept.nativeSvg) {
        const svg = sanitizeSvg(generated.concept.nativeSvg);
        png = await renderSvgToPng(svg, CONCEPT_PX, deps.sources);
      }
      if (png.length === 0) {
        generationFailures.push({
          name: entry.name,
          axisId: axis.id,
          error: 'vendor returned neither raster nor vector bytes',
        });
        continue;
      }

      const pixmap = await decodePngToPixmap(png, deps.sources);
      const phash = pixmap ? toHex(perceptualHash(pixmap)) : null;

      const knownGoodRuns = await runRepeatedChecks(deps.ocrGate, png, entry.name, runsPerImage);
      const knownBadRuns = await runRepeatedChecks(deps.ocrGate, png, mismatchName, runsPerImage);

      results.push({
        name: entry.name,
        axisId: axis.id,
        vendor: axis.vendor,
        phash,
        knownGood: { targetName: entry.name, runs: knownGoodRuns },
        knownBad: { targetName: mismatchName, runs: knownBadRuns },
      });
    }
  }

  const summary = summarize(results, {
    ocrThreshold: deps.ocrThreshold,
    minGoldenNames: deps.minGoldenNames,
  });

  return {
    generatedAt: now().toISOString(),
    runsPerImage,
    goldenCount: golden.length,
    imageCount: results.length,
    results,
    generationFailures,
    summary,
  };
}

// --- Summary ------------------------------------------------------------------

export interface UnstableCheck {
  name: string;
  axisId: string;
  label: 'known-good' | 'known-bad';
  scores: number[];
}

export interface AxisRegenBurn {
  /** Distinct golden NAMES with usable known-good evidence on this axis — not a raw check count (see `nameWeightedRate`). */
  considered: number;
  /** Name-weighted fraction of considered names whose own known-good check(s) on this axis did NOT pass — a proxy for how often this axis would burn an FR-5 regeneration. null when nothing usable was measured. */
  failRate: number | null;
}

export interface PhashDistribution {
  min: number;
  median: number;
  p10: number;
  pairCount: number;
}

export interface CalibrationSummary {
  goldenCount: number;
  imageCount: number;
  ocrThreshold: number;
  phashThreshold: number;
  /** Name-weighted fraction of known-bad checks with usable data that correctly scored BELOW threshold. null when nothing was usable. */
  garbledDetectionRate: number | null;
  /** Distinct names contributing usable known-bad evidence — NOT a raw check count. */
  garbledConsidered: number;
  /** Name-weighted fraction of known-good checks with usable data that scored AT OR ABOVE threshold. null when nothing was usable. */
  stylizedPassRate: number | null;
  /** Distinct names contributing usable known-good evidence — NOT a raw check count. */
  stylizedConsidered: number;
  /** Every check's full detail (mean, variance, pass, unstable) — the literal "reports per-image score variance" requirement. `unstableChecks` below is a filtered view of this same data. */
  checks: CheckSummary[];
  unstableChecks: UnstableCheck[];
  regenBurnByAxis: Record<string, AxisRegenBurn>;
  /** null when fewer than two images share a golden name (no pair to measure) — this ALSO blocks `canFreeze`, since MIN_PHASH_HAMMING cannot be evaluated without it. */
  phash: PhashDistribution | null;
  /** True only when the evidence is sufficient and trustworthy for BOTH frozen constants (OCR_SIMILARITY_THRESHOLD and MIN_PHASH_HAMMING) AND the measured rates clear `minAcceptableRate`. */
  canFreeze: boolean;
  /** Why `canFreeze` is false; empty when true. */
  blockers: string[];
}

export interface SummarizeOptions {
  ocrThreshold?: number;
  phashThreshold?: number;
  /**
   * §14: the golden set must hold at least this many distinct names before a
   * freeze recommendation is even considered. Default AND absolute floor is
   * 30 — this option can only RAISE the bar, never lower it. An option is a
   * caller-supplied number with no bound of its own; if lowering it below 30
   * actually worked, `summarize([], { minGoldenNames: 0 })` would report
   * `canFreeze: true` on zero evidence, which is exactly the failure mode
   * this whole function exists to prevent. See `resolveMinGoldenNames`.
   */
  minGoldenNames?: number;
  /**
   * Below this, `garbledDetectionRate` or `stylizedPassRate` blocks the
   * freeze recommendation even when the evidence itself is otherwise clean
   * (enough names, nothing unstable) — the brief's four listed checks gate
   * whether the EVIDENCE can be trusted, not whether the MEASURED rate is
   * any good; a harness that stayed silent on a genuinely bad rate here
   * would only ever confirm a threshold, never report one as wrong. Default
   * 0.9 — a judgement call, not a value handed down by the brief, and
   * therefore deliberately overridable rather than hardcoded silently.
   *
   * Must lie in `(0, 1]` to mean anything — `0` or a negative value would
   * make `rate < minAcceptableRate` false for every real rate, silently
   * disabling this exact safety net. A value outside `(0, 1]` is treated as
   * absent and falls back to the default rather than being honoured; see
   * `resolveMinAcceptableRate`. A caller CAN still legitimately loosen this
   * to something like `0.5` — that is a real, meaningful bar, not a
   * degenerate attempt to switch the check off.
   */
  minAcceptableRate?: number;
}

const DEFAULT_MIN_GOLDEN_NAMES = 30;
const DEFAULT_MIN_ACCEPTABLE_RATE = 0.9;

/**
 * Options may TIGHTEN this gate, never LOOSEN it — the same allow-list shape
 * this session has already applied to a parser, a reference check, and a
 * quota: `Math.max` against the real floor means a caller can raise the bar
 * (`minGoldenNames: 50`) but a value at or below 30 has NO EFFECT, because
 * `Math.max(anything <= 30, 30) === 30`. There is deliberately no code path
 * by which a `SummarizeOptions` value can make this number smaller than 30.
 */
function resolveMinGoldenNames(requested: number | undefined): number {
  return Math.max(requested ?? DEFAULT_MIN_GOLDEN_NAMES, DEFAULT_MIN_GOLDEN_NAMES);
}

/**
 * Unlike `minGoldenNames`, a caller MAY legitimately loosen this below the
 * default 0.9 (it is a judgement call this module introduced, not a brief
 * requirement) — but only to another value that still MEANS something. `0`
 * or a negative number would make `rate < minAcceptableRate` false for
 * every real rate in `[0, 1]`, silently switching the whole safety net off;
 * anything above `1` would make it true for every real rate, which is just
 * as degenerate the other way. A value outside `(0, 1]` is therefore not a
 * looser bar — it isn't a bar at all — so it is treated as not having been
 * supplied, and the safe default is used instead.
 */
function resolveMinAcceptableRate(requested: number | undefined): number {
  if (typeof requested === 'number' && requested > 0 && requested <= 1) return requested;
  return DEFAULT_MIN_ACCEPTABLE_RATE;
}

/**
 * Full per-check detail — one entry per `(name, axisId, label)` triple,
 * covering EVERY check, not just the unstable ones (`unstableChecks` is a
 * filtered view of this same data). This is the literal "reports per-image
 * score variance" half of the brief's requirement 2: the mean/variance/pass
 * verdict for every check is inspectable here, not just implied by whether
 * it happens to be flagged unstable.
 */
export interface CheckSummary {
  name: string;
  axisId: string;
  label: 'known-good' | 'known-bad';
  scores: number[];
  usableRuns: number;
  unavailableRuns: number;
  meanScore: number | null;
  variance: number | null;
  pass: boolean | null;
  unstable: boolean;
}

function popVariance(values: number[]): number {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
}

/**
 * A `status: 'ok'` run whose `score` is not a finite number (NaN, +/-Infinity
 * — reachable only through a malformed upstream call or a hostile fixture,
 * never through `gates/ocr.ts`'s own `similarity()`, which cannot produce
 * one) is treated as carrying NO usable evidence, exactly like an
 * `unavailable` run — never as a pass or a fail.
 *
 * This is not defensive theatre: `NaN >= threshold` and `NaN < threshold`
 * are BOTH `false` in JavaScript, so a single non-finite score silently
 * turns an entire check's MEAN into `NaN`, and `NaN >= threshold` evaluates
 * to `pass: false` — which a "known-bad" check reads as "correctly
 * detected". A obvious false-accept (four real scores at 0.95, one NaN)
 * would therefore report as a clean detection instead of the miss it is.
 * `gates/ocr.ts`'s own `MIN_VISION_PROMPT_TOKENS` canary carries the same
 * `Number.isFinite` guard for exactly this class of bug — see its comment
 * on why `typeof x === 'number'` alone does not close it (`typeof NaN ===
 * 'number'` is `true`).
 */
function statsFor(
  name: string,
  axisId: string,
  label: 'known-good' | 'known-bad',
  check: CalibrationCheck,
  threshold: number,
): CheckSummary {
  const scores = check.runs
    .filter(
      (run): run is { status: 'ok'; score: number } =>
        run.status === 'ok' && Number.isFinite(run.score),
    )
    .map((run) => run.score);
  const usableRuns = scores.length;
  const unavailableRuns = check.runs.length - usableRuns;
  const meanScore = usableRuns > 0 ? scores.reduce((sum, v) => sum + v, 0) / usableRuns : null;
  const variance = usableRuns > 1 ? popVariance(scores) : usableRuns === 1 ? 0 : null;
  const pass = meanScore === null ? null : meanScore >= threshold;
  const unstable =
    usableRuns >= 2 && scores.some((s) => s >= threshold) && scores.some((s) => s < threshold);
  return {
    name,
    axisId,
    label,
    scores,
    usableRuns,
    unavailableRuns,
    meanScore,
    variance,
    pass,
    unstable,
  };
}

/** Nearest-rank percentile over an ALREADY sorted-ascending, non-empty array. */
function percentile(sortedAscending: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
  return sortedAscending[index]!;
}

/**
 * Pairwise Hamming distances WITHIN each golden name's set of axis images —
 * mirroring exactly what `checkDistinctness` compares in production (three
 * concepts from ONE job), not every image against every other image in the
 * whole golden set. A cross-name comparison ("Acme"'s wordmark vs
 * "Zephyr"'s emblem) is not a comparison the real gate ever performs.
 */
function buildPhashSummary(results: CalibrationImageResult[]): PhashDistribution | null {
  const byName = new Map<string, string[]>();
  for (const result of results) {
    if (result.phash === null) continue;
    const hashes = byName.get(result.name) ?? [];
    hashes.push(result.phash);
    byName.set(result.name, hashes);
  }

  const distances: number[] = [];
  for (const hashes of byName.values()) {
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        distances.push(hammingDistance(fromHex(hashes[i]!), fromHex(hashes[j]!)));
      }
    }
  }
  if (distances.length === 0) return null;

  const sorted = [...distances].sort((a, b) => a - b);
  return {
    min: sorted[0]!,
    median: percentile(sorted, 50),
    p10: percentile(sorted, 10),
    pairCount: sorted.length,
  };
}

/**
 * Average a boolean outcome ACROSS DISTINCT NAMES, not across checks.
 *
 * Weighting by raw check count is exploitable: a `summarize` caller (or a
 * fixture with an accidental duplicate) that supplies one name a thousand
 * times drowns out every other name in the aggregate. Concretely: 29 names
 * each contributing one FAILED known-bad check, plus one name contributing
 * a thousand PASSING duplicates, yields a check-weighted rate of
 * `1000 / 1029 ~= 0.972` — reading as "the gate works great" while 29 of 30
 * real names (96.7%) got it completely wrong. Averaging each DISTINCT
 * name's own local rate first, THEN averaging across names, gives every
 * name equal weight regardless of how many checks (duplicate or otherwise)
 * it happens to carry: the same scenario reports `~0.033`. For the normal,
 * well-formed case every real `runCalibration` run produces — one check per
 * `(name, axis)` pair, no duplicates — this is mathematically IDENTICAL to
 * a plain check-weighted average (a per-group average of equal-sized groups
 * equals the average of the whole), so it changes nothing for a real
 * calibration run and only matters against the duplication attack.
 */
function nameWeightedRate(
  stats: CheckSummary[],
  isSuccess: (stat: CheckSummary) => boolean,
): { rate: number | null; consideredNames: number } {
  const byName = new Map<string, CheckSummary[]>();
  for (const stat of stats) {
    if (stat.pass === null) continue; // no usable evidence from this specific check
    const list = byName.get(stat.name) ?? [];
    list.push(stat);
    byName.set(stat.name, list);
  }
  const perNameRates: number[] = [];
  for (const list of byName.values()) {
    const successCount = list.filter(isSuccess).length;
    perNameRates.push(successCount / list.length);
  }
  if (perNameRates.length === 0) return { rate: null, consideredNames: 0 };
  const rate = perNameRates.reduce((sum, r) => sum + r, 0) / perNameRates.length;
  return { rate, consideredNames: perNameRates.length };
}

function buildRegenBurn(knownGoodStats: CheckSummary[]): Record<string, AxisRegenBurn> {
  const byAxis = new Map<string, CheckSummary[]>();
  for (const stat of knownGoodStats) {
    const list = byAxis.get(stat.axisId) ?? [];
    list.push(stat);
    byAxis.set(stat.axisId, list);
  }
  const out: Record<string, AxisRegenBurn> = {};
  for (const [axisId, statsForAxis] of byAxis) {
    // Same duplication hazard as the top-level rates, scoped to one axis:
    // weight by distinct name within the axis, not by raw check count.
    const { rate, consideredNames } = nameWeightedRate(statsForAxis, (s) => s.pass === false);
    out[axisId] = { considered: consideredNames, failRate: rate };
  }
  return out;
}

/**
 * The testable core (§14/§15). Pure — no I/O, no clock — so it can be fed
 * fixture results directly, and re-run against a DIFFERENT candidate
 * threshold without paying for another vendor call: raw scores are always
 * carried on each run, and pass/fail is derived here, not baked in at
 * generation time.
 */
export function summarize(
  results: CalibrationImageResult[],
  options: SummarizeOptions = {},
): CalibrationSummary {
  const ocrThreshold = options.ocrThreshold ?? OCR_SIMILARITY_THRESHOLD;
  const phashThreshold = options.phashThreshold ?? MIN_PHASH_HAMMING;
  // Both resolvers are unconditional invariants, not passthroughs: an option
  // may tighten either gate, never loosen it below the real floor. See each
  // resolver's own comment for exactly what "loosen" would have meant here.
  const minGoldenNames = resolveMinGoldenNames(options.minGoldenNames);
  const minAcceptableRate = resolveMinAcceptableRate(options.minAcceptableRate);

  const goldenNames = new Set(results.map((r) => r.name));

  const knownGoodStats = results.map((r) =>
    statsFor(r.name, r.axisId, 'known-good', r.knownGood, ocrThreshold),
  );
  const knownBadStats = results.map((r) =>
    statsFor(r.name, r.axisId, 'known-bad', r.knownBad, ocrThreshold),
  );

  // Name-weighted, not check-weighted (C2) — see `nameWeightedRate`'s own
  // comment for why raw check counting is exploitable by duplication.
  const stylized = nameWeightedRate(knownGoodStats, (s) => s.pass === true);
  // A known-bad check is correctly rejected when it scores BELOW threshold
  // (pass === false, since `pass` here means "scored at/above threshold").
  const garbled = nameWeightedRate(knownBadStats, (s) => s.pass === false);
  const stylizedPassRate = stylized.rate;
  const stylizedConsidered = stylized.consideredNames;
  const garbledDetectionRate = garbled.rate;
  const garbledConsidered = garbled.consideredNames;

  const allStats = [...knownGoodStats, ...knownBadStats];
  const unstable = allStats.filter((s) => s.unstable);
  const inconclusive = allStats.filter((s) => s.usableRuns === 0);
  // A check with exactly one usable run HAS evidence (unlike `inconclusive`
  // above, which has none) but not enough to tell whether repeat runs
  // straddle the threshold — `unstable` requires `usableRuns >= 2` by
  // construction, so with `runsPerImage: 1` (or an OCR outage leaving every
  // check at one usable run) NO check could EVER be flagged unstable, and
  // the drift-risk signal this calibration exists to catch goes silently
  // dark rather than reading as "checked and found stable".
  const insufficientRunsForInstability = allStats.filter((s) => s.usableRuns === 1);

  const regenBurnByAxis = buildRegenBurn(knownGoodStats);
  const phash = buildPhashSummary(results);

  const blockers: string[] = [];
  // Unconditional: no option can waive this. `goldenNames.size < minGoldenNames`
  // below already implies this whenever minGoldenNames holds its floor, but a
  // second, independent check costs nothing and does not rely on that other
  // check never regressing.
  if (results.length === 0) {
    blockers.push(
      'no results were provided — cannot recommend freezing anything against zero evidence',
    );
  }
  if (goldenNames.size < minGoldenNames) {
    blockers.push(
      `golden set has ${goldenNames.size} distinct name(s), below the required minimum of ${minGoldenNames}`,
    );
  }
  if (unstable.length > 0) {
    blockers.push(
      `${unstable.length} image check(s) are unstable (repeat runs straddle the threshold): ` +
        unstable.map((s) => `${s.name}/${s.axisId}/${s.label}`).join(', '),
    );
  }
  if (inconclusive.length > 0) {
    blockers.push(
      `${inconclusive.length} image check(s) returned no usable OCR result across every run ` +
        "(every run was 'unavailable') and were excluded from the rate calculations rather than " +
        'counted as a pass or a fail',
    );
  }
  if (insufficientRunsForInstability.length > 0) {
    blockers.push(
      `${insufficientRunsForInstability.length} image check(s) have only a single usable OCR run, ` +
        'which cannot show whether repeat runs straddle the threshold (the drift risk this ' +
        `calibration exists to catch) — increase runsPerImage to at least 2: ` +
        insufficientRunsForInstability.map((s) => `${s.name}/${s.axisId}/${s.label}`).join(', '),
    );
  }
  if (garbledDetectionRate !== null && garbledDetectionRate < minAcceptableRate) {
    blockers.push(
      `garbled-detection rate ${garbledDetectionRate.toFixed(3)} is below the minimum acceptable ` +
        `rate ${minAcceptableRate} — this threshold is not reliably rejecting mismatched lettering`,
    );
  }
  if (stylizedPassRate !== null && stylizedPassRate < minAcceptableRate) {
    blockers.push(
      `stylized-but-legible pass rate ${stylizedPassRate.toFixed(3)} is below the minimum ` +
        `acceptable rate ${minAcceptableRate} — this threshold is rejecting too many legible concepts`,
    );
  }
  // This task exists to freeze TWO constants, not one — a report that never
  // consults `phash` here would recommend freezing MIN_PHASH_HAMMING with no
  // evidence for it at all, however clean the OCR side looks.
  if (phash === null) {
    blockers.push(
      'no pairwise pHash data was measured (every golden name needs at least two axis images ' +
        'with a decodable phash) — MIN_PHASH_HAMMING cannot be evaluated, let alone frozen',
    );
  } else if (phash.min < phashThreshold) {
    blockers.push(
      `the minimum observed pairwise pHash distance (${phash.min}) is BELOW the MIN_PHASH_HAMMING ` +
        `threshold (${phashThreshold}) — at least one golden name produced two same-job concepts ` +
        'the real distinctness gate would have rejected as too similar',
    );
  }

  return {
    goldenCount: goldenNames.size,
    imageCount: results.length,
    ocrThreshold,
    phashThreshold,
    garbledDetectionRate,
    garbledConsidered,
    stylizedPassRate,
    stylizedConsidered,
    checks: allStats,
    unstableChecks: unstable.map((s) => ({
      name: s.name,
      axisId: s.axisId,
      label: s.label,
      scores: s.scores,
    })),
    regenBurnByAxis,
    phash,
    canFreeze: blockers.length === 0,
    blockers,
  };
}
