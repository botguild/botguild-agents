// ---------------------------------------------------------------------------
// The free funnel's two guards (US-2/US-3, FR-1/FR-14, §12).
//
//   `checkFreeGigQuota` — the D1 hard count that stops the free gigs being
//                         farmed. KV throttles are advisory; this is the
//                         authority.
//   `fetchSourceLogo`   — the fetch-time half of the `logoUrl` policy. The pure
//                         `checkLogoUrl` in brief.ts decides scheme/host at
//                         parse time; everything that can only be known once
//                         bytes are moving — size, real type, latency, real
//                         resolution — is decided here.
//
// BOTH GUARDS ARE ALLOW-LISTS. `checkLogoUrl` permits https + a non-IP host and
// refuses everything else; the type sniff below permits PNG, JPEG, and SVG
// magic bytes and refuses everything else. Neither enumerates what is
// forbidden, because the forbidden set is the one an attacker gets to extend.
//
// CONTENT-TYPE HEADERS ARE NOT TRUSTED. The buyer's server declares the type;
// the bytes decide it. The `Accept` header we send is a hint to the origin, not
// a check on the response.
//
// NOTHING IS DECODED UNTIL ITS DECODED SIZE IS KNOWN AND BOUNDED. The 10 MB cap
// bounds ENCODED bytes, which is not the quantity that fills the isolate: a
// 243 KiB flat 8000x8000 PNG expands to ~490 MiB of RGBA, and a 972 KiB
// 16000x16000 one to ~977 MiB, against a 128 MB ceiling. Both are refused here
// from their headers, before a decoder is handed a single byte.
// ---------------------------------------------------------------------------

import { MIN_SOURCE_PX, checkLogoUrl } from './brief.js';
import { FREE_GIGS_PER_PAYER, FREE_GIG_WINDOW_DAYS, SEED_PRICE_USD } from './config.js';
import {
  checkTrueVector,
  readPngDimensions,
  sanitizeSvg,
  scanEntityRefs,
  substituteHtmlEntities,
  type Dimensions,
} from './gates/index.js';
import type { QuotaStore } from './jobs.js';
import { decodeRasterSource, svgDrawsInk, type FaviconSource } from './pack/faviconPack.js';
import type { WasmSources } from './pack/wasm.js';
import type { FetchLike } from './types.js';

// --- Quota (FR-14) -----------------------------------------------------------

export type QuotaDecision =
  | { allowed: true; used: number; remaining: number }
  | { allowed: false; used: number; message: string };

/**
 * Has this payer any free-gig allowance left in the rolling window?
 *
 * The refusal carries the buyer-facing sentence rather than a code, because
 * every caller would otherwise have to re-derive the same wording from the same
 * two constants — and the numbers in the message have to be the numbers the
 * decision was actually made with, not a copy that drifts.
 *
 * WHERE THIS IS CALLED FROM MATTERS MORE THAN WHAT IT RETURNS. It is asked
 * BEFORE any work — before the source fetch, before moderation, before a single
 * vendor call — so a payer over the cap costs us nothing at all. `quota.record`
 * is deliberately NOT called here: consuming an allowance is a separate
 * decision made at a separate moment in the job's life (see
 * `runSingleStage`), and fusing the two would burn a payer's allowance on
 * inputs we went on to refuse and on outages that were our fault.
 */
export async function checkFreeGigQuota(
  quota: QuotaStore,
  payerId: string,
): Promise<QuotaDecision> {
  const used = await quota.countRecent(payerId, FREE_GIG_WINDOW_DAYS);
  if (used < FREE_GIGS_PER_PAYER) {
    return { allowed: true, used, remaining: FREE_GIGS_PER_PAYER - used };
  }
  return {
    allowed: false,
    used,
    message:
      `LogoSmith cannot take this free job: you have used all ${FREE_GIGS_PER_PAYER} free ` +
      `LogoSmith jobs available in a rolling ${FREE_GIG_WINDOW_DAYS}-day window (this account ` +
      `has ${used} on record). Nothing has been generated and nothing has been charged.\n\n` +
      `Two ways forward: the allowance frees up as those jobs pass ` +
      `${FREE_GIG_WINDOW_DAYS} days old, or the $${SEED_PRICE_USD} brand-pack gig runs now ` +
      `with no such cap — three OCR-verified concepts and a true-vector pack with the full ` +
      `favicon set. Post that gig and LogoSmith will bid on it automatically.`,
  };
}

// --- Source logo fetch (§12) ---------------------------------------------------

export type SourceLogoResult = { ok: true; source: FaviconSource } | { ok: false; reason: string };

