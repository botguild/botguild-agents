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

// THE REAL PREFIX MEASURED ON THE LIVE 2026-08-04 vectorizer.ai RESPONSE
// (`mode=test`, 47899 bytes), byte-for-byte, wrapped around a minimal body.
// Both lines matter and only one of them is harmless: the XML prolog is inert,
// but the DOCTYPE carries an EXTERNAL DTD URL — a vendor shipping us an
// external reference in the artifact this bot sells.
const liveDoctypePrefixSvg = (): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
  '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ' +
  '"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
  CLEAN_SVG;

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
    // The live 2026-08-04 probe returned an SVG that parsed and passed the
    // gate clean — so this is no longer covering an unverified vendor, it is
    // covering the case that ONE good sample cannot rule out. `toVector` must
    // not assume the vendor SVG even parses.
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

  it('classifies a non-Latin1 vectorizerToken as non-retryable, not a network failure', async () => {
    // btoa() throws for any character outside Latin1 (verified: an accented
    // "é" does not throw, an emoji does) — that is a structural defect in the
    // credential itself, not a transient condition, so by this module's own
    // stated rationale it must not park-forever like a real outage would.
    // fetchImpl throwing if reached proves the header is built (and fails)
    // BEFORE any network call, not after a failed one.
    const vectorizer = createVectorizer({
      fetchImpl: async () => {
        throw new Error('fetchImpl must not be called — the auth header could not be built');
      },
      vectorizerToken: 'bad-token-\u{1F600}',
    });
    const result = await vectorizer.toVector({ png: PNG });
    assert.ok(!result.ok);
    assert.equal(result.retryable, false);
  });
});

