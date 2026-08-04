import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentClient } from '@botguild/agent-core';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import type { D1Like } from '@botguild/agent-core-workers';
import { MIN_SOURCE_PX, parseLogoBrief, type BriefResult } from './brief.js';
import {
  FREE_GIGS_PER_PAYER,
  FREE_GIG_WINDOW_DAYS,
  IMAGE_COST_USD,
  MAX_REGENS_PER_SLOT,
  MAX_SPEND_USD,
  SCOUT_MODEL_ID,
  SEED_PRICE_USD,
} from './config.js';
import {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_PIXELS,
  checkFreeGigQuota,
  fetchSourceLogo,
  readJpegDimensions,
  type SourceLogoResult,
} from './freeGigs.js';
import type { GenerateResult, Generator } from './generate.js';
import { readPngDimensions, sanitizeSvg, type OcrGate, type OcrOutcome } from './gates/index.js';
import {
  buildJobKey,
  createConceptStore,
  createJobStore,
  createQuotaStore,
  createSelectionStore,
  type JobStore,
  type QuotaStore,
} from './jobs.js';
import type { ModerationClient } from './moderation.js';
import type { ProseGig } from './proseBrief.js';
import { checkInk, svgDrawsInk } from './pack/faviconPack.js';
import { renderSvgToPng } from './pack/render.js';
import { nodeWasmSources } from './pack/wasm.node.js';
import { FAVICON_ZIP_ENTRIES, unzipFiles } from './pack/zip.js';
import {
  FREE_GIG_USAGE_GATE,
  processJobMessage,
  runConceptStage,
  runSingleStage,
  type DeliverableStore,
  type PipelineConfig,
  type PipelineServices,
} from './pipeline.js';
import { applyMigrations } from './testSupport.js';
import type { FetchLike, JobMessage, LogoBrief, StyleAxis } from './types.js';

const logger = createConsoleLogger({ service: 'logosmith-test', level: 'silent' });
const sources = nodeWasmSources();

const SQUARE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
  '<path d="M10 10 H90 V90 H10 Z" fill="#0F3D3E"/>' +
  '<circle cx="50" cy="50" r="22" fill="#E8C39E"/></svg>';

/**
 * Three broadband marks, pairwise far apart under the FR-6 pHash gate. Flat
 * swatches (or the same mark twice) would be demoted by the distinctness gate
 * and turn the paid-stage fixture below into a `partial` — which is Task 4's
 * ruling, restated here because the FR-18 test depends on a `delivered` M1.
 */
const markSvg = (inner: string): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">' +
  `<rect width="256" height="256" fill="#ffffff"/>${inner}</svg>`;

const MARK_SVGS: Record<string, string> = {
  leftHalf: markSvg('<rect width="128" height="256" fill="#000"/>'),
  topHalf: markSvg('<rect width="256" height="128" fill="#000"/>'),
  checker: markSvg(
    Array.from({ length: 64 }, (_, i) => {
      const x = (i % 8) * 32;
      const y = Math.floor(i / 8) * 32;
      return ((i % 8) + Math.floor(i / 8)) % 2 === 0
        ? `<rect x="${x}" y="${y}" width="32" height="32" fill="#000"/>`
        : '';
    }).join(''),
  ),
};

/** 2:3, so a 2000 px wide render is exactly 2000x3000 = MAX_SOURCE_PIXELS. */
const TALL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300" width="200" height="300">' +
  '<path d="M10 10 H190 V290 H10 Z" fill="#0F3D3E"/></svg>';

const fixtures: Record<string, Uint8Array> = {};

before(async () => {
  fixtures['png512'] = await renderSvgToPng(SQUARE_SVG, 512, sources);
  fixtures['png256'] = await renderSvgToPng(SQUARE_SVG, 256, sources);
  // Real, decodable rasters at the pixel budget's boundary and at the largest
  // size the paid pack itself renders.
  fixtures['png2048'] = await renderSvgToPng(SQUARE_SVG, 2048, sources);
  fixtures['png2000x3000'] = await renderSvgToPng(TALL_SVG, 2000, sources);
  for (const [name, svg] of Object.entries(MARK_SVGS)) {
    fixtures[name] = await renderSvgToPng(svg, 256, sources);
  }
});

// ---------------------------------------------------------------------------
// FR-14 — the free-gig quota
// ---------------------------------------------------------------------------

async function quotaStore(now: () => Date = () => new Date()): Promise<{
  quota: QuotaStore;
  db: D1Like;
}> {
  const db = createMemoryD1();
  await applyMigrations(db);
  return { quota: createQuotaStore(db, now), db };
}

/** Seed N used allowances for a payer through the real atomic path. */
async function seedUsage(quota: QuotaStore, payerId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const granted = await quota.consume(payerId, 'favicon', `${payerId}-seed-${i}`, {
      windowDays: FREE_GIG_WINDOW_DAYS,
      maxPerPayer: FREE_GIGS_PER_PAYER,
    });
    assert.ok(granted, `seeding allowance ${i} for ${payerId} must succeed`);
  }
}

describe('checkFreeGigQuota', () => {
  it('allows a payer with no history and counts down the remaining allowance', async () => {
    const { quota } = await quotaStore();
    assert.deepEqual(await checkFreeGigQuota(quota, 'payer-1'), {
      allowed: true,
      used: 0,
      remaining: FREE_GIGS_PER_PAYER,
    });

    await seedUsage(quota, 'payer-1', 1);
    assert.deepEqual(await checkFreeGigQuota(quota, 'payer-1'), {
      allowed: true,
      used: 1,
      remaining: FREE_GIGS_PER_PAYER - 1,
    });
  });

  it('refuses a payer at the cap with an actionable message, and again on the attempt after', async () => {
    const { quota } = await quotaStore();
    await seedUsage(quota, 'payer-1', FREE_GIGS_PER_PAYER);
    // Precondition: the store really holds the cap, so a refusal below cannot
    // be an artefact of a store that recorded nothing.
    assert.equal(await quota.countRecent('payer-1', FREE_GIG_WINDOW_DAYS), FREE_GIGS_PER_PAYER);

    const atCap = await checkFreeGigQuota(quota, 'payer-1');
    assert.equal(atCap.allowed, false);
    assert.equal(atCap.used, FREE_GIGS_PER_PAYER);
    assert.ok(atCap.allowed === false);
    // Actionable: names the cap, the window, and the way forward.
    assert.match(atCap.message, new RegExp(String(FREE_GIGS_PER_PAYER)));
    assert.match(atCap.message, new RegExp(`${FREE_GIG_WINDOW_DAYS}-day`));
    assert.match(atCap.message, new RegExp(`\\$${SEED_PRICE_USD}`));
    assert.match(atCap.message, /nothing has been charged/i);

    // The 4th attempt inside the window is refused too — a refusal that does
    // not record anything must not decay into an allowance next time.
    const fourth = await checkFreeGigQuota(quota, 'payer-1');
    assert.equal(fourth.allowed, false);
    assert.equal(fourth.used, FREE_GIGS_PER_PAYER);
  });

  it('does not count usage older than the rolling window', async () => {
    const clock = { at: new Date('2026-01-01T00:00:00.000Z') };
    const { quota } = await quotaStore(() => clock.at);
    await seedUsage(quota, 'payer-1', FREE_GIGS_PER_PAYER);
    assert.equal((await checkFreeGigQuota(quota, 'payer-1')).allowed, false);

    // One second past the window: every row has aged out.
    clock.at = new Date(clock.at.getTime() + FREE_GIG_WINDOW_DAYS * 86_400_000 + 1000);
    assert.deepEqual(await checkFreeGigQuota(quota, 'payer-1'), {
      allowed: true,
      used: 0,
      remaining: FREE_GIGS_PER_PAYER,
    });

    // ...and one second INSIDE it does not, so the assertion above is about the
    // boundary rather than about any clock movement at all.
    clock.at = new Date('2026-01-01T00:00:00.000Z');
    clock.at = new Date(clock.at.getTime() + FREE_GIG_WINDOW_DAYS * 86_400_000 - 1000);
    assert.equal((await checkFreeGigQuota(quota, 'payer-1')).allowed, false);
  });

  it('counts each payer separately', async () => {
    const { quota } = await quotaStore();
    await seedUsage(quota, 'payer-1', FREE_GIGS_PER_PAYER);
    assert.equal((await checkFreeGigQuota(quota, 'payer-1')).allowed, false);
    assert.equal((await checkFreeGigQuota(quota, 'payer-2')).allowed, true);
  });
});

// ---------------------------------------------------------------------------
// §12 — the fetch-time logoUrl guards
// ---------------------------------------------------------------------------

const LOGO_URL = 'https://cdn.example.com/logo.png';

const respondWith =
  (bytes: Uint8Array, status = 200): FetchLike =>
  async () =>
    new Response(bytes as unknown as BodyInit, { status });

const reason = (result: SourceLogoResult): string => {
  assert.equal(result.ok, false, 'expected a refusal');
  return result.ok ? '' : result.reason;
};

/**
 * A PNG whose IHDR declares `width x height` — the decompression-bomb fixture.
 *
 * Built by hand rather than rendered, precisely BECAUSE rendering an
 * 8000x8000 image is the thing under test: a real one costs ~490 MiB to
 * produce, which is the attack. A decoder's allocation comes from the IHDR, so
 * these bytes are exactly as dangerous to a decode-first implementation as a
 * complete file would be, and cost 40 bytes to carry.
 */
