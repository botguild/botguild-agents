// buildPack (FR-11 + FR-13): winner SVG in, fully gated brand pack out.
//
// Order matters. The true-vector gate runs FIRST and throws — every later step
// renders *from* this SVG, so building a pack from a raster-wrapping "SVG"
// would produce artifacts that all individually pass while the deliverable is
// exactly the fraud §9 exists to prevent.

import { FAVICON_SIZES, ICO_SIZES, MASTER_SIZES } from '../config.js';
import {
  checkDimensions,
  checkIco,
  checkTrueVector,
  checkZipCompleteness,
  normalizeForMatch,
  readPngDimensions,
  similarity,
  type DimensionsResult,
  type IcoGateResult,
  type OcrGate,
  type VectorGateResult,
  type ZipGateResult,
} from '../gates/index.js';
import { checkInk, INK_PROBE_PX, type InkGateResult } from './faviconPack.js';
import type { FontPairing } from './fonts.js';
import { assembleIco } from './ico.js';
import { cropSvg, deriveFaviconMark, type MarkCrop } from './mark.js';
import { traceMonoSvg } from './mono.js';
import { extractPalette, type Swatch } from './palette.js';
import { renderSvgToPixmap, renderSvgToPng } from './render.js';
import type { WasmSources } from './wasm.js';
import { buildHtmlSnippet, buildWebmanifest, zipFiles } from './zip.js';

export interface PackInput {
  svg: string;
  brandName: string;
  sources: WasmSources;
  fonts: FontPairing;
  /**
   * The lettering readback, used here to REFUTE the derived favicon mark: a
   * favicon that still reads back as the brand name is a shrunken lockup, not
   * a mark. Optional because the derivation stands on its own geometry without
   * it — and when it is absent the report says so (`status: 'not-run'`) rather
   * than implying a check that never ran. Production always supplies it.
   */
  ocr?: OcrGate;
}

export interface BrandJson {
  brandName: string;
  colors: Swatch[];
  fonts: FontPairing;
  licenseNote: string;
}

/**
 * Was the brand name still legible on the favicon? For a favicon, YES IS THE
 * FAILURE — it means the whole lockup is still in the frame.
 */
export interface FaviconTextResult {
  /** `not-run`: no gate was supplied. `unavailable`: the model could not verdict. */
  status: 'ok' | 'not-run' | 'unavailable';
  /** Verbatim model output, or the reason it is missing. */
  transcription: string | null;
  /** Characters of lettering left after `normalizeForMatch`. */
  letteringChars: number | null;
  /** Readback similarity to the brand name, on the same scale the §9 gate uses. */
  brandSimilarity: number | null;
  /** True when nothing refuted the crop. `unavailable`/`not-run` cannot refute. */
  pass: boolean;
}

/**
 * What the favicon set was actually rendered from, and what was measured on it.
 *
 * RECORDED BECAUSE SILENT DEGRADATION IS THE FAILURE MODE. Falling back to the
 * whole logo is a legitimate outcome; doing it without saying so is how a
 * delivery ends up carrying a promise no artifact backs.
 */
export interface FaviconMarkReport {
  source: 'mark-crop' | 'whole-logo';
  /** The window taken out of the logo, in probe-pixel space; null when none was. */
  crop: MarkCrop | null;
  /** Why the whole logo was used. `null` exactly when `source` is `mark-crop`. */
  reason: string | null;
  /** Components the geometry judged to be lettering, and excluded. */
  textComponents: number;
  /** Mark-candidate components left after that exclusion. */
  markComponents: number;
  /**
   * Share of the delivered icon that is the mark rather than background,
   * measured at `MARK_PROBE_PX`. Reported alongside `ink` because for a logo
   * with an opaque field the two say very different things — see `ink`.
   */
  coverage: number;
  /**
   * Task 23's ink gate, re-run here on the DELIVERED `icon-512.png`.
   *
   * It counts pixels with alpha > 0, so it proves the icon draws at all — and
   * for a logo that paints an opaque field behind everything it saturates and
   * proves nothing more. That is not a reason to drop it (a crop that landed
   * off the artwork would measure 0) but it is the reason `coverage` is
   * reported next to it rather than instead of it.
   */
  ink: InkGateResult;
  text: FaviconTextResult;
  pass: boolean;
}

export interface PackGateReport {
  vector: VectorGateResult;
  dimensions: Array<{ file: string } & DimensionsResult>;
  ico: IcoGateResult;
  zip: ZipGateResult;
  favicon: FaviconMarkReport;
  pass: boolean;
}

export interface PackResult {
  zip: Uint8Array;
  files: Record<string, Uint8Array>;
  brand: BrandJson;
  gates: PackGateReport;
}

const FAVICON_FILENAMES: Record<number, string> = {
  16: 'favicon-16.png',
  32: 'favicon-32.png',
  48: 'favicon-48.png',
  180: 'apple-touch-icon.png',
  192: 'icon-192.png',
  512: 'icon-512.png',
};