describe('createVectorizer — external references (critical, see gates/vector.ts)', () => {
  // The exact reproduction from review: a <style> rule smuggling an external
  // url() via a class selector.
  const styleSmuggling =
    '<svg viewBox="0 0 10 10"><style>.a{fill:url(https://evil.example.com/track.svg)}</style>' +
    '<path class="a" d="M0 0 L1 1"/></svg>';
  // The shape SVGO's inlineStyles plugin would have produced from the above
  // had `inlineStyles: false` not been set — and, independently, a shape
  // vendor markup could arrive in NATIVELY with no <style> tag ever
  // involved. Proves EXTERNAL_REF_RE — not just the SVGO override — is what
  // closes this end to end.
  const alreadyLaundered =
    '<svg viewBox="0 0 10 10"><path d="M0 0 L1 1" ' +
    'style="fill:url(https://evil.example.com/track.svg)"/></svg>';

  it('rejects a native SVG carrying a <style> block that smuggles an external url()', async () => {
    const vectorizer = createVectorizer({ fetchImpl: unreachableFetch, vectorizerToken: 't' });
    const result = await vectorizer.toVector({ png: PNG, nativeSvg: styleSmuggling });
    assert.ok(!result.ok);
    assert.equal(result.retryable, false);
    assert.match(result.error, /external reference|non-vector element/i);
  });

  it('rejects a native SVG whose external url() already lives inline, with no <style> tag at all', async () => {
    const vectorizer = createVectorizer({ fetchImpl: unreachableFetch, vectorizerToken: 't' });
    const result = await vectorizer.toVector({ png: PNG, nativeSvg: alreadyLaundered });
    assert.ok(!result.ok);
    assert.equal(result.retryable, false);
    assert.match(result.error, /external reference/i);
  });

  it('rejects a vectorizer.ai response carrying the style-smuggling <style> block', async () => {
    const vectorizer = createVectorizer({
      fetchImpl: async () => new Response(styleSmuggling, { status: 200 }),
      vectorizerToken: 't',
    });
    const result = await vectorizer.toVector({ png: PNG });
    assert.ok(!result.ok);
    assert.equal(result.retryable, false);
    assert.match(result.error, /external reference|non-vector element/i);
  });

  it('rejects a vectorizer.ai response whose external url() already lives inline', async () => {
    const vectorizer = createVectorizer({
      fetchImpl: async () => new Response(alreadyLaundered, { status: 200 }),
      vectorizerToken: 't',
    });
    const result = await vectorizer.toVector({ png: PNG });
    assert.ok(!result.ok);
    assert.equal(result.retryable, false);
    assert.match(result.error, /external reference/i);
  });

  // ---------------------------------------------------------------------------
  // THE DOCTYPE, AND WHY IT GETS ITS OWN TEST. The live 2026-08-04 response
  // opens with a DOCTYPE naming an external DTD URL. It never reaches the
  // buyer — but nothing tested that, and what removes it is `removeDoctype`,
  // a plugin INHERITED from svgo's `preset-default` that nobody on this branch
  // chose. This test is what turns that inherited default into a decision:
  // disable it (or upgrade to an svgo that drops it from the preset) and this
  // fails immediately, instead of an external URL quietly reappearing in a
  // paid logo.svg for the third time on this branch.
  // ---------------------------------------------------------------------------
  it('strips the live response DOCTYPE and its external DTD URL', async () => {
    const raw = liveDoctypePrefixSvg();
    // Preconditions — the fixture must actually carry what it claims to.
    assert.match(raw, /<!DOCTYPE/);
    assert.match(raw, /w3\.org\/Graphics/);

    const vectorizer = createVectorizer({
      fetchImpl: async () => new Response(raw, { status: 200 }),
      vectorizerToken: 't',
    });
    const result = await vectorizer.toVector({ png: PNG });
    assert.ok(result.ok);
    assert.ok(!/<!DOCTYPE/i.test(result.svg), 'the vendor DOCTYPE must not survive into logo.svg');
    assert.ok(
      !/w3\.org\/Graphics/i.test(result.svg),
      'the external DTD URL must not survive into logo.svg',
    );
    // The property those two assertions exist to protect, stated directly: no
    // `http:` anywhere except the xmlns declarations a standalone SVG needs.
    assert.ok(
      !/http:/i.test(result.svg.replace(/xmlns(?::\w+)?="[^"]*"/g, '')),
      'no external reference may remain outside the xmlns declarations',
    );
    assert.ok(checkTrueVector(result.svg).pass);
  });

  it('does not get that protection from the gate — SVGO is the only thing removing it', () => {
    // MUTATION-MEASURED, AND THE REASON THE TEST ABOVE HAD TO BE WRITTEN.
    // Overriding `removeDoctype: false` leaves the DOCTYPE *and its external
    // URL* in the finalized document, and `checkTrueVector` returns
    // pass=true / violations=[] on it: `<!DOCTYPE` matches neither the
    // tag-allowlist scan (which needs `<name`, and `!` is not a name
    // character) nor `hasNonFragmentReference` (which looks for `href=` and
    // `url(` — a DOCTYPE has neither). So the gate is NOT a second line of
    // defence behind SVGO here; there is no second line.
    //
    // IF THIS ASSERTION EVER FAILS, THAT IS GOOD NEWS, NOT A REGRESSION: it
    // means `checkTrueVector` has been hardened to catch a DOCTYPE. Delete
    // this test and correct the "SVGO is the only one" claim in vectorize.ts's
    // SVGO_CONFIG docstring and `toVector` comment, which would then be stale.
    const gate = checkTrueVector(liveDoctypePrefixSvg());
    assert.ok(
      gate.pass,
      `checkTrueVector now rejects a DOCTYPE (${gate.violations.join('; ')}) — see this test's comment`,
    );
  });
});

// ---------------------------------------------------------------------------
// The same "a failure is not a free failure" contract generate.ts carries, one
// layer out. A vectorizer.ai call that returns 200 has RUN AND BEEN BILLED; a
// body that cannot be read, or an SVG that fails its own self-check, does not
// undo that. Stage 2's ledger — and, via `sweepParkedJobs`, the bound on the
// park loop the retryable branch feeds — sees only what is reported here.
// ---------------------------------------------------------------------------
describe('createVectorizer — paid failures are visible to the spend ledger', () => {
  it('bills a 200 whose body cannot be read', async () => {
    const vectorizer = createVectorizer({
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          // A real Response always has these; the charge is read from them
          // BEFORE the body precisely so a body that dies mid-stream cannot
          // take the charge figure down with it.
          headers: new Headers({ 'x-credits-charged': '2.000000' }),
          text: async () => {
            throw new Error('connection reset while streaming the body');
          },
        }) as unknown as Response,
      vectorizerToken: 't',
    });
    const result = await vectorizer.toVector({ png: PNG });
    assert.ok(!result.ok && result.retryable);
    assert.equal(result.costUsd, 0.4);
  });

  it('bills a 200 whose SVG fails the true-vector self-check', async () => {
    const vectorizer = createVectorizer({
      fetchImpl: async () =>
        new Response('<svg viewBox="0 0 10 10"><image href="data:image/png;base64,AAA"/></svg>', {
          status: 200,
        }),
      vectorizerToken: 't',
    });
    const result = await vectorizer.toVector({ png: PNG });
    assert.ok(!result.ok && !result.retryable);
    assert.equal(result.costUsd, IMAGE_COST_USD.vectorizer);
  });

  it('leaves costUsd ABSENT for every failure that never reached the vendor', async () => {
    const rejected = await createVectorizer({
      fetchImpl: async () => new Response('nope', { status: 402 }),
      vectorizerToken: 't',
    }).toVector({ png: PNG });
    assert.ok(!rejected.ok);
    assert.equal(rejected.costUsd, undefined);

    const dropped = await createVectorizer({
      fetchImpl: async () => {
        throw new Error('socket hang up');
      },
      vectorizerToken: 't',
    }).toVector({ png: PNG });
    assert.ok(!dropped.ok);
    assert.equal(dropped.costUsd, undefined);

    // The Recraft short-circuit never touches the network, so ITS failures
    // really are free — this is the case `costUsd: 0` would have blurred.
    const native = await createVectorizer({
      fetchImpl: unreachableFetch,
      vectorizerToken: 't',
    }).toVector({ png: PNG, nativeSvg: '<svg viewBox="0 0 10 10"><image href="#x"/></svg>' });
    assert.ok(!native.ok);
    assert.equal(native.costUsd, undefined);
  });
});