function pngDeclaring(width: number, height: number): Uint8Array {
  const out = new Uint8Array(8 + 4 + 4 + 13 + 8);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, 13); // IHDR payload length
  out.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  out[24] = 8; // bit depth
  out[25] = 6; // colour type: RGBA
  return out;
}

/** A JPEG whose SOF0 frame header declares `width x height`, behind a JFIF
 *  APP0 segment — so the fixture exercises the segment walk, not just an
 *  SOF that happens to sit at a fixed offset. */
function jpegDeclaring(width: number, height: number, marker = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [
    0xff,
    marker,
    0x00,
    0x11, // length 17
    0x08, // 8-bit precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // 3 components
    ...[1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

describe('readJpegDimensions', () => {
  it('walks the segment table to the frame header', () => {
    assert.deepEqual(readJpegDimensions(jpegDeclaring(512, 256)), { width: 512, height: 256 });
    assert.deepEqual(readJpegDimensions(jpegDeclaring(8000, 8000)), { width: 8000, height: 8000 });
  });

  it('reads a progressive frame header too, not only baseline', () => {
    // 0xC2 is the marker a photo saved "for web" actually carries; a parser
    // that only knew 0xC0 would silently return null for half of real JPEGs.
    assert.deepEqual(readJpegDimensions(jpegDeclaring(640, 480, 0xc2)), {
      width: 640,
      height: 480,
    });
  });

  it('reads a real encoder’s output', async () => {
    // Cross-checks the hand-built fixtures above against a genuine JPEG whose
    // dimensions are known independently (it is a re-encode of the 512 px PNG).
    const photon = await import('@cf-wasm/photon');
    const image = photon.PhotonImage.new_from_byteslice(fixtures['png512']!);
    const jpeg = new Uint8Array(image.get_bytes_jpeg(85));
    image.free();
    assert.deepEqual(readJpegDimensions(jpeg), { width: 512, height: 512 });
  });

  it('returns null rather than guessing when the header cannot be walked', () => {
    assert.equal(readJpegDimensions(new Uint8Array([0xff, 0xd8])), null, 'SOI with no frame');
    assert.equal(readJpegDimensions(fixtures['png512']!), null, 'a PNG is not a JPEG');
    assert.equal(readJpegDimensions(new Uint8Array(0)), null);
    // A truncated segment must not be walked past the end of the buffer.
    assert.equal(readJpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11])), null);
    // 0xC4 (DHT) sits inside the 0xC0-0xCF range but is NOT a frame header —
    // an allow-list rejects it; a "C0-CF except..." blocklist is what would let
    // a future marker through as if it carried dimensions.
    const dht = new Uint8Array([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x11, ...new Array(15).fill(0)]);
    assert.equal(readJpegDimensions(dht), null);
  });
});

describe('fetchSourceLogo — decompression bombs are refused from the header', () => {
  for (const [label, make] of [
    ['PNG', pngDeclaring],
    ['JPEG', jpegDeclaring],
  ] as const) {
    it(`refuses an 8000x8000 ${label} before anything decodes it`, async () => {
      const bomb = make(8000, 8000);
      // Preconditions: it is tiny on the wire and passes every OTHER guard —
      // well under the 10 MB cap and far ABOVE the MIN_SOURCE_PX floor. Neither
      // existing guard has anything to say about it, which is the point.
      assert.ok(bomb.byteLength < 1024, `${label} bomb is ${bomb.byteLength} bytes on the wire`);
      assert.ok(bomb.byteLength < MAX_SOURCE_BYTES);
      assert.ok(8000 > MIN_SOURCE_PX);
      assert.ok(8000 * 8000 > MAX_SOURCE_PIXELS);

      const result = await fetchSourceLogo({
        sources,
        fetchImpl: respondWith(bomb),
        url: LOGO_URL,
      });
      const text = reason(result);
      assert.match(text, /8000x8000px/);
      assert.match(text, /megapixels/);
      // The refusal must be the SIZE one. A decode-first implementation handed
      // these header-only bytes would fail to decode and say so instead — so
      // this also proves nothing decoded.
      assert.equal(/could not be read/.test(text), false, text);
    });
  }

  it('refuses a 16000x16000 source, which would decode to ~977 MiB', async () => {
    const result = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(pngDeclaring(16000, 16000)),
      url: LOGO_URL,
    });
    assert.match(reason(result), /16000x16000px/);
  });

  it('accepts a REAL source at the budget and refuses one just over it', async () => {
    // The boundary itself, so the ceiling is a real threshold rather than a
    // constant nothing is compared against. 2000x3000 = 6.0 Mpx exactly.
    //
    // The accepted side uses a genuinely decodable fixture, not a header: since
    // the validating decode landed, a bare header is refused for a DIFFERENT
    // reason, and a test that only ever fed headers could no longer tell a
    // working budget from a broken one.
    assert.equal(2000 * 3000, MAX_SOURCE_PIXELS);
    const ok = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(fixtures['png2000x3000']!),
      url: LOGO_URL,
    });
    assert.equal(ok.ok, true, 'a source exactly at the budget must be admitted');
    assert.deepEqual(readPngDimensions(fixtures['png2000x3000']!), { width: 2000, height: 3000 });

    const over = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(pngDeclaring(2001, 3000)),
      url: LOGO_URL,
    });
    assert.match(reason(over), /megapixels/);
  });

  it('admits every raster the paid pack itself produces', async () => {
    // A ceiling that rejected our own largest artifact would be wrong by
    // construction, so it is asserted rather than assumed.
    assert.ok(2048 * 2048 <= MAX_SOURCE_PIXELS);
    const result = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(fixtures['png2048']!),
      url: LOGO_URL,
    });
    assert.equal(result.ok, true);
  });
});

describe('fetchSourceLogo — §12 refusals', () => {
  it('refuses a body over the 10 MB cap', async () => {
    // Prefixed with a real PNG signature so this proves the SIZE guard rather
    // than accidentally tripping the type sniff.
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(fixtures['png512']!);
            for (let i = 0; i < 11; i++) controller.enqueue(new Uint8Array(1024 * 1024));
            controller.close();
          },
        }),
      );
    const result = await fetchSourceLogo({ sources, fetchImpl, url: LOGO_URL });
    assert.match(reason(result), /larger than 10 MB/);
    assert.equal(MAX_SOURCE_BYTES, 10 * 1024 * 1024);
  });

  it('refuses a body whose magic bytes are not PNG, JPEG, or SVG', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4\n%âãÏÓ');
    const result = await fetchSourceLogo({ sources, fetchImpl: respondWith(pdf), url: LOGO_URL });
    assert.match(reason(result), /does not return a PNG, JPEG, or SVG/);
  });

  it('does not trust the content-type header over the bytes', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(new TextEncoder().encode('not an image at all') as unknown as BodyInit, {
        headers: { 'content-type': 'image/png' },
      });
    const result = await fetchSourceLogo({ sources, fetchImpl, url: LOGO_URL });
    assert.match(reason(result), /does not return a PNG, JPEG, or SVG/);
  });

  it('refuses XML that declares itself but carries no <svg> element', async () => {
    const html = new TextEncoder().encode(
      '<!DOCTYPE html><html><body>404 — no svg here</body></html>',
    );
    const result = await fetchSourceLogo({ sources, fetchImpl: respondWith(html), url: LOGO_URL });
    assert.match(reason(result), /contains no <svg> element/);
  });

  it('refuses a raster below MIN_SOURCE_PX and says what to do about it', async () => {
    // Precondition: the fixture really is under the minimum.
    assert.deepEqual(readPngDimensions(fixtures['png256']!), { width: 256, height: 256 });
    const result = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(fixtures['png256']!),
      url: LOGO_URL,
    });
    const text = reason(result);
    assert.match(text, /256x256px/);
    assert.match(text, new RegExp(`at least ${MIN_SOURCE_PX}px`));
    assert.match(text, /will not upscale/);
  });

  it('refuses when the origin does not answer inside the timeout', async () => {
    // Exercises the real AbortSignal.timeout path, with the deadline shortened
    // by the documented test seam rather than the signal faked out.
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal, 'fetchSourceLogo must pass an abort signal');
        signal.addEventListener('abort', () => {
          reject((signal as AbortSignal & { reason: unknown }).reason);
        });
      });
    // `AbortSignal.timeout`'s internal timer is UNREF'd, so with a fetch that
    // never settles there would be nothing left to keep the loop alive and the
    // runner would tear the file down before the abort ever fired. One ref'd
    // timer holds the loop open for the 25 ms it takes.
    const keepAlive = setTimeout(() => undefined, 5_000);
    try {
      const result = await fetchSourceLogo({ sources, fetchImpl, url: LOGO_URL, timeoutMs: 25 });
      assert.match(reason(result), /did not respond within/);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('refuses a redirect rather than following an unchecked hop', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      assert.equal(init?.redirect, 'manual', 'redirects must not be followed');
      return new Response(null, { status: 302 });
    };
    const result = await fetchSourceLogo({ sources, fetchImpl, url: LOGO_URL });
    assert.match(reason(result), /redirects \(HTTP 302\)/);
  });

  it('refuses a URL the §12 policy rejects before any request is made', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response(fixtures['png512']! as unknown as BodyInit);
    };
    for (const url of [
      'http://cdn.example.com/logo.png',
      'https://169.254.169.254/logo.png',
      'https://localhost/logo.png',
    ]) {
      const result = await fetchSourceLogo({ sources, fetchImpl, url });
      assert.equal(result.ok, false, url);
    }
    assert.equal(calls, 0, 'a policy refusal must not reach the network');
  });

  it('gives every refusal its own distinct reason', async () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html></html>');
    const reasons = [
      reason(
        await fetchSourceLogo({
          sources,
          fetchImpl: respondWith(fixtures['png256']!),
          url: LOGO_URL,
        }),
      ),
      reason(
        await fetchSourceLogo({
          sources,
          fetchImpl: respondWith(new TextEncoder().encode('%PDF-1.4')),
          url: LOGO_URL,
        }),
      ),
      reason(await fetchSourceLogo({ sources, fetchImpl: respondWith(html), url: LOGO_URL })),
      reason(
        await fetchSourceLogo({
          sources,
          fetchImpl: respondWith(new Uint8Array(0), 503),
          url: LOGO_URL,
        }),
      ),
    ];
    assert.equal(new Set(reasons).size, reasons.length, JSON.stringify(reasons));
  });
});

