// ---------------------------------------------------------------------------
// The FREE favicon gig's pack builder (US-2, FR-11/FR-13).
//
// THIS IS NOT THE M2 PACK. US-2's deliverable is favicons + manifest + snippet
// only — no `logo.svg`, no mono mark, no colour masters, no `brand.json` — so
// it is built here rather than by `pack/index.ts` and gated against
// `FAVICON_ZIP_ENTRIES`, never the 15-entry paid contract. The two builders are
// kept apart deliberately: routing the free gig through `buildPack` would
// either promise the buyer a true-vector `logo.svg` we cannot produce from
// their raster, or make the paid pack's entry list conditional — and a
// conditional deliverable contract is one nobody can gate.
//
// The input is the buyer's EXISTING logo, so the two source kinds take
// different roads to the same guarantee (every PNG exactly size x size):
//
//   svg    — each size is rendered from the vector by resvg, exactly as the
//            paid pack does, so the 16 px icon is drawn at 16 px rather than
//            squeezed out of a bigger raster.
//   raster — `@cf-wasm/photon` decodes the source ONCE and produces each size
//            with a Lanczos3 resize from that single decode (PRD §7 names
//            photon as "the favicon gig's PNG path"). Decoding once and
//            resizing six times is the memory-cheap order: the alternative —
//            re-wrapping the source bytes in a `data:` SVG per size, the trick
//            pipeline.ts uses for its pHash decode — would base64 the source
//            (up to 10 MB) and decode it six times over, against a 128 MB
//            isolate ceiling that Task 10 already measured a breach of.
//
// LETTERBOXING, NOT SQUEEZING. Real logos are wordmarks: wide. `checkDimensions`
// demands exactly size x size, and a 4:1 wordmark forced into a square is a
// deliverable no buyer wants. Every size therefore fits the source inside the
// square preserving aspect ratio and centres it on transparency — in vector
// space via `preserveAspectRatio` for SVG sources, in pixel space via
// `letterbox` below for rasters.
//
// NEVER UPSCALED. `fetchSourceLogo` (freeGigs.ts) admits a raster only when its
// longest edge is >= MIN_SOURCE_PX (512), which is also the largest size in
// FAVICON_SIZES — so `size / max(width, height)` is <= 1 for every size here
// and no output invents pixels the source did not have.
//
// WASM DISCIPLINE. photon is a wasm-bindgen build exactly like resvg: every
// `PhotonImage` owns wasm linear memory until `.free()`d, and WebAssembly.Memory
// only grows, so an unfreed handle's high-water mark is permanent for the
// isolate's life (Task 10 measured 129.5 MB against a 128 MB ceiling from
// precisely this). Every handle here is freed in a `finally`, inner before
// outer, and every buffer that leaves wasm is copied into a fresh
// `Uint8Array` first so it never aliases memory a later resize can grow over.
// ---------------------------------------------------------------------------

import { FAVICON_SIZES, ICO_SIZES } from '../config.js';
import {
  checkDimensions,
  checkIco,
  checkZipCompleteness,
  readPngDimensions,
  type Dimensions,
  type DimensionsResult,
  type IcoGateResult,
  type ZipGateResult,
} from '../gates/index.js';
import { assembleIco } from './ico.js';
import { renderSvgToPixmap, renderSvgToPng } from './render.js';
import type { WasmSources } from './wasm.js';
import { FAVICON_ZIP_ENTRIES, buildHtmlSnippet, buildWebmanifest, zipFiles } from './zip.js';

/**
 * The buyer's existing logo, after `fetchSourceLogo` has sniffed and measured
 * it. `width`/`height` are the source's TRUE pixel dimensions (PNG IHDR or a
 * photon decode) — not a header claim — because the never-upscale guarantee
 * rests on them.
 */
export type FaviconSource =
  | { kind: 'svg'; svg: string }
  | { kind: 'raster'; bytes: Uint8Array; width: number; height: number };

export interface InkGateResult {
  /** The entry the count was taken from. */
  file: string;
  /** Pixels with alpha > 0. `null` when the PNG could not be decoded at all. */
  opaquePixels: number | null;
  pass: boolean;
}