/**
 * Normalized characters of lettering a favicon may read back before the crop
 * is judged to have kept the wordmark.
 *
 * TWO, NOT ZERO, and the slack is deliberate. The gate's job is to catch a
 * whole word surviving the crop, and a nondeterministic vision model reporting
 * one stray glyph off a piece of abstract geometry is not that. Measured on
 * the JiffyApp delivery: the derived rocket crop reads back "" (0 chars) at
 * 512 px, while the whole-logo favicon it replaced reads back "Jiffyapp"
 * (8 chars, similarity 1.00). Nothing in that measurement is close to 2.
 */
const MAX_FAVICON_LETTERING_CHARS = 2;

/**
 * Even a short readback refutes the crop if it IS the brand — a two-letter
 * brand name would otherwise slip under the character rule above.
 */
const MAX_FAVICON_BRAND_SIMILARITY = 0.5;

/** Nothing supplied a gate: absence of a check, never a passed check. */
const TEXT_NOT_RUN: FaviconTextResult = {
  status: 'not-run',
  transcription: null,
  letteringChars: null,
  brandSimilarity: null,
  pass: true,
};

/**
 * Read the delivered icon back and ask whether the wordmark is still on it.
 *
 * THIS IS THE CHECK THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. Every gate the
 * pack ran measured a property a mush favicon satisfies perfectly: the
 * dimensions were exact, the ICO parsed, the ZIP was complete. None of them
 * asked what the image showed. This one does, on the same pinned vision model
 * §9 already trusts to read lettering, run against the bytes being shipped.
 *
 * An `unavailable` verdict CANNOT refute the crop, and does not pretend to:
 * the geometry stands on its own and the report records that the readback did
 * not happen. Refusing the mark on a vendor outage would trade a verified
 * improvement for an unverified regression.
 */
async function checkFaviconText(
  ocr: OcrGate,
  png: Uint8Array,
  brandName: string,
): Promise<FaviconTextResult> {
  const outcome = await ocr.check(png, brandName);
  if (outcome.status !== 'ok') {
    return {
      status: 'unavailable',
      transcription: null,
      letteringChars: null,
      brandSimilarity: null,
      pass: true,
    };
  }
  const lettering = normalizeForMatch(outcome.verdict.transcription);
  const brandSimilarity = similarity(lettering, normalizeForMatch(brandName));
  return {
    status: 'ok',
    transcription: outcome.verdict.transcription,
    letteringChars: lettering.length,
    brandSimilarity,
    pass:
      lettering.length <= MAX_FAVICON_LETTERING_CHARS &&
      brandSimilarity < MAX_FAVICON_BRAND_SIMILARITY,
  };
}