describe('fetchSourceLogo — a walkable header is not a decodable image', () => {
  it('refuses a truncated JPEG with a buyer-facing reason instead of trapping the decoder', async () => {
    const photon = await import('@cf-wasm/photon');
    const image = photon.PhotonImage.new_from_byteslice(fixtures['png512']!);
    const jpeg = new Uint8Array(image.get_bytes_jpeg(90));
    image.free();
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length * 0.4));

    // Preconditions. This is an ORDINARY damaged file — a cut upload, a CDN
    // that ended the response early — and every earlier guard waves it through:
    // it sniffs as a JPEG, its header walks cleanly, and the size it declares
    // is inside both the floor and the budget. Only a decode can tell.
    assert.deepEqual([...truncated.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.deepEqual(readJpegDimensions(truncated), { width: 512, height: 512 });
    assert.throws(
      () => photon.PhotonImage.new_from_byteslice(truncated),
      /unreachable/,
      'the fixture must actually trap the decoder, or this test proves nothing',
    );

    const result = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(truncated),
      url: LOGO_URL,
    });
    const text = reason(result);
    assert.match(text, /could not be decoded/);
    assert.match(text, /incomplete or corrupt/);
    assert.match(text, /Re-upload/);
  });

  it('refuses a PNG that is only a header', async () => {
    const result = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(pngDeclaring(1024, 1024)),
      url: LOGO_URL,
    });
    assert.match(reason(result), /could not be decoded/);
  });

  it('leaves the decoder usable after a trap, so one bad job cannot poison the isolate', async () => {
    const photon = await import('@cf-wasm/photon');
    const image = photon.PhotonImage.new_from_byteslice(fixtures['png512']!);
    const truncated = new Uint8Array(image.get_bytes_jpeg(90)).subarray(0, 400);
    image.free();
    await fetchSourceLogo({ sources, fetchImpl: respondWith(truncated), url: LOGO_URL });

    const after = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(fixtures['png512']!),
      url: LOGO_URL,
    });
    assert.equal(after.ok, true, 'the next job must still work');
  });

  it('refuses a JPEG carrying two frame headers rather than believing the first', async () => {
    // The decoy: a real 3000x3000 frame with a small SOF spliced in front of
    // it. Trusting the FIRST SOF would budget for 0.36 Mpx and then decode 9.
    const decoy = new Uint8Array([
      ...jpegDeclaring(600, 600).subarray(0, jpegDeclaring(600, 600).length - 2),
      ...jpegDeclaring(3000, 3000).subarray(2),
    ]);
    assert.equal(readJpegDimensions(decoy), null, 'two frame headers must not resolve to one size');
    const result = await fetchSourceLogo({ sources, fetchImpl: respondWith(decoy), url: LOGO_URL });
    assert.match(reason(result), /header could not be read/);
  });

  it('refuses a source whose header and image data disagree', async () => {
    // Belt and braces for the property the comment now claims: even if some
    // future header parser could be talked into the wrong number, the decoded
    // truth is checked against it. Built by splicing a real 512 px PNG's body
    // onto an IHDR that declares 1024.
    const real = fixtures['png512']!;
    const lying = Uint8Array.from(real);
    new DataView(lying.buffer).setUint32(16, 1024);
    new DataView(lying.buffer).setUint32(20, 1024);
    assert.deepEqual(readPngDimensions(lying), { width: 1024, height: 1024 });

    const result = await fetchSourceLogo({ sources, fetchImpl: respondWith(lying), url: LOGO_URL });
    // photon rejects the corrupted IHDR CRC outright, so this lands on the
    // undecodable branch — either refusal is correct, and both are refusals.
    assert.equal(result.ok, false);
    assert.match(reason(result), /could not be decoded|disagrees with itself/);
  });
});

describe('fetchSourceLogo — an SVG that cannot draw is refused, not delivered blank', () => {
  const wrapperSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">' +
    '<image width="512" height="512" href="data:image/png;base64,AAAA"/></svg>';

  it('refuses an SVG that just wraps a bitmap', async () => {
    // THE SILENT FAILURE THIS CLOSES: resvg renders a top-level <image> but
    // does not resolve one nested inside a sub-tree, and the square wrapper
    // nests it — so this input used to produce six blank icons with every gate
    // passing, which is indistinguishable from success until the buyer opens
    // the ZIP. sanitizeSvg does not strip <image>, and the one gate that counts
    // it (checkTrueVector) is deliberately not applied to a buyer's own logo.
    assert.ok(sanitizeSvg(wrapperSvg).includes('<image'), 'sanitize must not be the guard here');

    const result = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(new TextEncoder().encode(wrapperSvg)),
      url: 'https://cdn.example.com/logo.svg',
    });
    const text = reason(result);
    assert.match(text, /wrapper around a bitmap/);
    assert.match(text, /blank/);
    assert.match(text, /Post the bitmap itself/);
  });

  it('refuses an SVG whose lettering is live text rather than outlines', async () => {
    // Same failure shape, different cause: nothing loads fonts in this Worker,
    // so <text> renders as nothing at all.
    const textSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">' +
      '<text x="10" y="50" font-size="40">Harbor</text></svg>';
    const result = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(new TextEncoder().encode(textSvg)),
      url: 'https://cdn.example.com/logo.svg',
    });
    assert.match(reason(result), /live <text> element/);
    assert.match(reason(result), /outlines/);
  });

  it('does not steer an over-budget raster towards the wrapped-bitmap trap', async () => {
    // The interaction that made this a funnel: the >6 Mpx refusal used to end
    // "or post an SVG, which has no such limit", pointing the buyer straight at
    // the input that silently produces blank icons and spends their allowance.
    const over = reason(
      await fetchSourceLogo({
        sources,
        fetchImpl: respondWith(pngDeclaring(8000, 8000)),
        url: LOGO_URL,
      }),
    );
    assert.equal(/SVG, which has no such limit/.test(over), false, over);
    assert.match(over, /wrapping this same bitmap inside an SVG will not/);
  });

  // -------------------------------------------------------------------------
  // HTML entities in XML — the reported Critical, and the class around it.
  //
  // The mechanism, measured: `squareSvgWrapper` base64-encodes the buyer's SVG
  // into a nested <image>, and resvg swallows a parse failure inside a nested
  // data-URI sub-document instead of throwing. So the free gig did not crash —
  // it DELIVERED six blank icons with every gate passing, spent the allowance,
  // and told the buyer it had worked.
  // -------------------------------------------------------------------------

  const svgWithTitle = (title: string): Uint8Array =>
    new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">' +
        `<title>${title}</title>` +
        '<path d="M50 50 H462 V462 H50 Z" fill="#0F3D3E"/></svg>',
    );
  const SVG_URL = 'https://cdn.example.com/logo.svg';

  it('KEEPS an ordinary designer SVG whose <title> carries &nbsp;', async () => {
    // THE REAL TRIGGER. Illustrator/Figma/Sketch emit &nbsp; whenever a
    // designer types a non-breaking space into a layer name. It is not defined
    // in XML, so it is a fatal parse error — but the logo itself is perfectly
    // good, and the funnel exists to win customers, so it is substituted
    // rather than refused.
    const bytes = svgWithTitle('Harbor&nbsp;&amp;&nbsp;Vine');
    // Pin the premise: nothing upstream neutralises the entity for us.
    assert.ok(
      sanitizeSvg(new TextDecoder().decode(bytes)).includes('&nbsp;'),
      'sanitizeSvg must not be the guard here',
    );

    const result = await fetchSourceLogo({ sources, fetchImpl: respondWith(bytes), url: SVG_URL });
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    assert.ok(result.ok);
    assert.ok(result.source.kind === 'svg');
    assert.equal(result.source.svg.includes('&nbsp;'), false, 'the entity is gone');
    // Escaped rather than typed: a literal U+00A0 is invisible in a diff, and
    // this assertion is entirely about which character is now there.
    assert.match(result.source.svg, /Harbor\u00A0&amp;\u00A0Vine/, 'replaced by the literal');
    // And the thing that actually matters: it now draws.
    assert.ok(await svgDrawsInk(result.source.svg, sources), 'the kept logo must render');
  });

  it('substitutes the rest of the allow-list, and leaves &amp; to the XML parser', async () => {
    const result = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(
        svgWithTitle('A&mdash;B&ndash;C&copy;D&trade;E&hellip;F&rsquo;G&amp;H'),
      ),
      url: SVG_URL,
    });
    assert.ok(result.ok && result.source.kind === 'svg');
    assert.equal(
      result.source.svg.match(/<title>(.*)<\/title>/)![1],
      'A—B–C©D™E…F’G&amp;H',
      '&amp; is one of XML’s own five and must survive untouched',
    );
  });

  it('refuses an entity that is NOT on the allow-list, and names it', async () => {
    // The allow-list is the safety argument: an unknown name is left alone,
    // stays unresolved, and takes this path rather than being guessed at.
    const result = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(svgWithTitle('Harbor&sparkles;Vine')),
      url: SVG_URL,
    });
    const text = reason(result);
    assert.match(text, /&sparkles;/, 'the refusal must name the actual entity');
    assert.match(text, /renders completely blank/);
    assert.match(text, /XML does not define/);
    assert.match(text, /re-export|replace them with the literal/i);
  });

  it('refuses a bare unescaped ampersand — the other thing designers type', async () => {
    const result = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(svgWithTitle('Harbor & Vine')),
      url: SVG_URL,
    });
    const text = reason(result);
    assert.match(text, /bare "&"/);
    assert.match(text, /&amp;/, 'and it must say what to write instead');
  });

  it('does NOT expand an entity the document itself declares (XXE stays refused)', async () => {
    // resvg refuses SYSTEM entities on its own; that refusal is a property to
    // keep, not to route around. The substitution is a fixed allow-list of
    // literals compiled into the source, so it cannot reach a definition that
    // came from the document — and the render probe turns resvg's refusal into
    // a buyer-facing message instead of a blank delivery.
    const xxe = new TextEncoder().encode(
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">' +
        '<title>&xxe;</title><path d="M50 50 H462 V462 H50 Z" fill="#0F3D3E"/></svg>',
    );
    const result = await fetchSourceLogo({ sources, fetchImpl: respondWith(xxe), url: SVG_URL });
    const text = reason(result);
    assert.equal(/root:/.test(text), false, 'no file content may ever reach the buyer');
    assert.match(text, /renders completely blank/);
    // `xxe` is declared by the document, so the scan must NOT blame it as an
    // undefined HTML entity — the generic wording is the honest one here.
    assert.equal(/&xxe;/.test(text), false, text);
  });

  it('ACCEPTS a sparse but real logo — refusing a valid one is as bad as a blank', async () => {
    // The measurement that set the probe size. A hairline monogram renders to
    // ZERO opaque pixels at 16px and 1568 at 512px, so probing small would
    // refuse this legitimate mark. See INK_PROBE_PX in pack/faviconPack.ts.
    const hairline = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
        '<path d="M254 60 h4 v392 h-4 Z" fill="#111"/></svg>',
    );
    const result = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(hairline),
      url: SVG_URL,
    });
    assert.equal(result.ok, true, result.ok ? '' : result.reason);

    // A thin 8:1 wordmark of hairline strokes — the sparsest realistic shape.
    const wordmark = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 64">' +
        Array.from(
          { length: 7 },
          (_, i) => `<rect x="${20 + i * 60}" y="28" width="3" height="8" fill="#111"/>`,
        ).join('') +
        '</svg>',
    );
    const wide = await fetchSourceLogo({ sources, fetchImpl: respondWith(wordmark), url: SVG_URL });
    assert.equal(wide.ok, true, wide.ok ? '' : wide.reason);
  });
});

