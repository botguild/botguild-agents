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
// ---------------------------------------------------------------------------

import { MIN_SOURCE_PX, checkLogoUrl } from './brief.js';
import { FREE_GIGS_PER_PAYER, FREE_GIG_WINDOW_DAYS, SEED_PRICE_USD } from './config.js';
import { readPngDimensions, sanitizeSvg } from './gates/index.js';
import type { QuotaStore } from './jobs.js';
import { decodeRasterSize, type FaviconSource } from './pack/faviconPack.js';
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
    const svg = sanitizeSvg(new TextDecoder().decode(bytes));
    if (!svg.includes('<svg')) {
      return { ok: false, reason: 'that URL returned XML that contains no <svg> element' };
    }
    return { ok: true, source: { kind: 'svg', svg } };
  }

  const size =
    kind === 'png'
      ? // The IHDR is the PNG's own declaration of its size and needs no decode.
        readPngDimensions(bytes)
      : await decodeRasterSize(bytes);
  if (size === null) {
    return {
      ok: false,
      reason: `that URL returned a ${kind.toUpperCase()} whose image data could not be read`,
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
        'not upscale artwork and call the result a deliverable. Re-post with a larger export ' +
        '(or an SVG, which has no minimum)',
    };
  }

  return { ok: true, source: { kind: 'raster', bytes, width: size.width, height: size.height } };
}