export interface FaviconPackGates {
  dimensions: Array<{ file: string } & DimensionsResult>;
  ico: IcoGateResult;
  zip: ZipGateResult;
  ink: InkGateResult;
  pass: boolean;
}

export interface FaviconPackResult {
  zip: Uint8Array;
  files: Record<string, Uint8Array>;
  gates: FaviconPackGates;
}

export interface FaviconPackInput {
  source: FaviconSource;
  /** Names the webmanifest. The favicon brief has no brandName, so the caller
   *  passes the source URL's hostname. */
  siteName: string;
  sources: WasmSources;
}

/**
 * Size -> entry name. Must stay consistent with `FAVICON_ZIP_ENTRIES`, and is
 * proven so rather than assumed: `buildFaviconPack` writes exactly these files
 * plus the three non-image entries, and `checkZipCompleteness(zip,
 * FAVICON_ZIP_ENTRIES)` then fails the pack if any contracted entry is absent.
 */
const FAVICON_FILENAMES: Record<number, string> = {
  16: 'favicon-16.png',
  32: 'favicon-32.png',
  48: 'favicon-48.png',
  180: 'apple-touch-icon.png',
  192: 'icon-192.png',
  512: 'icon-512.png',
};

// --- photon ------------------------------------------------------------------

/**
 * photon's ONE import site (PRD §7). Dynamic and memoized on purpose: both the
 * workerd and the Node entry points instantiate a 1.5 MB wasm module at module
 * evaluation time, and this app's fetch handler — webhooks, the deliverables
 * route, the progress page — has no use for a raster resizer. A static import
 * would put that instantiation in every isolate's startup path; a dynamic one
 * puts it only in the free favicon gig's. wrangler still discovers and inlines
 * the literal specifier (the same property Task 10 verified for potrace's
 * dynamic import), so the Worker bundle is unaffected by the laziness.
 */
let photonModule: Promise<typeof import('@cf-wasm/photon')> | undefined;
const loadPhoton = (): Promise<typeof import('@cf-wasm/photon')> =>
  (photonModule ??= import('@cf-wasm/photon'));

/**
 * Prove these bytes actually decode, and report what they decode TO.
 *
 * This is not "read the size" — that is `readPngDimensions`/`readJpegDimensions`
 * in freeGigs.ts, which allocate nothing and must run FIRST so this decode is
 * bounded before it starts. This answers the different question those cannot:
 * does the entropy-coded payload behind that header survive a decoder?
 *
 * IT EXISTS BECAUSE ITS ABSENCE WAS A CRASH. An ordinary truncated JPEG — a cut
 * upload, a CDN that ended the response early, no craft required — has a
 * perfectly walkable header and traps photon with `RuntimeError: unreachable`
 * on decode. Unwrapped, that trap escapes the queue consumer, which logs it as
 * a transient error and retries; it is not transient, so it re-throws to the
 * DLQ having already consumed the buyer's allowance and told them nothing.
 * Catching it here turns a wasm panic into a refusal with a reason — the exact
 * property an earlier version of this module documented and a later one
 * deleted without reading the docstring that explained it.
 *
 * Verified: a trap does NOT poison the module. Decodes and resizes after one
 * succeed normally, so a refused job costs the isolate nothing.
 *
 * Returns the decoded dimensions so the caller can hold the payload to its own
 * header's claim, rather than trusting either alone.
 */
export async function decodeRasterSource(bytes: Uint8Array): Promise<Dimensions | null> {
  const photon = await loadPhoton();
  let image: InstanceType<(typeof photon)['PhotonImage']>;
  try {
    image = photon.PhotonImage.new_from_byteslice(bytes);
  } catch {
    return null;
  }
  try {
    const width = image.get_width();
    const height = image.get_height();
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  } finally {
    image.free();
  }
}