describe('fetchSourceLogo — accepted sources', () => {
  it('accepts a valid PNG and reports its true dimensions', async () => {
    const result = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(fixtures['png512']!),
      url: LOGO_URL,
    });
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.deepEqual(
      {
        kind: result.source.kind,
        ...(result.source.kind === 'raster'
          ? { w: result.source.width, h: result.source.height }
          : {}),
      },
      { kind: 'raster', w: 512, h: 512 },
    );
  });

  it('accepts a valid SVG, waives the pixel minimum, and sanitizes it', async () => {
    const svg =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<script>fetch("https://evil.example.com")</script>' +
      '<path d="M1 1 H9 V9 H1 Z" onclick="alert(1)" fill="#000"/></svg>';
    const result = await fetchSourceLogo({
      sources,
      fetchImpl: respondWith(new TextEncoder().encode(svg)),
      url: 'https://cdn.example.com/logo.svg',
    });
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.equal(result.source.kind, 'svg');
    assert.ok(result.source.kind === 'svg');
    assert.equal(result.source.svg.includes('<script'), false);
    assert.equal(result.source.svg.includes('onclick'), false);
    assert.ok(result.source.svg.includes('<path'), 'the artwork itself must survive');
  });
});

// ---------------------------------------------------------------------------
// runSingleStage — the free funnel end to end
// ---------------------------------------------------------------------------

const CONTRACT_ID = 'contract-free-1';
const PAYER_ID = 'payer-1';

const FAVICON_DESCRIPTION = '```json\n' + JSON.stringify({ logoUrl: LOGO_URL }) + '\n```';
const TASTER_DESCRIPTION =
  '```json\n' + JSON.stringify({ brandName: 'Harbor & Vine', industry: 'boutique inn' }) + '\n```';

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
  milestoneId: string;
  note: string;
  attachments: string[];
}

