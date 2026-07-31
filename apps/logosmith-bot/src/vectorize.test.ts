import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVectorizer } from './vectorize.js';
import { checkTrueVector } from './gates/index.js';
import { IMAGE_COST_USD } from './config.js';
import type { FetchLike } from './types.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M10 10 H90 V90 H10 Z" fill="#0F3D3E"/></svg>';

// Deliberately verbose: an XML prolog, a generator comment, a vendor
// metadata/RDF block, and a <rect> that SVGO's convertShapeToPath should fold
// into a <path> — all things a tight, already-optimized SVG would not carry.
// Big enough that any shrinkage proves SVGO actually ran, not a coincidence
// of whitespace.
const verboseSvg = (): string =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!-- Generator: some vendor export tool -->\n' +
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n' +
  '  <metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description>vendor provenance info nobody downstream needs</rdf:Description>' +
  '</rdf:RDF></metadata>\n' +
  '  <!-- a second comment, for good measure -->\n' +
  '  <rect x="10" y="10" width="80" height="80" fill="#0F3D3E" />\n' +
  '</svg>\n';

/** Fails the test loudly if the native-SVG path ever reaches the network. */
const unreachableFetch: FetchLike = async () => {
  throw new Error('fetchImpl must not be called for a Recraft-native winner');
};

describe('createVectorizer — Recraft-native short-circuit', () => {
  it('returns the sanitized native SVG, zero cost, and never calls fetchImpl', async () => {
    const vectorizer = createVectorizer({ fetchImpl: unreachableFetch, vectorizerToken: 't' });
    const result = await vectorizer.toVector({ png: PNG, nativeSvg: CLEAN_SVG });
    assert.ok(result.ok);
    assert.equal(result.source, 'recraft-native');
    assert.equal(result.costUsd, 0);
    assert.ok(checkTrueVector(result.svg).pass);
  });

  it('still runs the native SVG through SVGO — shrinks a verbose export and still passes the gate', async () => {
    const verbose = verboseSvg();
    // Preconditions: the fixture must actually be bigger than a bare vector
    // (or the shrink assertion below proves nothing), AND it must carry an
    // XML comment that only SVGO's removeComments strips — sanitizeSvg never
    // touches `<!--`. Without this specific check, this test would still
    // "pass" if SVGO were skipped entirely, because sanitizeSvg's own
    // <metadata> stripping is by itself enough to shrink this fixture
    // (verified by mutation: deleting the `optimize()` call left the raw
    // shrink/pass assertions green and only the comment check below failed).
    assert.ok(verbose.length > CLEAN_SVG.length);
    assert.ok(/<!--/.test(verbose));
    const vectorizer = createVectorizer({ fetchImpl: unreachableFetch, vectorizerToken: 't' });
    const result = await vectorizer.toVector({ png: PNG, nativeSvg: verbose });
    assert.ok(result.ok);
    assert.ok(result.svg.length < verbose.length);
    assert.ok(checkTrueVector(result.svg).pass);
    assert.ok(!/rdf:RDF/.test(result.svg), 'vendor metadata should be gone');
    assert.ok(!/<!--/.test(result.svg), 'SVGO must have stripped the comment — sanitizeSvg cannot');
    assert.ok(/\sviewBox\s*=/.test(result.svg), 'viewBox must survive SVGO');
  });

  it('sanitizes a native SVG that carries a <script>', async () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<script>alert(1)</script><path d="M0 0 L1 1" fill="#000"/></svg>';
    const vectorizer = createVectorizer({ fetchImpl: unreachableFetch, vectorizerToken: 't' });
    const result = await vectorizer.toVector({ png: PNG, nativeSvg: dirty });
    assert.ok(result.ok);
    assert.ok(!/script/i.test(result.svg));
    assert.ok(checkTrueVector(result.svg).pass);
  });

  it('fails a native SVG that wraps a raster in <image>, without calling fetchImpl', async () => {
    const raster = '<svg viewBox="0 0 10 10"><image href="data:image/png;base64,iVBOR"/></svg>';
    const vectorizer = createVectorizer({ fetchImpl: unreachableFetch, vectorizerToken: 't' });
    const result = await vectorizer.toVector({ png: PNG, nativeSvg: raster });
    assert.ok(!result.ok);
    assert.equal(result.retryable, false);
    assert.match(result.error, /image/i);
  });

  it('fails a malformed native SVG instead of throwing or shipping garbage', async () => {
    // Recraft is unverified live (generate.ts carries the same caveat) — this
    // proves toVector does not assume the vendor SVG even parses.
    const vectorizer = createVectorizer({ fetchImpl: unreachableFetch, vectorizerToken: 't' });
    const result = await vectorizer.toVector({
      png: PNG,
      nativeSvg: '<svg viewBox="0 0 10 10"><path d="M0 0',
    });
    assert.ok(!result.ok);
    assert.equal(result.retryable, false);
  });
});