export async function buildPack(input: PackInput): Promise<PackResult> {
  const { svg, brandName, sources, fonts, ocr } = input;

  const vector = checkTrueVector(svg);
  if (!vector.pass) {
    throw new Error(
      `refusing to build a pack: true-vector gate failed — ${vector.violations.join('; ')}`,
    );
  }

  const files: Record<string, Uint8Array> = {};
  const dimensions: Array<{ file: string } & DimensionsResult> = [];
  const encoder = new TextEncoder();

  const record = (file: string, png: Uint8Array, size: number): void => {
    files[file] = png;
    const actual = readPngDimensions(png) ?? { width: -1, height: -1 };
    dimensions.push({ file, ...checkDimensions(actual, { width: size, height: size }) });
  };

  // Masters are the whole logo, always: a brand's colour master IS the lockup.
  // Only the favicons are cropped. Each is rendered from the vector at its
  // exact target size — never resized from a larger raster (FR-11).
  for (const size of MASTER_SIZES) {
    record(`logo-color-${size}.png`, await renderSvgToPng(svg, size, sources), size);
  }

  // --- The favicon mark -------------------------------------------------------
  // Derive a mark, VERIFY it on the largest icon, and only then commit the rest
  // of the set to it. The fallback is today's behaviour exactly (downscale the
  // whole logo), so the worst case of every branch below is the deliverable
  // that shipped before this existed — a mediocre favicon beats no pack.
  //
  // The verification renders ONE icon rather than the set, and keeps its bytes
  // when they pass. The alternative — render all six, check, re-render all six
  // — costs six wasted resvg renders on every fallback, inside the same stage
  // that Task 10 measured at 129.5 MB against a 128 MB ceiling.
  const derived = await deriveFaviconMark(svg, sources);
  const probeFile = FAVICON_FILENAMES[INK_PROBE_PX]!;
  let markSource: 'mark-crop' | 'whole-logo' = 'whole-logo';
  let reason = derived.reason;
  let text = TEXT_NOT_RUN;
  let verifiedPng: Uint8Array | null = null;
  let faviconSvg = svg;

  if (derived.crop !== null) {
    const cropped = cropSvg(svg, derived.crop);
    // The real deliverable bytes, PNG-encoded, not an intermediate pixmap:
    // both checks then cover the whole chain that produces what ships.
    const png = await renderSvgToPng(cropped, INK_PROBE_PX, sources);
    const cropInk = await checkInk(png, probeFile);
    text = ocr ? await checkFaviconText(ocr, png, brandName) : TEXT_NOT_RUN;
    // DEFENCE IN DEPTH, AND SAID SO RATHER THAN IMPLIED: no input reaches this
    // branch today. `deriveFaviconMark` only returns a crop after seeing
    // components in a render of this same SVG, so a crop of it cannot be
    // empty — proven by mutation, which this branch survives while every other
    // check here is killed by a named test. It stays because the crop takes a
    // DIFFERENT road to the pixels than the derivation did (a nested data-URI
    // `<image>`, the exact construct Task 23 measured resvg swallowing a parse
    // failure inside), and a future regression on that road would otherwise
    // ship six blank icons with every other gate green — which is how blank
    // icons shipped three times already.
    if (!cropInk.pass) {
      reason =
        `the derived mark crop rendered no ink ` +
        `(${cropInk.opaquePixels ?? 'undecodable'} opaque pixels at ${INK_PROBE_PX}px)`;
    } else if (!text.pass) {
      reason =
        `the derived mark crop still read back as lettering ` +
        `("${text.transcription ?? ''}", ${text.letteringChars ?? 0} characters, ` +
        `${(text.brandSimilarity ?? 0).toFixed(2)} similarity to the brand name)`;
    } else {
      markSource = 'mark-crop';
      reason = null;
      faviconSvg = cropped;
      verifiedPng = png;
    }
  }
  for (const size of FAVICON_SIZES) {
    const png =
      size === INK_PROBE_PX && verifiedPng !== null
        ? verifiedPng
        : await renderSvgToPng(faviconSvg, size, sources);
    record(FAVICON_FILENAMES[size]!, png, size);
  }

  // Mono mark: threshold + trace the 1024px pixmap, then render its own master.
  const masterPixmap = await renderSvgToPixmap(svg, 1024, sources);
  const monoSvg = await traceMonoSvg(masterPixmap, sources);
  files['logo-mono.svg'] = encoder.encode(monoSvg);
  record('logo-mono-1024.png', await renderSvgToPng(monoSvg, 1024, sources), 1024);

  // favicon.ico reuses the already-rendered 16/32/48 PNGs.
  const ico = assembleIco(
    ICO_SIZES.map((size) => ({ size, png: files[FAVICON_FILENAMES[size]!]! })),
  );
  files['favicon.ico'] = ico;

  const brand: BrandJson = {
    brandName,
    colors: extractPalette(masterPixmap),
    fonts,
    licenseNote:
      'Colour codes are extracted from the delivered mark. The font pairing is an advisory ' +
      'recommendation and is not a warranted property of this delivery.',
  };

  files['logo.svg'] = encoder.encode(svg);
  files['site.webmanifest'] = encoder.encode(buildWebmanifest(brandName));
  files['snippet.html'] = encoder.encode(buildHtmlSnippet());
  files['brand.json'] = encoder.encode(JSON.stringify(brand, null, 2));

  const zip = zipFiles(files);
  // Measured on whatever finally won, so the number in the report is the
  // number for the bytes in the ZIP — including after a fallback re-render.
  //
  // COST, STATED RATHER THAN DISCOVERED: `checkInk` is photon-backed, so the
  // paid pack stage now instantiates a THIRD wasm module (resvg for rendering,
  // potrace for the mono trace, photon to decode one 512x512 PNG) — about
  // 1.5 MB of module plus a 1 MiB decode, against the 128 MB isolate ceiling
  // Task 10 measured a breach of. It is deliberately not avoided by counting
  // alpha on the intermediate pixmap instead: this has to be a check on the
  // bytes being shipped, which is the whole reason Task 23 built it that way.
  const ink = await checkInk(files[probeFile]!, probeFile);
  const favicon: FaviconMarkReport = {
    source: markSource,
    crop: markSource === 'mark-crop' ? derived.crop : null,
    reason,
    textComponents: derived.textComponents,
    markComponents: derived.markComponents,
    coverage: markSource === 'mark-crop' ? derived.coverage : 0,
    ink,
    text,
    // ONLY `ink` GATES DELIVERY. The readback steers the derivation and is
    // recorded, but it cannot block a pack: the whole-logo fallback reads back
    // as the brand name BY DEFINITION, and failing the pack on that would turn
    // "we could not find a mark" into "the buyer gets nothing".
    pass: ink.pass,
  };
  const gates: PackGateReport = {
    vector,
    dimensions,
    ico: checkIco(ico),
    zip: checkZipCompleteness(zip),
    favicon,
    pass: false,
  };
  gates.pass =
    gates.vector.pass &&
    gates.dimensions.every((d) => d.pass) &&
    gates.ico.pass &&
    gates.zip.pass &&
    gates.favicon.pass;

  return { zip, files, brand, gates };
}