const verdict = (pass: boolean, transcription = 'Harbor & Vine'): OcrOutcome => ({
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

const clearModeration: ModerationClient = {
  screen: async () => ({
    status: 'clear',
    verdict: {
      vendor: 'openai',
      model: 'omni-moderation',
      flagged: false,
      response: {},
      checkedAt: '2026-07-30T12:00:00.000Z',
    },
  }),
};

interface FreeHarness {
  config: PipelineConfig;
  jobKey: string;
  token: string;
  db: D1Like;
  jobs: JobStore;
  quota: QuotaStore;
  r2: MemoryR2;
  deliveries: Delivery[];
  messages: string[];
  fetches: string[];
  generated: number;
  message: JobMessage;
  /** Every gig handed to the prose-brief extractor, in call order. */
  extractorCalls: ProseGig[];
}

interface FreeOptions {
  description?: string;
  /** Response for the logoUrl fetch; defaults to the 512 px PNG fixture. */
  logoResponse?: () => Response;
  /** `attempt` is 1-based. */
  generate?: (attempt: number) => GenerateResult;
  ocr?: (attempt: number) => OcrOutcome;
  moderation?: ModerationClient;
  /** Free-gig rows to pre-seed for PAYER_ID before the stage runs. */
  priorFreeGigs?: number;
  /** Distinct contract, so several harnesses can share one payer and one D1. */
  contractId?: string;
  /** Share a database across harnesses — required for the concurrency test,
   *  where every attacker job must count against ONE quota table. */
  db?: D1Like;
  /** Test seam for the unreachable-by-input pack-gate failure branch. */
  faviconPack?: PipelineServices['faviconPack'];
  /** What the prose-brief extractor returns. Default: a refusal. */
  extractedBrief?: BriefResult<LogoBrief>;
}

async function setupFree(options: FreeOptions = {}): Promise<FreeHarness> {
  const contractId = options.contractId ?? CONTRACT_ID;
  const db = options.db ?? createMemoryD1();
  if (!options.db) await applyMigrations(db);
  const jobs = createJobStore(db);
  const quota = createQuotaStore(db);
  const jobKey = await buildJobKey(contractId, 'single');
  await jobs.claim(jobKey, contractId, 'single');
  const token = (await jobs.get(jobKey))!.deliverableToken!;

  await seedUsage(quota, PAYER_ID, options.priorFreeGigs ?? 0);

  const deliveries: Delivery[] = [];
  const messages: string[] = [];
  const client = {
    getContract: async (id: string) => ({
      id,
      gigId: 'gig-free-1',
      payerId: PAYER_ID,
      milestones: [{ id: 'm1' }],
    }),
    getGig: async () => ({
      id: 'gig-free-1',
      description: options.description ?? FAVICON_DESCRIPTION,
    }),
    deliverMilestone: async (
      _contractId: string,
      milestoneId: string,
      payload: { note: string; attachments?: string[] },
    ) => {
      deliveries.push({ milestoneId, note: payload.note, attachments: payload.attachments ?? [] });
    },
    sendMessage: async (_contractId: string, content: string) => {
      messages.push(content);
    },
  } as unknown as AgentClient;

  const harness: Partial<FreeHarness> = { generated: 0 };
  const fetches: string[] = [];
  const extractorCalls: ProseGig[] = [];
  const generator: Generator = {
    async generate() {
      harness.generated = (harness.generated ?? 0) + 1;
      return (options.generate ?? ((): GenerateResult => okFlux()))(harness.generated);
    },
  };
  const ocrGate: OcrGate = {
    async check() {
      return (options.ocr ?? ((): OcrOutcome => verdict(true)))(harness.generated ?? 1);
    },
  };

  const config: PipelineConfig = {
    jobs,
    concepts: createConceptStore(db),
    selection: createSelectionStore(db),
    quota,
    client,
    ai: { run: async () => ({}) },
    deliverables: memoryR2(),
    sources,
    secrets: {
      moderationApiKey: 'test',
      anthropicApiKey: 'test',
      ideogramApiKey: 'test',
      recraftApiKey: 'test',
      vectorizerToken: 'test',
      googleFontsApiKey: 'test',
    },
    fetchImpl: async (url) => {
      fetches.push(url);
      if (url === LOGO_URL) {
        return (
          options.logoResponse ?? (() => new Response(fixtures['png512']! as unknown as BodyInit))
        )();
      }
      throw new Error(`no test may reach ${url}`);
    },
    publicBaseUrl: 'https://logosmith.example.com',
    logger,
    services: {
      generator,
      ocrGate,
      moderation: options.moderation ?? clearModeration,
      ...(options.faviconPack ? { faviconPack: options.faviconPack } : {}),
      // ALWAYS wired. The real extractor builds an `@anthropic-ai/sdk` client,
      // and that client issues its requests through the GLOBAL `fetch` — the
      // network-refusing `fetchImpl` above never sees them. Left undefined,
      // this harness made a LIVE HTTPS call to api.anthropic.com on every
      // taster-brief resolution and passed off the 401 it got back as though it
      // were a brief-validation failure. Verified by observing the Anthropic
      // `request_id` in a test assertion diff.
      briefExtractor: {
        async extract(gig: ProseGig): Promise<BriefResult<LogoBrief>> {
          extractorCalls.push(gig);
          return options.extractedBrief ?? { ok: false, reason: 'this gig names no brand' };
        },
      },
    },
  };

  Object.assign(harness, {
    config,
    jobKey,
    token,
    db,
    jobs,
    quota,
    r2: config.deliverables as MemoryR2,
    deliveries,
    messages,
    fetches,
    extractorCalls,
    message: { contractId, jobKey, stage: 'single' as const },
  });
  return harness as FreeHarness;
}

const okFlux = (): GenerateResult => ({
  ok: true,
  costUsd: IMAGE_COST_USD.flux,
  concept: {
    axisId: 'taster-wordmark',
    vendor: 'flux',
    vendorRequestId: 'req-flux',
    png: fixtures['png512']!,
  },
});

const usage = (h: FreeHarness): Promise<number> =>
  h.quota.countRecent(PAYER_ID, FREE_GIG_WINDOW_DAYS);

describe('runSingleStage — the US-2 favicon gig', () => {
  it('delivers the favicon pack with ZERO vendor spend', async () => {
    const h = await setupFree();
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });

    const job = (await h.jobs.get(h.jobKey))!;
    assert.equal(job.kind, 'favicon');
    assert.equal(job.outcome, 'delivered');
    // AC3: the whole path is in-Worker CPU, so the ledger it wrote is $0.00 —
    // read from the persisted checkpoint, not from the absence of a mock call.
    assert.equal(job.checkpoint!.spendUsd, 0);
    assert.equal(job.spentUsd, 0);
    assert.equal(h.generated, 0, 'no image vendor may be called on the favicon gig');
    assert.deepEqual(h.fetches, [LOGO_URL], 'the only fetch is the buyer’s own logo');

    // The delivered link resolves to a real object, rather than merely matching
    // a string: the attachment is what the buyer clicks.
    assert.equal(h.deliveries.length, 1);
    const packUrl = h.deliveries[0]!.attachments[0]!;
    const key = packUrl.split('/deliverables/')[1]!;
    assert.equal(key, `${h.token}/pack.zip`);
    const stored = h.r2.objects.get(key)!;
    assert.equal(stored.contentType, 'application/zip');
    assert.deepEqual(Object.keys(unzipFiles(stored.bytes)).sort(), [...FAVICON_ZIP_ENTRIES].sort());

    assert.match(h.deliveries[0]!.note, new RegExp(`\\$${SEED_PRICE_USD}`));
    assert.equal(/escrow/i.test(h.deliveries[0]!.note), false, 'a $0 job has no escrow');
    assert.equal(await usage(h), 1, 'a delivered free job consumes exactly one allowance');
  });

  it('refuses over-quota payers before doing any work at all', async () => {
    const h = await setupFree({ priorFreeGigs: FREE_GIGS_PER_PAYER });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });

    assert.deepEqual(h.fetches, [], 'the logo must not even be fetched');
    assert.equal(h.deliveries.length, 0);
    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0]!, new RegExp(String(FREE_GIGS_PER_PAYER)));
    assert.equal((await h.jobs.get(h.jobKey))!.outcome, 'rejected');
    assert.equal(await usage(h), FREE_GIGS_PER_PAYER, 'a refusal records nothing');
  });

  it('does not consume an allowance when the buyer’s logo is refused', async () => {
    const h = await setupFree({
      logoResponse: () => new Response(fixtures['png256']! as unknown as BodyInit),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });
    assert.equal(await usage(h), 0, 'the buyer’s own bad input must not cost them a free job');
    assert.match(h.messages[0]!, new RegExp(`at least ${MIN_SOURCE_PX}px`));
    assert.match(h.messages[0]!, /not been counted against your free-job allowance/);
    assert.equal(h.deliveries.length, 0);
  });

  it('refuses an undecodable logo cleanly, with no allowance spent and the job resolved', async () => {
    // C4 end to end. Before the validating decode existed this input walked its
    // header, consumed the allowance, and then trapped photon inside
    // buildFaviconPack — a wasm panic escaping the queue consumer, which logged
    // it as transient and retried until the DLQ. The buyer was told nothing,
    // the job row never resolved, and one of their three allowances was gone.
    const photon = await import('@cf-wasm/photon');
    const image = photon.PhotonImage.new_from_byteslice(fixtures['png512']!);
    const truncated = new Uint8Array(image.get_bytes_jpeg(90)).subarray(0, 1200);
    image.free();
    assert.deepEqual(readJpegDimensions(truncated), { width: 512, height: 512 }, 'header walks');

    const h = await setupFree({
      logoResponse: () => new Response(truncated as unknown as BodyInit),
    });
    const result = await runSingleStage(h.config, h.message);

    assert.deepEqual(result, { outcome: 'aborted' }, 'must not throw into the queue');
    assert.equal(await usage(h), 0, 'an undecodable upload must not cost an allowance');
    assert.equal(await h.quota.holdsAllowance(CONTRACT_ID), false);
    const job = (await h.jobs.get(h.jobKey))!;
    assert.equal(job.outcome, 'rejected', 'the job must reach a terminal state');
    assert.equal(job.status, 'delivered');
    assert.equal(h.messages.length, 1, 'and the buyer must be told');
    assert.match(h.messages[0]!, /could not be decoded/);
    assert.match(h.messages[0]!, /not been counted against your free-job allowance/);
  });

  it('refuses a wrapped-bitmap SVG rather than delivering blank icons', async () => {
    // C5 end to end: the gates all pass over six empty PNGs, so nothing
    // downstream can catch this — only refusing at intake can.
    const wrapper =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">' +
      `<image width="512" height="512" href="data:image/png;base64,AAAA"/></svg>`;
    const h = await setupFree({
      logoResponse: () => new Response(new TextEncoder().encode(wrapper) as unknown as BodyInit),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });
    assert.equal(h.deliveries.length, 0);
    assert.equal(await usage(h), 0);
    assert.match(h.messages[0]!, /wrapper around a bitmap/);
  });

  it('consumes exactly one allowance across a redelivered message', async () => {
    const h = await setupFree();
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(await usage(h), 1);

    // Queue redelivery / DLQ replay of the same message.
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(await usage(h), 1, 'redelivery must not re-charge the allowance');
    assert.equal(h.deliveries.length, 1, 'and must not deliver twice');
  });

  it('consumes exactly one allowance when a queue retry re-runs the whole stage', async () => {
    // The redelivery test above is satisfied by the already-delivered
    // short-circuit. THIS one is about the case that short-circuit cannot
    // reach: an infra fault after the allowance was recorded but before the job
    // reached a terminal state, which is precisely what the queue retries.
    //
    // THE PAYER STARTS AT THE CAP MINUS ONE, deliberately. With any slack the
    // retry sails through no matter what the quota does, and the test cannot
    // observe the bug it exists for: the job's OWN usage row takes the payer to
    // the cap, so a retry that re-asks "is this payer under the cap?" refuses a
    // delivery we already paid for.
    let deliveries = 0;
    const h = await setupFree({ priorFreeGigs: FREE_GIGS_PER_PAYER - 1 });
    const client = h.config.client as unknown as {
      deliverMilestone: (
        c: string,
        m: string,
        p: { note: string; attachments?: string[] },
      ) => Promise<void>;
    };
    const real = client.deliverMilestone.bind(client);
    client.deliverMilestone = async (c, m, p) => {
      deliveries += 1;
      if (deliveries === 1) throw new Error('platform 502');
      await real(c, m, p);
    };

    await assert.rejects(runSingleStage(h.config, h.message), /platform 502/);
    assert.equal(
      await usage(h),
      FREE_GIGS_PER_PAYER,
      'the work was done, so this job holds the last slot',
    );
    assert.notEqual((await h.jobs.get(h.jobKey))!.status, 'delivered');

    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(await usage(h), FREE_GIGS_PER_PAYER, 'the retry must not re-charge the allowance');
  });

  it('rejects a gig whose brief validates as neither free shape', async () => {
    // Neither free shape AND no brand the extractor can find (harness default):
    // all three rungs have to miss for this to be a rejection.
    const h = await setupFree({ description: 'no fenced json here' });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });
    assert.equal((await h.jobs.get(h.jobKey))!.outcome, 'rejected');
    assert.equal(await usage(h), 0);
    assert.equal(h.extractorCalls.length, 1, 'the prose fallback was tried before giving up');
    assert.match(h.messages[0]!, /logoUrl/);
    assert.match(h.messages[0]!, /brand name/);
  });
});