describe('createVectorizer — Vectorizer.ai path', () => {
  it('posts the PNG to vectorizer.ai with basic auth and an image field, and returns a positive, exact cost', async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    const vectorizer = createVectorizer({
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenInit = init;
        return new Response(CLEAN_SVG, {
          status: 200,
          headers: { 'Content-Type': 'image/svg+xml' },
        });
      },
      vectorizerToken: 'the-id:the-secret',
    });
    const result = await vectorizer.toVector({ png: PNG });
    assert.ok(result.ok);
    assert.equal(result.source, 'vectorizer');
    assert.equal(result.costUsd, IMAGE_COST_USD.vectorizer);
    assert.ok(result.costUsd > 0);

    assert.equal(seenUrl, 'https://vectorizer.ai/api/v1/vectorize');
    assert.equal(seenInit?.method, 'POST');
    const headers = seenInit?.headers as Record<string, string>;
    // Independent oracle (Buffer, not the implementation's own btoa) for the
    // Basic-auth encoding of the single vectorizerToken string, read as the
    // pre-joined "apiId:apiSecret" pair per vectorizer.ai's documented API
    // (verified 2026-07-30 against https://vectorizer.ai/api/documentation:
    // `Authorization: Basic base64(apiId:apiSecret)`).
    assert.equal(
      headers.Authorization,
      `Basic ${Buffer.from('the-id:the-secret').toString('base64')}`,
    );

    const form = seenInit?.body as FormData;
    const image = form.get('image') as Blob;
    assert.equal(image.size, PNG.length);
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [...PNG]);
    assert.equal(form.get('output.file_format'), 'svg');
  });

  it('runs SVGO on the vectorizer response — shrinks a verbose reply and still passes the gate', async () => {
    const verbose = verboseSvg();
    assert.ok(verbose.length > CLEAN_SVG.length);
    // See the sibling native-path test for why this must check for an
    // SVGO-only effect (comment removal) rather than raw shrinkage alone —
    // sanitizeSvg's own <metadata> stripping is enough to shrink this
    // fixture even with SVGO skipped entirely.
    assert.ok(/<!--/.test(verbose));
    const vectorizer = createVectorizer({
      fetchImpl: async () => new Response(verbose, { status: 200 }),
      vectorizerToken: 't',
    });
    const result = await vectorizer.toVector({ png: PNG });
    assert.ok(result.ok);
    assert.ok(result.svg.length < verbose.length);
    assert.ok(checkTrueVector(result.svg).pass);
    assert.ok(!/<!--/.test(result.svg), 'SVGO must have stripped the comment — sanitizeSvg cannot');
  });

  it('sanitizes a vectorizer response that carries a <script>', async () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<script>alert(document.cookie)</script><path d="M0 0 L1 1" fill="#000"/></svg>';
    const vectorizer = createVectorizer({
      fetchImpl: async () => new Response(dirty, { status: 200 }),
      vectorizerToken: 't',
    });
    const result = await vectorizer.toVector({ png: PNG });
    assert.ok(result.ok);
    assert.ok(!/script/i.test(result.svg));
    assert.ok(checkTrueVector(result.svg).pass);
  });

  it('fails a vectorizer response that wraps a raster in <image>', async () => {
    const raster = '<svg viewBox="0 0 10 10"><image href="data:image/png;base64,iVBOR"/></svg>';
    const vectorizer = createVectorizer({
      fetchImpl: async () => new Response(raster, { status: 200 }),
      vectorizerToken: 't',
    });
    const result = await vectorizer.toVector({ png: PNG });
    assert.ok(!result.ok);
    // Content-level failure, not a transport failure: the HTTP call
    // succeeded, so retrying the identical PNG through the identical vendor
    // trace algorithm would very likely reproduce the identical
    // image-wrapping result. Non-retryable, so the caller's abort leg fires
    // instead of an endless park/unpark loop (Task 18's carry-forward: a
    // permanently-bad artifact needs a terminal path, not just a retry).
    assert.equal(result.retryable, false);
    assert.match(result.error, /image/i);
  });

  it('fails a malformed vectorizer response instead of throwing', async () => {
    const vectorizer = createVectorizer({
      fetchImpl: async () => new Response('not an svg at all', { status: 200 }),
      vectorizerToken: 't',
    });
    const result = await vectorizer.toVector({ png: PNG });
    assert.ok(!result.ok);
    assert.equal(result.retryable, false);
  });

  it('marks 429 and 5xx as retryable and 4xx as not', async () => {
    const make = (status: number) =>
      createVectorizer({
        fetchImpl: async () => new Response('no', { status }),
        vectorizerToken: 't',
      });
    const rateLimited = await make(429).toVector({ png: PNG });
    // 500 is the exact `>= 500` boundary — a 503-only check would not catch
    // an off-by-one (`>` instead of `>=`) on that boundary, so both are here.
    const boundaryServerError = await make(500).toVector({ png: PNG });
    const serverError = await make(503).toVector({ png: PNG });
    const badRequest = await make(400).toVector({ png: PNG });
    assert.ok(!rateLimited.ok && rateLimited.retryable);
    assert.ok(!boundaryServerError.ok && boundaryServerError.retryable);
    assert.ok(!serverError.ok && serverError.retryable);
    assert.ok(!badRequest.ok && !badRequest.retryable);
  });

  it('reports a network throw as retryable, never a throw', async () => {
    const vectorizer = createVectorizer({
      fetchImpl: async () => {
        throw new Error('socket hang up');
      },
      vectorizerToken: 't',
    });
    const result = await vectorizer.toVector({ png: PNG });
    assert.ok(!result.ok && result.retryable);
  });
});