/**
 * The size every ink measurement is taken at — the largest contracted icon.
 *
 * PICKED FROM MEASUREMENT, NOT INTUITION, and the small sizes are the reason.
 * Opaque-pixel counts for the production wrapper render, by size:
 *
 *   solid square           16:196  32:676  48:1600  180:21316  512:169744
 *   hairline ring          16:84   32:164  48:244   180:910    512:4294
 *   hairline monogram "I"  16:0    32:26   48:76    180:276    512:1568
 *   thin wide wordmark     16:6    32:12   48:16    180:56     512:290
 *   single dot (r=3/512)   16:0    32:4    48:4     180:4      512:33
 *   &nbsp; / bare & / XXE  16:0    32:0    48:0     180:0      512:0
 *
 * A THIN MONOGRAM AND A SMALL DOT BOTH RENDER TO ZERO OPAQUE PIXELS AT 16 px.
 * Measuring there would refuse legitimate logos, and refusing a valid logo is
 * as bad as delivering a blank one. At 512 the sparsest legitimate mark
 * measured still leaves 33 opaque pixels — and every unrenderable input
 * measures exactly 0, at every size. So the threshold is simply "> 0": the
 * most permissive rule available, and still perfectly discriminating, with a
 * margin of 33 px against the most degenerate real artwork and 290 against a
 * realistic sparse one.
 */
export const INK_PROBE_PX = 512;

/** Pixels whose alpha byte is non-zero, over a tightly-packed RGBA buffer. */
function countOpaque(rgba: Uint8Array): number {
  let opaque = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 0) opaque++;
  }
  return opaque;
}

/**
 * Does this PNG contain any ink at all?
 *
 * Runs against the ENCODED DELIVERABLE rather than an intermediate, so it
 * covers the whole chain — wrapper, render, resize, letterbox, encode — and
 * would catch a future regression in any of them that intake could not see.
 * A PNG that will not decode fails: `opaquePixels: null` is not a pass.
 *
 * COST, STATED RATHER THAN DISCOVERED: this makes the SVG source path load
 * photon too, where it previously loaded only resvg — the two paths used to
 * take one wasm module each. That is one 1.5 MB module plus a 512x512 RGBA
 * decode (1 MiB), and it sits inside the two-module budget Task 23 derived
 * (~80 MB of headroom under the 128 MB ceiling). Measuring the intermediate
 * pixmap instead would dodge it, but would no longer be a check on the bytes
 * actually being shipped, which is the whole reason this gate exists.
 */
export async function checkInk(png: Uint8Array, file: string): Promise<InkGateResult> {
  const photon = await loadPhoton();
  let image: InstanceType<(typeof photon)['PhotonImage']>;
  try {
    image = photon.PhotonImage.new_from_byteslice(png);
  } catch {
    return { file, opaquePixels: null, pass: false };
  }
  try {
    const opaquePixels = countOpaque(image.get_raw_pixels());
    return { file, opaquePixels, pass: opaquePixels > 0 };
  } catch {
    return { file, opaquePixels: null, pass: false };
  } finally {
    image.free();
  }
}

/**
 * Centre `width`x`height` RGBA pixels on a transparent `size`x`size` canvas.
 * Pure TypeScript because photon's padding helpers take an opaque `Rgba` fill,
 * and a favicon's surround has to be transparent, not white — a white-padded
 * icon looks broken on every dark browser chrome there is.
 */
function letterbox(rgba: Uint8Array, width: number, height: number, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const dx = Math.floor((size - width) / 2);
  const dy = Math.floor((size - height) / 2);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    out.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), ((dy + y) * size + dx) * 4);
  }
  return out;
}