describe('runSingleStage — the taster accepts prose briefs too (Task 27)', () => {
  const PROSE = 'A free sample logo for Harbor & Vine, our new seaside inn, please.';
  assert.equal(parseLogoBrief(PROSE).ok, false, 'precondition: the prose has no fenced brief');

  const EXTRACTED: LogoBrief = { brandName: 'Harbor & Vine', industry: 'seaside inn' };

  it('runs a prose taster gig instead of refusing the gig it just bid on', async () => {
    const h = await setupFree({
      description: PROSE,
      extractedBrief: { ok: true, brief: EXTRACTED },
    });

    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(h.extractorCalls.length, 1);
    assert.equal(h.deliveries.length, 1);
    assert.equal(await usage(h), 1, 'a delivered taster consumes exactly one allowance');
  });

  it('never pays for extraction on a favicon gig', async () => {
    // The favicon brief is checked FIRST and returns early — a `logoUrl` is
    // fetched, and `checkLogoUrl` is what guards it, so it is deliberately not
    // extended to prose.
    const h = await setupFree({});
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.deepEqual(h.extractorCalls, [], 'a favicon gig has no brand name to extract');
  });

  it('never pays for extraction when the taster gig carries a fenced brief', async () => {
    assert.equal(parseLogoBrief(TASTER_DESCRIPTION).ok, true, 'precondition: fenced resolves');
    const h = await setupFree({ description: TASTER_DESCRIPTION });

    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.deepEqual(h.extractorCalls, [], 'rung 2 resolved; rung 3 must never run');
  });

  it('consumes NO allowance when every rung misses', async () => {
    // THE PROPERTY THIS PATH EXISTS TO PROTECT. The rejection sits upstream of
    // `consumeFreeGigQuota` — which is reached only inside `runFaviconGig`
    // (after the source fetch) and `runTasterGig` (after the first image is
    // paid for). Adding a rung moved WHICH briefs validate, never WHERE the
    // rejection sits, so a refused brief still costs the buyer nothing.
    const h = await setupFree({ description: PROSE, extractedBrief: { ok: false, reason: 'x' } });

    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });
    assert.equal(await usage(h), 0, 'no free gig was burned on a brief we never processed');
    assert.equal((await h.jobs.get(h.jobKey))!.outcome, 'rejected');
    assert.match(h.messages[0]!, /has not been counted against your free-job allowance/);
  });

  it('tells the buyer prose is fine, without demanding JSON for the sample concept', async () => {
    const h = await setupFree({ description: PROSE });
    await runSingleStage(h.config, h.message);

    const note = h.messages[0]!;
    assert.doesNotMatch(
      note,
      /a free sample concept needs one with a Latin-script/,
      'the stale sentence that told the buyer a sample concept needs a fenced block',
    );
    assert.match(note, /plain prose is/i);
    // The favicon half genuinely still needs a fenced block, and must keep
    // saying so — only one of the two free shapes changed.
    assert.match(note, /favicon pack needs a fenced\s+JSON block/);
  });
});

describe('runSingleStage — the US-3 taster', () => {
  it('delivers honestly when the readback FAILS, and names the $25 gig', async () => {
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      ocr: () => verdict(false, 'HRBRVN'),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });

    // Non-blocking: three attempts were spent trying for a pass, and the sample
    // shipped regardless.
    assert.equal(h.generated, 1 + MAX_REGENS_PER_SLOT);
    assert.equal(h.deliveries.length, 1);
    const note = h.deliveries[0]!.note;
    assert.match(note, /Lettering readback: FAIL/);
    assert.match(note, /HRBRVN/);
    assert.match(note, new RegExp(`\\$${SEED_PRICE_USD}`));
    assert.match(note, /lettering-specialist model path/);
    assert.equal(/escrow/i.test(note), false);

    const job = (await h.jobs.get(h.jobKey))!;
    assert.equal(job.kind, 'taster');
    assert.equal(job.outcome, 'delivered', 'a failed readback is still a delivery');
    assert.ok(h.r2.objects.has(`${h.token}/concept-1.png`), 'the sample itself must exist');
    assert.equal(await usage(h), 1);
  });

  it('stops as soon as the readback passes and delivers that concept', async () => {
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      ocr: (attempt) => verdict(attempt >= 2, attempt >= 2 ? 'Harbor & Vine' : 'HRBRVN'),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(h.generated, 2, 'no regeneration after a pass');
    assert.match(h.deliveries[0]!.note, /Lettering readback: PASS/);
  });

  it('keeps the best-scoring attempt rather than the last one', async () => {
    const scores = [0.6, 0.2, 0.3];
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      ocr: (attempt) => ({
        status: 'ok',
        verdict: {
          model: SCOUT_MODEL_ID,
          transcription: `attempt-${attempt}`,
          score: scores[attempt - 1]!,
          pass: false,
          unsafe: false,
          checkedAt: '2026-07-30T12:00:00.000Z',
        },
      }),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(h.generated, 3);
    assert.match(h.deliveries[0]!.note, /attempt-1/);
    assert.match(h.deliveries[0]!.note, /\(0\.60,/);
  });

  it('spends only klein money, well inside the FR-5 cap', async () => {
    const h = await setupFree({ description: TASTER_DESCRIPTION, ocr: () => verdict(false) });
    await runSingleStage(h.config, h.message);
    const spent = (await h.jobs.get(h.jobKey))!.checkpoint!.spendUsd;
    assert.equal(spent, IMAGE_COST_USD.flux * (1 + MAX_REGENS_PER_SLOT));
    assert.ok(spent < MAX_SPEND_USD);
  });

  it('parks on a moderation outage without consuming an allowance', async () => {
    const outage: ModerationClient = {
      screen: async () => ({ status: 'unavailable', error: 'connect ETIMEDOUT' }),
    };
    const h = await setupFree({ description: TASTER_DESCRIPTION, moderation: outage });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'parked' });
    assert.equal(h.generated, 0, 'never generate from an unscreened brief');
    assert.equal(await usage(h), 0, 'our vendor’s outage must not cost the buyer a free job');
    assert.equal((await h.jobs.get(h.jobKey))!.status, 'parked');
  });

  it('parks on a klein outage without consuming an allowance', async () => {
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      generate: () => ({ ok: false, retryable: true, error: 'workers ai returned 503' }),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'parked' });
    assert.equal(await usage(h), 0);
    assert.equal((await h.jobs.get(h.jobKey))!.parkReason, 'vendor_outage');
  });

  it('resumes a parked taster against its remaining attempts, not a fresh set', async () => {
    // First run: one attempt, then the vision gate goes down mid-job.
    let ocrDown = true;
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      ocr: () => (ocrDown ? { status: 'unavailable', error: 'ai binding 500' } : verdict(false)),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'parked' });
    assert.equal(h.generated, 1);
    assert.equal(await usage(h), 1, 'work had already started, so the allowance is spent');

    // The cron unparks and re-enqueues; the gate is back.
    ocrDown = false;
    await h.jobs.unpark(h.jobKey);
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(h.generated, 1 + MAX_REGENS_PER_SLOT, 'the first attempt still counted');
    assert.equal(await usage(h), 1, 'and the resume does not re-charge the allowance');
  });

  it('delivers nothing when the vendor refuses every attempt', async () => {
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      generate: () => ({ ok: false, retryable: false, error: 'prompt rejected' }),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });
    assert.equal(h.deliveries.length, 0);
    assert.match(h.messages[0]!, /nothing for you to cancel/);
    assert.equal(/escrow/i.test(h.messages[0]!), false);
    assert.equal(await usage(h), 0, 'nothing was generated, so nothing was consumed');
  });

  // T23'S OWN PRINCIPLE, APPLIED TO THE ONE BRANCH THAT DID NOT HONOUR IT:
  // "a free allowance must never be spent on OUR failure." The consume-late
  // design protects the buyer right up to the point of no return, and then
  // kept the allowance whatever happened after it.
  it('CRITICAL: releases the allowance when an OCR outage burns the whole budget', async () => {
    // The vision gate is down for this taster's entire life. Each attempt
    // generates (paid), parks, and is re-enqueued; after the FR-5 allowance is
    // exhausted the loop exits with no verdict and no r2Key, so nothing ships.
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      ocr: () => ({ status: 'unavailable' as const, error: 'ai binding 500' }),
    });

    let outcome = await runSingleStage(h.config, h.message);
    let cycles = 0;
    while (outcome.outcome === 'parked' && cycles < 10) {
      await h.jobs.unpark(h.jobKey);
      outcome = await runSingleStage(h.config, h.message);
      cycles += 1;
    }

    // Fixture preconditions, inline — this must be the scenario it claims to
    // be, not merely a run that ended aborted.
    assert.deepEqual(outcome, { outcome: 'aborted' });
    assert.equal(h.generated, 1 + MAX_REGENS_PER_SLOT, 'the images WERE generated and paid for');
    const job = await h.jobs.get(h.jobKey);
    assert.equal(job!.checkpoint!.slots[0]!.ocr, undefined, 'and never got a verdict');
    assert.equal(job!.checkpoint!.slots[0]!.r2Key, undefined);
    assert.equal(h.deliveries.length, 0);

    // THE FIX: the allowance is given back, and the buyer is told so.
    assert.equal(await usage(h), 0, 'our vendor’s outage must not cost the buyer a free job');
    const trail = await h.jobs.listGateAudit(h.jobKey, FREE_GIG_USAGE_GATE);
    assert.ok(trail.some((row) => row.result === 'released'));

    // ...and the copy is true. It used to say "the image model refused every
    // attempt (no image was returned)" and "nothing has been charged" — false
    // on both counts here, with the allowance quietly kept on top.
    const note = h.messages.at(-1)!;
    assert.match(note, /did generate at least one sample image/);
    assert.match(note, /NOT been counted against your free-job allowance/);
    assert.doesNotMatch(note, /refused every attempt/);
    assert.doesNotMatch(note, /no image was returned/);
  });

  it('still names a genuine vendor refusal as one, with no images claimed', async () => {
    // CONTROL for the message above: the other branch of the same leg. Zero
    // generations, so the wording must not claim any.
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      generate: () => ({ ok: false, retryable: false, error: 'prompt rejected' }),
    });
    await runSingleStage(h.config, h.message);
    const note = h.messages.at(-1)!;
    assert.match(note, /refused every attempt/);
    assert.doesNotMatch(note, /did generate at least one sample image/);
  });
});