// ---------------------------------------------------------------------------
// WHAT THE VENDOR SAYS IT CHARGED. Verified live 2026-08-04: vectorizer.ai
// reports the charge in the `x-credits-charged` RESPONSE HEADER (beside
// `x-credits-calculated`), not in the body — the body is raw SVG. The ledger
// bills from that report rather than from a constant that drifts unseen when
// a plan or a price changes.
//
// The credits->USD RATIO is derived, not measured (see
// `VECTORIZER_CREDITS_PER_USD`), so these fixtures pin our handling of a
// measured credit COUNT, not the vendor's dollar pricing.
// ---------------------------------------------------------------------------
describe('createVectorizer — the charge comes from the response, not a constant', () => {
  const charged = (value: string | undefined) =>
    createVectorizer({
      fetchImpl: async () =>
        new Response(CLEAN_SVG, {
          status: 200,
          headers: value === undefined ? {} : { 'x-credits-charged': value },
        }),
      vectorizerToken: 't',
    }).toVector({ png: PNG });

  it('bills what the x-credits-charged header reports', async () => {
    // MUTATION GUARD. 2 credits is deliberately NOT the 1 credit a normal
    // conversion costs, so replacing the header read with the flat constant
    // fails here with 0.2 !== 0.4 rather than passing by coincidence.
    const result = await charged('2.000000');
    assert.ok(result.ok);
    assert.equal(result.costUsd, 0.4);
    assert.notEqual(result.costUsd, IMAGE_COST_USD.vectorizer);
  });

  it('agrees with the planning constant on the charge a normal conversion reports', async () => {
    const result = await charged('1.000000');
    assert.ok(result.ok);
    assert.equal(result.costUsd, IMAGE_COST_USD.vectorizer);
  });

  it('falls back UPWARD to the planning figure on any charge it cannot trust', async () => {
    // `'0.000000'` is the value a FREE `mode=test` call really returns — the
    // exact shape all three live probes saw. It is treated as untrusted on
    // purpose: this Worker never sends `mode=test`, so a zero charge in
    // production is an anomaly, and billing $0.00 for a call that ran is what
    // leaves the park -> unpark loop with nothing bounding it.
    for (const header of [undefined, '', '0.000000', 'free', '-1']) {
      const result = await charged(header);
      assert.ok(result.ok);
      assert.equal(result.costUsd, IMAGE_COST_USD.vectorizer, `header=${String(header)}`);
    }
  });
});