/** §12's streamed cap. Counted as bytes ARRIVE, not from Content-Length — a
 *  header is a claim and a chunked response need not carry one at all. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/** §12's fetch timeout. */
export const SOURCE_FETCH_TIMEOUT_MS = 15_000;

/** Enough bytes to classify every accepted type, including an SVG behind an
 *  XML declaration, a BOM, and a licence comment. */
const SNIFF_BYTES = 1024;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

const startsWith = (bytes: Uint8Array, magic: number[]): boolean =>
  bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte);

/**
 * The prefixes an XML document may legitimately open with. An allow-list, not a
 * search for `<svg` anywhere in the file: "contains the substring `<svg`" is
 * true of an HTML error page that happens to mention it, and that page would
 * then be handed to resvg as the buyer's logo.
 */
const XML_PREFIXES = ['<?xml', '<!doctype', '<!--', '<svg'];

/**
 * The most pixels a source raster may decode to (§12's isolate budget).
 *
 * DERIVED, NOT PICKED. Decoding costs `w x h x 4` bytes of RGBA inside wasm,
 * and `get_raw_pixels()` copies that out to JS, so peak is about `2 x 4 x P`
 * for `P` pixels. Allowing 48 MiB for those buffers leaves ~80 MB of the 128 MB
 * isolate ceiling for the two wasm modules, the encoded source (<= 10 MB), and
 * the runtime — so `P <= 48 MiB / 8 = 6,291,456`, rounded down to 6,000,000.
 *
 * That admits every real logo comfortably: 2048x2048 (the largest raster this
 * bot produces anywhere, in the paid pack) is 4.2 Mpx, and a 3000x2000 export
 * is 6.0 Mpx. It refuses 8000x8000 (64 Mpx) and 16000x16000 (256 Mpx), which
 * are decompression bombs rather than logos — a flat 8000x8000 PNG is 243 KiB
 * on the wire and ~490 MiB decoded.
 *
 * THE HEADER IS AUTHORITATIVE FOR THIS CHECK, which is what lets it run before
 * any decode — but only because two things make it so, and an earlier version
 * of this comment asserted it without either:
 *
 *   1. `readJpegDimensions` refuses a file carrying more than one frame header.
 *      Returning the FIRST SOF is not authority: a real 3000x3000 frame with a
 *      spliced 600x600 SOF0 in front of it would report 600x600 and then decode
 *      to 25x the budget.
 *   2. The decode below is held to the header's claim. If they disagree the
 *      source is refused outright, so neither number has to be trusted alone.
 *
 * With those, a PNG's IHDR and a JPEG's single SOF *are* what the decoder
 * allocates from, and there is no way to declare 100x100 and decode to
 * 8000x8000.
 */
export const MAX_SOURCE_PIXELS = 6_000_000;

/**
 * JPEG frame markers that carry dimensions — baseline, extended, progressive,
 * lossless, and their arithmetic-coded variants. An ALLOW-LIST: the tempting
 * form is "0xC0-0xCF except DHT/JPG/DAC", which is a blocklist of the three
 * non-frame markers in that range and fails open the day a fourth appears.
 */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** Markers that stand alone — no length field follows them. */
const STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8]);

/**
 * Read a JPEG's dimensions by walking its segment table to the frame header.
 *
 * Deliberately NOT "decode it and ask how big it is": that made the JPEG path
 * the worse of the two, because a bomb was fully decoded — and had already
 * filled the isolate — before any dimension was known to check it against.
 * Parsing the header allocates nothing, which is what makes the budget check
 * downstream able to run BEFORE a decoder ever sees these bytes.
 *
 * EXACTLY ONE FRAME HEADER, or nothing. Returning the FIRST SOF found is not
 * enough to call this authoritative: a file carrying a real 3000x3000 frame
 * plus a spliced 600x600 SOF0 would report whichever came first, and a header
 * that can disagree with the payload cannot bound a decode. Every segment
 * before the scan is therefore walked, and two frame headers is a refusal.
 *
 * The walk stops at SOS (0xDA). Past that lies entropy-coded data, where a
 * `FF` byte is escaped rather than starting a marker — so continuing would be
 * reading noise as structure. A conforming decoder stops looking for frame
 * headers there too, which is precisely why stopping there makes "exactly one
 * SOF" a statement about what the decoder will see.
 *
 * Returns null for anything it cannot walk cleanly, which the caller treats as
 * a refusal: an unreadable header is not permission to decode and find out.
 */