describe('runSingleStage — the quota holds under concurrency (the farming attack)', () => {
  it('delivers exactly the cap when many free gigs for one payer run at once', async () => {
    // THE ATTACK. One payer funds N free gigs at once. Queue consumers scale to
    // concurrent invocations and one funded $0 gig is one message, so
    // `max_batch_size: 1` bounds nothing here. Under a read-then-write quota
    // every job that entered during another's source fetch passed the check:
    // measured 12 delivered against a cap of 3.
    const concurrency = 12;
    assert.ok(
      concurrency > FREE_GIGS_PER_PAYER,
      'the attack must exceed the cap to prove anything',
    );

    // ONE database and ONE payer: the whole point is that these jobs contend.
    const db = createMemoryD1();
    await applyMigrations(db);
    const harnesses = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        setupFree({ db, contractId: `contract-concurrent-${i}` }),
      ),
    );
    // Precondition: they really do share a quota table and a payer.
    assert.equal(await harnesses[0]!.quota.countRecent(PAYER_ID, FREE_GIG_WINDOW_DAYS), 0);
    assert.equal(new Set(harnesses.map((h) => h.jobKey)).size, concurrency, 'distinct jobs');

    const outcomes = await Promise.all(harnesses.map((h) => runSingleStage(h.config, h.message)));

    const delivered = outcomes.filter((o) => o.outcome === 'delivered').length;
    const packsWritten = harnesses.filter((h) => h.r2.objects.has(`${h.token}/pack.zip`)).length;
    const rows = await harnesses[0]!.quota.countRecent(PAYER_ID, FREE_GIG_WINDOW_DAYS);

    assert.equal(
      delivered,
      FREE_GIGS_PER_PAYER,
      `delivered ${delivered}, cap ${FREE_GIGS_PER_PAYER}`,
    );
    assert.equal(rows, FREE_GIGS_PER_PAYER, `quota rows ${rows}, cap ${FREE_GIGS_PER_PAYER}`);
    assert.equal(packsWritten, FREE_GIGS_PER_PAYER, 'only capped jobs may produce a deliverable');
    // Everyone else is refused, and told so.
    assert.equal(
      outcomes.filter((o) => o.outcome === 'aborted').length,
      concurrency - FREE_GIGS_PER_PAYER,
    );
    for (const h of harnesses) {
      const job = (await h.jobs.get(h.jobKey))!;
      assert.ok(['delivered', 'rejected'].includes(job.outcome ?? ''), job.outcome ?? 'null');
      if (job.outcome === 'rejected')
        assert.ok(h.messages.length > 0, 'a refusal must be explained');
    }
  });

  it('never lets a taster generation escape the cap either', async () => {
    const concurrency = 8;
    const db = createMemoryD1();
    await applyMigrations(db);
    const harnesses = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        setupFree({ db, contractId: `contract-taster-${i}`, description: TASTER_DESCRIPTION }),
      ),
    );
    const outcomes = await Promise.all(harnesses.map((h) => runSingleStage(h.config, h.message)));
    assert.equal(outcomes.filter((o) => o.outcome === 'delivered').length, FREE_GIGS_PER_PAYER);
    assert.equal(
      await harnesses[0]!.quota.countRecent(PAYER_ID, FREE_GIG_WINDOW_DAYS),
      FREE_GIGS_PER_PAYER,
    );
    // A job refused at the point of no return has already paid for its image —
    // that is unavoidable, since losing the race is only knowable by trying —
    // but it must not DELIVER, and the overspend is bounded by one klein call
    // each rather than by the attacker's patience.
    const refused = harnesses.filter((h) => h.deliveries.length === 0);
    assert.equal(refused.length, concurrency - FREE_GIGS_PER_PAYER);
    for (const h of refused) assert.ok(h.generated <= 1, 'at most one generation per losing job');
  });

  it('tells a loser the truth about what was already generated for it', async () => {
    // The refusal at the point of no return sits IMMEDIATELY AFTER a paid klein
    // call on the taster path. Reusing the entry check's copy there would ship
    // "Nothing has been generated and nothing has been charged" to a buyer for
    // whom the first clause is false — the same falsified sentence Task 22's
    // give-up note was corrected for, reappearing inside the fix for it.
    //
    // The race is forced deterministically rather than run for real: the payer
    // is under the cap when the ADVISORY entry check reads (so the job starts
    // and generates), and at the cap by the time `consume` decides. Racing two
    // real jobs would reproduce it only sometimes, and a test that sometimes
    // exercises the branch is a test that sometimes proves nothing.
    const h = await setupFree({ description: TASTER_DESCRIPTION });
    const real = h.config.quota;
    (h.config as { quota: QuotaStore }).quota = {
      countRecent: async () => 0, // entry check: plenty of room
      holdsAllowance: (contractId) => real.holdsAllowance(contractId),
      consume: async () => false, // ...and the last slot went while we generated
      release: (contractId) => real.release(contractId),
    };

    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });
    assert.equal(h.generated, 1, 'the klein call must have happened before the refusal');
    assert.equal(h.deliveries.length, 0, 'and nothing may be delivered');

    const note = h.messages[0]!;
    assert.equal(
      /Nothing has been generated/i.test(note),
      false,
      `a job that generated an image must not claim otherwise: ${note}`,
    );
    assert.match(note, /already generated a sample image/);
    assert.match(note, /you have not been charged/i);
    assert.match(note, /allowance ran out while this one was already running/);
    assert.equal(/escrow/i.test(note), false);
  });
});

describe('runSingleStage — an unrenderable SVG never reaches the allowance', () => {
  const svgResponse = (title: string, art = '<path d="M50 50 H462 V462 H50 Z" fill="#0F3D3E"/>') =>
    new Response(
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" ' +
          `height="512"><title>${title}</title>${art}</svg>`,
      ) as unknown as BodyInit,
    );

  it('refuses before consuming, and names the entity', async () => {
    // WHAT THIS USED TO DO, measured on the real pipeline before the fix:
    // outcome 'delivered', usage 1, holdsAllowance true, ZERO buyer messages,
    // and a ZIP of six fully transparent icons under a note reading "your
    // favicon package for cdn.example.com". A DLQ would at least have alerted
    // an operator; this alerted nobody.
    const h = await setupFree({ logoResponse: () => svgResponse('Harbor&sparkles;Vine') });

    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });

    // THE ALLOWANCE IS THE POINT. The refusal happens at intake, upstream of
    // consumeFreeGigQuota, so the buyer keeps all three free gigs.
    assert.equal(await usage(h), 0, 'no allowance may be consumed for a buyer-input refusal');
    assert.equal(await h.quota.holdsAllowance(CONTRACT_ID), false);
    assert.equal(h.deliveries.length, 0, 'and nothing may be delivered');
    assert.equal(h.r2.objects.has(`${h.token}/pack.zip`), false);
    assert.equal((await h.jobs.get(h.jobKey))!.outcome, 'rejected');

    // And the buyer is actually told, in terms they can act on.
    assert.equal(h.messages.length, 1, 'the buyer must be told exactly once');
    const note = h.messages[0]!;
    assert.match(note, /&sparkles;/);
    assert.match(note, /renders completely blank/);
    assert.match(note, /has not been counted against your free-job allowance/);
  });

  it('DELIVERS the &nbsp; logo, with icons that are not blank', async () => {
    // The reported trigger, end to end: substituted at intake, so the buyer
    // gets their pack instead of a refusal — and the icons carry real ink.
    const h = await setupFree({ logoResponse: () => svgResponse('Harbor&nbsp;&amp;&nbsp;Vine') });

    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(await usage(h), 1, 'a delivered pack does consume the allowance');

    const zip = h.r2.objects.get(`${h.token}/pack.zip`)!;
    const files = unzipFiles(zip.bytes);
    const ink = await checkInk(files['icon-512.png']!, 'icon-512.png');
    assert.equal(ink.pass, true, 'the delivered icon must not be blank');
    assert.ok(ink.opaquePixels! > 1000, `expected real ink, got ${ink.opaquePixels}`);

    // The gate report the buyer reads must state it, not just compute it.
    assert.match(h.deliveries[0]!.note, /Icons are not blank: PASS/);
  });

  it('releases the allowance when the pack builder THROWS', async () => {
    // The belt-and-braces wrapper around services.faviconPack. Stated plainly
    // because a wrapper whose comment overclaims is worse than none: this does
    // NOT fire on the &nbsp; class — that render returns blank rather than
    // throwing, and is stopped at intake — so the only way to reach the branch
    // is the injected builder, exactly as the gate-failure test above does.
    // What it covers is a genuine throw from the render/resize/encode chain,
    // which would otherwise escape to the queue consumer, be logged as
    // transient, retried, and dead-lettered with the allowance already spent.
    const h = await setupFree({
      faviconPack: async () => {
        throw new Error('wasm trap: unreachable');
      },
    });

    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });
    assert.equal(await usage(h), 0, 'our failure, so the allowance must go back');
    assert.equal(await h.quota.holdsAllowance(CONTRACT_ID), false);
    assert.equal(h.deliveries.length, 0);
    assert.equal((await h.jobs.get(h.jobKey))!.outcome, 'aborted');
    assert.match(h.messages[0]!, /could not build your favicon package/);
    assert.match(h.messages[0]!, /NOT been counted against your free-job allowance/);
  });
});