/** Every contracted size, from one decode of the source raster. */
async function renderRasterSizes(
  source: Extract<FaviconSource, { kind: 'raster' }>,
  sizes: readonly number[],
): Promise<Map<number, Uint8Array>> {
  const photon = await loadPhoton();
  const out = new Map<number, Uint8Array>();
  const decoded = photon.PhotonImage.new_from_byteslice(source.bytes);
  try {
    const width = decoded.get_width();
    const height = decoded.get_height();
    for (const size of sizes) {
      // <= 1 by fetchSourceLogo's >= MIN_SOURCE_PX admission rule; clamped
      // anyway so a rounding surprise can never produce an oversized buffer.
      const scale = Math.min(size / width, size / height, 1);
      const targetWidth = Math.min(size, Math.max(1, Math.round(width * scale)));
      const targetHeight = Math.min(size, Math.max(1, Math.round(height * scale)));
      const resized = photon.resize(
        decoded,
        targetWidth,
        targetHeight,
        photon.SamplingFilter.Lanczos3,
      );
      try {
        if (targetWidth === size && targetHeight === size) {
          out.set(size, new Uint8Array(resized.get_bytes()));
          continue;
        }
        const padded = new photon.PhotonImage(
          letterbox(resized.get_raw_pixels(), targetWidth, targetHeight, size),
          size,
          size,
        );
        try {
          out.set(size, new Uint8Array(padded.get_bytes()));
        } finally {
          padded.free();
        }
      } finally {
        resized.free();
      }
    }
  } finally {
    decoded.free();
  }
  return out;
}

/** base64 for Workers (no Buffer): chunked to stay under the spread-arg limit. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * A square canvas holding the source SVG, letterboxed.
 *
 * The buyer's SVG carries whatever aspect ratio it likes, and
 * `renderSvgToPng`'s `fitTo: width` would hand back `size x (size/aspect)` —
 * a non-square PNG that fails the dimensions gate for the commonest logo shape
 * there is. Referencing it from an outer square `<image>` lets
 * `preserveAspectRatio="xMidYMid meet"` do the letterboxing in VECTOR space:
 * resvg parses the referenced SVG into its own tree rather than rasterizing it
 * at some fixed intermediate size, so every output size is still a true render
 * from the vector. (The `data:` reference is why this wrapper could never be a
 * *delivered* SVG — the true-vector gate rejects `<image>` outright — but the
 * favicon pack delivers no SVG at all, only the PNGs rendered through here.)
 *
 * The source is UTF-8 encoded before base64: `btoa` throws on any character
 * above U+00FF, and a logo whose title element carries a non-Latin brand name
 * is entirely legitimate input here.
 */
function squareSvgWrapper(svg: string, size: number): string {
  const encoded = toBase64(new TextEncoder().encode(svg));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}">` +
    `<image width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" ` +
    `href="data:image/svg+xml;base64,${encoded}"/>` +
    `</svg>`
  );
}

/**
 * WILL THE BUYER'S SVG ACTUALLY DRAW? Answered by rendering it, at intake.
 *
 * THE BUG THIS EXISTS FOR, and why nothing cheaper works. `squareSvgWrapper`
 * above base64-encodes the buyer's SVG into a nested `<image>`, and resvg
 * SWALLOWS a parse failure inside a nested data-URI sub-document rather than
 * throwing: the wrapper parses fine, the referenced document does not, and the
 * render returns a fully transparent pixmap. Measured on the real renderer, an
 * ordinary SVG whose `<title>` contains `&nbsp;`:
 *
 *   direct  (unwrapped) : THROWS "unknown entity reference 'nbsp'"
 *   wrapped (production): 64x64, opaquePx = 0 / 4096
 *
 * So the free favicon gig never saw the throw. It shipped six blank icons with
 * every gate passing, the buyer's allowance spent and a delivery note telling
 * them it had worked — the third appearance of blank-icons-as-success in this
 * module. A try/catch cannot catch it (nothing throws) and a text scan cannot
 * predict it (resvg's tolerances are resvg's), so the guard is a real render
 * through the SAME wrapper production uses. That sameness is structural rather
 * than commented: this calls `squareSvgWrapper` itself.
 *
 * Returns the opaque-pixel count so a caller can log what it saw; 0 covers
 * both "rendered empty" and "the render threw", which are one refusal.
 */
export async function svgDrawsInk(svg: string, sources: WasmSources): Promise<number> {
  try {
    const pixmap = await renderSvgToPixmap(
      squareSvgWrapper(svg, INK_PROBE_PX),
      INK_PROBE_PX,
      sources,
    );
    return countOpaque(pixmap.data);
  } catch {
    // An unwrapped-style throw is still just "it does not draw".
    return 0;
  }
}