export function readJpegDimensions(jpeg: Uint8Array): Dimensions | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  let frame: Dimensions | null = null;
  let offset = 2;
  while (offset + 1 < jpeg.length) {
    if (jpeg[offset] !== 0xff) return null; // desynchronized: refuse
    // Any number of 0xFF fill bytes may pad the gap before a marker.
    let marker = jpeg[offset + 1]!;
    offset += 2;
    while (marker === 0xff && offset < jpeg.length) marker = jpeg[offset++]!;
    if (marker === 0xd9) break; // EOI
    if (marker === 0xda) break; // SOS: entropy data follows, stop scanning
    if (STANDALONE_MARKERS.has(marker)) continue;
    if (offset + 1 >= jpeg.length) return null;
    const length = view.getUint16(offset, false); // includes its own 2 bytes
    if (length < 2 || offset + length > jpeg.length) return null;
    if (SOF_MARKERS.has(marker)) {
      // SOFn payload: 1 byte sample precision, 2 bytes height, 2 bytes width.
      if (length < 7) return null;
      if (frame !== null) return null; // a second frame header: refuse
      const height = view.getUint16(offset + 3, false);
      const width = view.getUint16(offset + 5, false);
      if (width === 0 || height === 0) return null;
      frame = { width, height };
    }
    offset += length;
  }
  return frame;
}

type SniffedKind = 'png' | 'jpeg' | 'svg' | null;

function sniffKind(bytes: Uint8Array): SniffedKind {
  if (startsWith(bytes, PNG_MAGIC)) return 'png';
  if (startsWith(bytes, JPEG_MAGIC)) return 'jpeg';
  // A byte-order mark, then any leading whitespace, then one permitted prefix.
  const head = new TextDecoder()
    .decode(bytes.subarray(0, SNIFF_BYTES))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  return XML_PREFIXES.some((prefix) => head.startsWith(prefix)) ? 'svg' : null;
}

/** Read a response body under the §12 byte cap, cancelling as soon as it is
 *  breached rather than buffering the whole oversized payload first. */