describe('runSingleStage — a favicon pack that fails its own gates is not delivered', () => {
  it('ships nothing and says why when the pack gates fail', async () => {
    // No INPUT can reach this branch — every PNG is letterboxed to its exact
    // contracted size, the ICO is built from those same PNGs, and the ZIP entry
    // list is a constant — so it is defence in depth, and the injected builder
    // is the only way to prove it actually blocks a delivery rather than just
    // computing a report nobody acts on.
    const h = await setupFree({
      faviconPack: async () => ({
        zip: new Uint8Array([1, 2, 3]),
        files: {},
        gates: {
          dimensions: [
            {
              file: 'favicon-16.png',
              pass: false,
              actual: { width: 15, height: 16 },
              expected: { width: 16, height: 16 },
            },
          ],
          ico: { pass: false, sizes: [], reason: 'buffer did not parse as an ICO' },
          zip: { pass: true, present: [], missing: [], reasons: [] },
          ink: { file: 'icon-512.png', opaquePixels: 169744, pass: true },
          pass: false,
        },
      }),
    });

    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });
    assert.equal(h.deliveries.length, 0, 'a failing pack must never be delivered');
    assert.equal(h.r2.objects.has(`${h.token}/pack.zip`), false, 'and must never be stored');
    assert.equal((await h.jobs.get(h.jobKey))!.outcome, 'aborted');

    // The buyer is told which gate failed, in the gate's own measured terms.
    const note = h.messages[0]!;
    assert.match(note, /did not clear its own delivery gates/);
    assert.match(note, /favicon-16\.png is 15x16, expected 16x16/);
    assert.match(note, /did not parse as an ICO/);
    assert.equal(/escrow/i.test(note), false, 'a $0 job has no escrow');
  });
});

describe('processJobMessage — the free stage is routed, not refused', () => {
  it('routes a single message into the free-gig stage', async () => {
    const h = await setupFree();
    await processJobMessage(h.config, h.message);
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.deliveries[0]!.milestoneId, 'm1');
  });
});

// ---------------------------------------------------------------------------
// FR-18 — the properties a warranty re-run WOULD inherit. NOT SHIPPED.
//
// READ THIS BEFORE TRUSTING THE NAME BELOW. There is no warranty re-run in this
// bot: no thread trigger, and no code path that mints a `#revision-N` claim key
// — the test constructs that key itself. `grep -rn "revision" src/ --include
// '*.ts'` outside the tests returns only prose. Task 23's ruling deliberately
// left the whole path unbuilt (any scheme must preserve the original `concepts`
// and `gate_audit` rows, which the obvious one collides with), and the
// buyer-facing copy no longer promises it.
//
// What these tests DO establish is real and worth keeping: IF such a path is
// ever built on a per-revision claim key, it inherits a fresh FR-5 cap and
// consumes no free-gig allowance. They characterise a design constraint for
// whoever builds it. They are not evidence that anything triggers it.
// ---------------------------------------------------------------------------

describe('a warranty re-run would inherit a fresh cap and no quota cost (FR-18, path unbuilt)', () => {
  const AXES: StyleAxis[] = [
    { id: 'wordmark', label: 'wordmark', prompt: 'p1', vendor: 'ideogram' },
    { id: 'lockup', label: 'lockup', prompt: 'p2', vendor: 'ideogram' },
    { id: 'emblem', label: 'emblem', prompt: 'p3', vendor: 'recraft' },
  ];

  /**
   * A paid concept-stage harness whose quota store EXPLODES if anything writes
   * to it. The FR-18 requirement "does not consume the buyer's free-gig quota"
   * is a claim about the paid pipeline, and the only way to prove a call never
   * happens is to make it fail loudly if it does.
   */
  async function setupPaid(contractKey: string): Promise<{
    config: PipelineConfig;
    jobKey: string;
    jobs: JobStore;
    quota: QuotaStore;
    generated: () => number;
    db: D1Like;
  }> {
    const db = createMemoryD1();
    await applyMigrations(db);
    return withDb(db, contractKey);
  }

  async function withDb(
    db: D1Like,
    contractKey: string,
  ): Promise<{
    config: PipelineConfig;
    jobKey: string;
    jobs: JobStore;
    quota: QuotaStore;
    generated: () => number;
    db: D1Like;
  }> {
    const jobs = createJobStore(db);
    const realQuota = createQuotaStore(db);
    // Every WRITE path explodes. The FR-18 requirement "does not consume the
    // buyer's free-gig quota" is a claim about the paid pipeline, and the only
    // way to prove a call never happens is to make it fail loudly if it does.
    const quota: QuotaStore = {
      countRecent: (payerId, days) => realQuota.countRecent(payerId, days),
      holdsAllowance: () => {
        throw new Error('the paid pipeline must never consult the free-gig quota');
      },
      consume: () => {
        throw new Error('the paid pipeline must never consume a free-gig allowance');
      },
      release: () => {
        throw new Error('the paid pipeline must never touch a free-gig allowance');
      },
    };
    const jobKey = await buildJobKey(contractKey, 'concepts');
    await jobs.claim(jobKey, CONTRACT_ID, 'concepts');

    let generated = 0;
    const marks = [fixtures['leftHalf']!, fixtures['topHalf']!, fixtures['checker']!];
    const config: PipelineConfig = {
      jobs,
      concepts: createConceptStore(db),
      selection: createSelectionStore(db),
      quota,
      client: {
        getContract: async (id: string) => ({
          id,
          gigId: 'gig-paid-1',
          payerId: PAYER_ID,
          milestones: [{ id: 'm1' }, { id: 'm2' }],
        }),
        getGig: async () => ({ id: 'gig-paid-1', description: TASTER_DESCRIPTION }),
        deliverMilestone: async () => undefined,
        sendMessage: async () => undefined,
      } as unknown as AgentClient,
      ai: { run: async () => ({}) },
      deliverables: memoryR2(),
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
        // Same idiom as the exploding quota store above, for the same reason.
        // This harness's gig carries a fenced brief, so extraction must never
        // run — but that is a property of a FIXTURE, and a fixture can change.
        // Left undefined, the real extractor builds an `@anthropic-ai/sdk`
        // client that reaches api.anthropic.com through the GLOBAL `fetch`,
        // which the network-refusing `fetchImpl` above does not intercept. This
        // makes "extraction never runs here" fail loudly instead of silently
        // becoming a live HTTPS call.
        briefExtractor: {
          extract: () => {
            throw new Error('no test may reach the network (prose brief extractor)');
          },
        },
        generator: {
          async generate(axis) {
            generated += 1;
            return {
              ok: true,
              costUsd: IMAGE_COST_USD.ideogram,
              concept: {
                axisId: axis.id,
                vendor: axis.vendor,
                vendorRequestId: `req-${axis.id}`,
                png: marks[AXES.findIndex((a) => a.id === axis.id)]!,
              },
            };
          },
        },
        ocrGate: { check: async () => verdict(true) },
        moderation: clearModeration,
        axisCompiler: { compile: async () => AXES.map((a) => ({ ...a })) },
      },
    };
    return { config, jobKey, jobs, quota, generated: () => generated, db };
  }

  it('re-runs generation under a fresh FR-5 cap and consumes no free-gig allowance', async () => {
    const first = await setupPaid(CONTRACT_ID);
    await runConceptStage(first.config, {
      contractId: CONTRACT_ID,
      jobKey: first.jobKey,
      stage: 'concepts',
    });
    const firstJob = (await first.jobs.get(first.jobKey))!;
    // Precondition: the original round really did spend, so "fresh" below is a
    // statement about a budget that had something to inherit.
    assert.equal(firstJob.outcome, 'delivered');
    assert.ok(firstJob.checkpoint!.spendUsd > 0, 'the original round must have spent something');

    // The warranty re-run is a NEW claim against the same contract — a fresh
    // job row, so a fresh checkpoint, so the FR-5 caps restart at full rather
    // than resuming a budget the buyer already exhausted (FR-18: "under a fresh
    // FR-5-sized cap, free").
    const revision = await withDb(first.db, `${CONTRACT_ID}#revision-1`);
    assert.notEqual(revision.jobKey, first.jobKey);
    const revisionRow = (await revision.jobs.get(revision.jobKey))!;
    assert.equal(revisionRow.checkpoint, null);
    assert.equal(revisionRow.spentUsd, 0, 'the re-run starts from a fresh cap');

    await runConceptStage(revision.config, {
      contractId: CONTRACT_ID,
      jobKey: revision.jobKey,
      stage: 'concepts',
    });
    const revisionJob = (await revision.jobs.get(revision.jobKey))!;
    assert.equal(revisionJob.outcome, 'delivered');
    assert.equal(
      revisionJob.checkpoint!.spendUsd,
      firstJob.checkpoint!.spendUsd,
      'the re-run got the same full budget the original had',
    );
    assert.equal(revision.generated(), 3, 'and generated a full fresh set');

    // The whole point: a free warranty re-run is free to the BUYER without
    // being charged against the free-gig funnel's abuse guard. The throwing
    // `record` above proves nothing wrote; this proves nothing was counted.
    assert.equal(await revision.quota.countRecent(PAYER_ID, FREE_GIG_WINDOW_DAYS), 0);
  });
});