/** Every contracted size, each rendered independently from the vector. */
async function renderSvgSizes(
  svg: string,
  sizes: readonly number[],
  sources: WasmSources,
): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array>();
  for (const size of sizes) {
    out.set(size, await renderSvgToPng(squareSvgWrapper(svg, size), size, sources));
  }
  return out;
}

/**
 * US-2's deliverable: the favicon set, `favicon.ico`, a webmanifest, and a
 * drop-in HTML snippet, byte-verified before it can be delivered.
 *
 * Gates are RETURNED, never thrown, and never applied by the caller's
 * good intentions: a free deliverable that ships a broken favicon costs the
 * conversion this whole gig exists to earn, so it clears the same
 * dimensions/ICO/ZIP checks the paid pack does — only against the smaller
 * entry contract.
 */
export async function buildFaviconPack(input: FaviconPackInput): Promise<FaviconPackResult> {
  const { source, siteName, sources } = input;

  const pngs =
    source.kind === 'svg'
      ? await renderSvgSizes(source.svg, FAVICON_SIZES, sources)
      : await renderRasterSizes(source, FAVICON_SIZES);

  const files: Record<string, Uint8Array> = {};
  const dimensions: Array<{ file: string } & DimensionsResult> = [];
  for (const size of FAVICON_SIZES) {
    const file = FAVICON_FILENAMES[size]!;
    // Present for every FAVICON_SIZES entry by construction — both renderers
    // iterate the identical list — but a missing entry must fail the
    // dimensions gate rather than throw past it into the queue's retry budget.
    const png = pngs.get(size) ?? new Uint8Array(0);
    files[file] = png;
    const actual = readPngDimensions(png) ?? { width: -1, height: -1 };
    dimensions.push({ file, ...checkDimensions(actual, { width: size, height: size }) });
  }

  const ico = assembleIco(
    ICO_SIZES.map((size) => ({ size, png: files[FAVICON_FILENAMES[size]!]! })),
  );
  files['favicon.ico'] = ico;

  const encoder = new TextEncoder();
  files['site.webmanifest'] = encoder.encode(buildWebmanifest(siteName));
  files['snippet.html'] = encoder.encode(buildHtmlSnippet());

  const zip = zipFiles(files);
  // INK, measured on the largest delivered icon.
  //
  // Intake proves the SOURCE renders; this proves WHAT WE ARE ABOUT TO DELIVER
  // does. They are not the same claim — a future change to `squareSvgWrapper`,
  // the photon resize or the letterbox could produce blanks from a source that
  // passed intake happily, and every other gate here would still pass, because
  // dimensions, ICO and ZIP completeness are all satisfied by a perfectly
  // formed empty image. That is exactly how this shipped.
  //
  // ONLY THE LARGEST ENTRY IS MEASURED, and that is a measurement result, not
  // a shortcut: a hairline monogram renders to 0 opaque pixels at 16 px while
  // drawing 1568 at 512 (see INK_PROBE_PX). Gating the small icons would
  // refuse legitimate sparse artwork.
  //
  // THE PAID PATH NEEDS NO EQUIVALENT: a blank concept already fails the OCR
  // readback (nothing to transcribe) and the pHash distinctness gate (every
  // blank is identical to every other), so the free favicon gig is the only
  // path in this bot whose gates all pass on an empty image.
  const largest = FAVICON_SIZES.reduce((a, b) => (a > b ? a : b));
  const largestFile = FAVICON_FILENAMES[largest]!;
  const gates: FaviconPackGates = {
    dimensions,
    ico: checkIco(ico),
    zip: checkZipCompleteness(zip, FAVICON_ZIP_ENTRIES),
    ink: await checkInk(files[largestFile]!, largestFile),
    pass: false,
  };
  gates.pass =
    gates.dimensions.every((entry) => entry.pass) &&
    gates.ico.pass &&
    gates.zip.pass &&
    gates.ink.pass;

  return { zip, files, gates };
}