async function readCapped(body: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    // Releases the lock on the happy path and stops the transfer on the capped
    // one; `cancel` on an already-drained reader is a no-op.
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface FetchSourceLogoDeps {
  fetchImpl: FetchLike;
  url: string;
  /**
   * Needed because admission now includes a REAL RENDER of an SVG source (see
   * the svg branch below). Render capability crossing into intake is the
   * established shape here, not a novelty: the raster leg already imports
   * `decodeRasterSource` from the pack builder for the same reason — proving
   * the input works is worth more at intake, before an allowance is spent,
   * than anywhere downstream of it.
   */
  sources: WasmSources;
  /** Test seam for the §12 timeout; production takes the 15 s default. */
  timeoutMs?: number;
}

/**
 * Fetch the buyer's existing logo under every §12 guard, and measure it.
 *
 * Each refusal names what was wrong in words the buyer can act on: this is the
 * only feedback channel a $0 gig has, and "invalid input" tells a site owner
 * with a 200 px logo nothing about what to do next.
 *
 * The URL policy is re-applied here rather than assumed from
 * `parseFaviconBrief`. It costs one regex and closes the gap where a future
 * caller reaches this function with a URL from somewhere else — the whole SSRF
 * guard would otherwise depend on every call site remembering.
 *
 * Redirects are NOT followed (`redirect: 'manual'`, so a 3xx lands on the
 * not-ok branch below). A permitted host that 302s to 169.254.169.254 would
 * otherwise walk straight through a policy check made against the first URL
 * only, and re-checking every hop is not something `fetch` exposes.
 */
export async function fetchSourceLogo(deps: FetchSourceLogoDeps): Promise<SourceLogoResult> {
  const policy = checkLogoUrl(deps.url);
  if (!policy.ok) return { ok: false, reason: policy.reason };

  let response: Response;
  try {
    response = await deps.fetchImpl(policy.url.toString(), {
      redirect: 'manual',
      headers: { accept: 'image/png,image/jpeg,image/svg+xml' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return {
        ok: false,
        reason:
          `the server hosting your logo did not respond within ` +
          `${Math.round((deps.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS) / 1000)} seconds`,
      };
    }
    return {
      ok: false,
      reason: `your logo could not be fetched — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    const redirected = response.status >= 300 && response.status < 400;
    return {
      ok: false,
      reason: redirected
        ? `that URL redirects (HTTP ${response.status}); post the final direct link to the ` +
          'image file instead'
        : `the server hosting your logo returned HTTP ${response.status}`,
    };
  }

  if (!response.body) return { ok: false, reason: 'that URL returned an empty response' };
  const bytes = await readCapped(response.body);
  if (bytes === null) {
    return {
      ok: false,
      reason: `your logo is larger than ${MAX_SOURCE_BYTES / (1024 * 1024)} MB`,
    };
  }

  const kind = sniffKind(bytes);
  if (kind === null) {
    return {
      ok: false,
      reason:
        'that URL does not return a PNG, JPEG, or SVG image — LogoSmith checks the file ' +
        'itself, not the content-type header, and this one is neither',
    };
  }

  if (kind === 'svg') {
    // Vectors have no native resolution, so MIN_SOURCE_PX is waived. Sanitized
    // even though the favicon pack delivers no SVG: these bytes are still fed
    // to a renderer, and buyer-supplied markup carrying <script> or
    // <foreignObject> has no business reaching it (§12).
    // HTML ENTITIES, SUBSTITUTED BEFORE ANYTHING PARSES THIS.
    //
    // `&nbsp;`, `&mdash;` and friends are HTML-only: XML predefines five
    // entities and no others, so in an SVG they are a fatal parse error that
    // aborts the whole document. Illustrator, Figma and Sketch emit them
    // whenever a designer types a non-breaking space or an em dash into a
    // layer name, which lands one in `<title>`/`<desc>` — an ordinary,
    // well-meant, unrenderable logo. Substituting the allow-listed set for
    // their literal characters keeps that logo (measured: 0 opaque px before,
    // 169744 after), which is the right product outcome for the funnel that
    // exists to win customers. Anything NOT on the allow-list is left
    // untouched and falls to the render probe below.
    const svg = substituteHtmlEntities(sanitizeSvg(new TextDecoder().decode(bytes)));
    if (!svg.includes('<svg')) {
      return { ok: false, reason: 'that URL returned XML that contains no <svg> element' };
    }

    // WILL IT ACTUALLY DRAW? Two constructs render as NOTHING in this Worker,
    // and both produce a pack whose every gate passes over six blank icons —
    // the worst failure mode available, because it is indistinguishable from
    // success right up to the buyer opening the ZIP.
    //
    // The census comes from the true-vector gate rather than a fresh regex, but
    // the gate itself is deliberately NOT applied: `checkTrueVector` also
    // demands a viewBox and outlined paths, which are contract terms for the
    // PAID deliverable, not admission criteria for a buyer's existing logo.
    const census = checkTrueVector(svg).census;
    if (census.image > 0) {
      return {
        ok: false,
        reason:
          'that SVG is a wrapper around a bitmap rather than a real vector — it contains ' +
          `${census.image} embedded <image> element(s), and LogoSmith's renderer does not draw ` +
          'those, so every icon would come out blank. Post the bitmap itself (PNG or JPEG, ' +
          `longest edge at least ${MIN_SOURCE_PX}px) and it will be used directly`,
      };
    }
    if (census.text > 0) {
      return {
        ok: false,
        reason:
          `that SVG draws its lettering with ${census.text} live <text> element(s) rather than ` +
          'outlined paths. LogoSmith renders without font files, so the text would vanish and ' +
          'the icons would come out blank or partial. Re-export it with the text converted to ' +
          'outlines (most editors call this "convert to path" or "outline stroke")',
      };
    }

    // THE AUTHORITY: render it, through the exact wrapper the pack uses, and
    // require ink. The two census checks above catch the two constructs we
    // KNOW draw nothing; this catches the open-ended rest — a parse failure
    // anywhere in the document, which resvg reports by returning a fully
    // transparent pixmap rather than by throwing, because the buyer's SVG is
    // parsed as a nested data-URI sub-document. Nothing textual can stand in
    // for it: resvg's tolerances are resvg's, and this is the only check that
    // cannot be wrong about them.
    //
    // IT RUNS BEFORE `consumeFreeGigQuota`, which is the entire point. Every
    // input that cannot be rendered has to be refused while the refusal is
    // still free — the same check-early discipline the raster leg's
    // `decodeRasterSource` probe above exists for.
    if ((await svgDrawsInk(svg, deps.sources)) === 0) {
      // The wording is chosen from what is actually in the document, so the
      // commonest cause names itself instead of hiding behind "it did not
      // render". The scan is diagnostic only — the render above already made
      // the decision.
      const entities = scanEntityRefs(svg);
      if (entities.unresolved.length > 0 || entities.bareAmpersand) {
        const named = entities.unresolved
          .slice(0, 3)
          .map((name) => `&${name};`)
          .join(', ');
        return {
          ok: false,
          reason:
            'your SVG renders completely blank because it uses ' +
            (entities.unresolved.length > 0
              ? `HTML entities such as ${named} that XML does not define`
              : 'a bare "&" that XML reads as the start of an entity reference') +
            ' — SVG is XML, and one of these aborts the whole file rather than just the ' +
            'element it sits in. Re-export it (most editors will write plain characters), or ' +
            'replace them with the literal characters — and write a literal "&" as "&amp;"',
        };
      }
      return {
        ok: false,
        reason:
          'that SVG renders completely blank — LogoSmith drew it at ' +
          'full size and got an entirely empty image, so every icon in the pack would be ' +
          'empty too. This usually means the file is malformed somewhere its editor ' +
          'tolerates but a strict renderer does not. Re-export it from your design tool, or ' +
          `post the bitmap instead (PNG or JPEG, longest edge at least ${MIN_SOURCE_PX}px)`,
      };
    }
    return { ok: true, source: { kind: 'svg', svg } };
  }

  // HEADER ONLY. Neither branch decodes: the IHDR and the SOF frame header are
  // what a decoder would allocate from, so they answer both the minimum and the
  // maximum below without a decoder ever seeing these bytes.
  const size = kind === 'png' ? readPngDimensions(bytes) : readJpegDimensions(bytes);
  if (size === null) {
    return {
      ok: false,
      reason: `that URL returned a ${kind.toUpperCase()} whose image header could not be read`,
    };
  }

  // The bomb guard, BEFORE the minimum — an 8000x8000 source passes the
  // >= MIN_SOURCE_PX floor with room to spare, so the floor is no protection at
  // all against the input that actually fills the isolate.
  const pixels = size.width * size.height;
  if (pixels > MAX_SOURCE_PIXELS) {
    return {
      ok: false,
      reason:
        `your logo is ${size.width}x${size.height}px (${(pixels / 1_000_000).toFixed(1)} ` +
        `megapixels), and LogoSmith accepts up to ${MAX_SOURCE_PIXELS / 1_000_000} megapixels — ` +
        'an image that large costs more memory to open than a favicon job is allowed. Re-export ' +
        'it smaller: 2048x2048 is far more than enough for every icon in the pack. (A real ' +
        'vector SVG works too — but wrapping this same bitmap inside an SVG will not, and ' +
        'LogoSmith refuses those rather than shipping you blank icons.)',
    };
  }

  // PROVE IT DECODES, now that the decode is bounded by the check above.
  //
  // A walkable header says nothing about the entropy-coded payload behind it.
  // An ordinary truncated JPEG — a cut upload, a CDN that ended the response
  // early — walks perfectly and then traps the decoder. Finding that out HERE
  // costs a refusal with a reason; finding it out inside `buildFaviconPack`
  // costs a wasm panic escaping into the queue consumer, which logs it as
  // transient, retries, and dead-letters it having already spent the buyer's
  // allowance and told them nothing at all.
  const decoded = await decodeRasterSource(bytes);
  if (decoded === null) {
    return {
      ok: false,
      reason:
        `that URL returned a ${kind.toUpperCase()} whose image data could not be decoded — the ` +
        'file header is readable but the image itself is incomplete or corrupt, which usually ' +
        'means the upload or the download was cut short. Re-upload it and post the link again',
    };
  }
  // The header claimed a size; the decoder found one. They must agree, or the
  // number every guard above reasoned about was not the number that matters.
  if (decoded.width !== size.width || decoded.height !== size.height) {
    return {
      ok: false,
      reason:
        `that URL returned a ${kind.toUpperCase()} whose header claims ${size.width}x` +
        `${size.height}px but whose image data is ${decoded.width}x${decoded.height}px. ` +
        'LogoSmith will not work from a file that disagrees with itself',
    };
  }

  // The longest edge, because that is what the square favicon canvas is built
  // from: a source whose longest edge is >= MIN_SOURCE_PX letterboxes into a
  // 512 px icon without a single invented pixel, and one below it cannot. Using
  // the SHORTEST edge instead would reject the commonest logo there is — a wide
  // wordmark — for a resolution problem it does not have.
  const longestEdge = Math.max(size.width, size.height);
  if (longestEdge < MIN_SOURCE_PX) {
    return {
      ok: false,
      reason:
        `your logo is ${size.width}x${size.height}px, and its longest edge must be at least ` +
        `${MIN_SOURCE_PX}px — the pack includes a ${MIN_SOURCE_PX}px icon, and LogoSmith will ` +
        'not upscale artwork and call the result a deliverable. Re-post with a larger export, ' +
        'or a real vector SVG, which has no minimum',
    };
  }

  return { ok: true, source: { kind: 'raster', bytes, width: size.width, height: size.height } };
}
