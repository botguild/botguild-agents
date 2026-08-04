// Vectorization (FR-10, §13 single-vendor mitigation) — turns the buyer's
// chosen raster concept into the true vector the whole product is sold on.
//
// Two paths converge on one output contract:
//   - Recraft-native: the winning concept already carries a sanitized native
//     SVG (Task 18 wrote it to R2 when `generateRecraft` returned a vector
//     export instead of a raster — see generate.ts). No vendor call, just
//     local processing.
//   - Vectorizer.ai: every other winner. POST the PNG, get an SVG back.
//
// BOTH paths run the identical SVGO -> sanitizeSvg -> checkTrueVector
// pipeline before a result is returned `ok: true`. A vector we didn't trace
// is not automatically a vector we can ship, so a native SVG earns no more
// trust than one we paid Vectorizer.ai to produce.
//
// THAT GATE IS UNCONDITIONAL, AND THE LIVE PROBE IS NOT A REASON TO RELAX IT.
// This comment used to rest the argument on Recraft being unverified. It was
// verified on 2026-08-04 (see generate.ts's `generateRecraft`) and a real
// vendor SVG passed `checkTrueVector` clean both raw and sanitized — which
// says the bypass WORKS, not that the next SVG needs no checking. One
// measured sample is not a contract: the artifact this bot warrants is a
// true-vector logo.svg, so what ships is gated on every job whatever produced
// it.
//
// Failure classification is deliberately NOT "any throw is retryable" (unlike
// generate.ts's blanket outer catch-all). Two different failure classes exist
// here:
//   - transport-level (a network throw, or a 429/5xx/4xx status) -> retryable
//     follows the vendor's own guidance: 429/5xx are worth a retry with
//     backoff, a 4xx means the request itself is wrong.
//   - content-level (SVGO can't parse what came back, or the result fails the
//     true-vector self-check even though the HTTP call succeeded) -> ALWAYS
//     non-retryable. The identical bytes will produce the identical SVGO
//     parse error or the identical gate violation every time, so
//     `retryable: true` here would just loop the job through park/unpark
//     forever with zero chance of ever resolving (Task 18's carry-forward:
//     the park loop has no give-up rule of its own). A permanently-bad SVG
//     must route to the caller's abort leg, not its park leg.

import { optimize, type Config } from 'svgo';
import { IMAGE_COST_USD, vectorizerCreditsToUsd } from './config.js';
import { checkTrueVector, sanitizeSvg } from './gates/index.js';
import type { FetchLike } from './types.js';

const VECTORIZER_URL = 'https://vectorizer.ai/api/v1/vectorize';

/** 5xx and 429 are worth another attempt; 4xx means the request itself is wrong. */
const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * SVGO config shared by both paths. Verified against the installed
 * svgo@4.0.2 `preset-default` plugin list
 * (`node_modules/svgo/plugins/preset-default.js`) rather than assumed:
 *
 *  - `removeViewBox` is NOT one of preset-default's plugins in this version
 *    (dropped from the default set after v2.4 broke responsive SVGs
 *    industry-wide), so nothing strips the viewBox — there is no override to
 *    make because the plugin is never invoked. The plan's literal
 *    `removeViewBox: false` config key does not exist here: typing
 *    `overrides: { removeViewBox: false }` is a TypeScript compile error
 *    against `PresetDefaultOverrides` (confirmed with `tsc`), and svgo's own
 *    runtime warns "you are trying to configure removeViewBox which is not
 *    part of preset-default" if forced through with a cast (confirmed by
 *    running it). `checkTrueVector`'s `hasViewBox` requirement inside
 *    `finalizeVector` below is the real regression guard: if some future
 *    svgo upgrade ever reintroduces the plugin, the "still passes the gate"
 *    tests fail immediately instead of silently shipping viewBox-less SVGs.
 *  - `convertShapeToPath` and `removeMetadata` ARE both in preset-default, so
 *    shape-to-path conversion and metadata stripping are the default, not
 *    something this config has to ask for separately.
 *  - `removeScripts` is NOT in preset-default — svgo leaves `<script>`
 *    completely untouched (verified with a probe input). `sanitizeSvg` below
 *    is what actually removes it.
 *  - `removeDoctype` IS in preset-default, IS INHERITED RATHER THAN CHOSEN,
 *    AND IS LOAD-BEARING. DO NOT OVERRIDE IT OFF. Vectorizer.ai's real
 *    response (measured 2026-08-04) opens with a DOCTYPE carrying an external
 *    `http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd` DTD URL; this plugin
 *    is the ONLY thing that removes it, because `checkTrueVector` does not
 *    catch a DOCTYPE at all (mutation-measured: pass=true with the external
 *    URL still in the document). See `toVector` below and the regression test
 *    that pins it.
 *  - `inlineStyles` IS in preset-default and is explicitly turned OFF here.
 *    Left on, it rewrites `<style>.a{fill:url(https://evil/x.svg)}</style>`
 *    into an inline `style="fill:url(https://evil/x.svg)"` on whatever
 *    element used `class="a"` and DELETES the `<style>` tag — laundering the
 *    exact thing `checkTrueVector`'s allowlist excludes `<style>` to catch,
 *    by moving it onto an element the allowlist already permits. This is
 *    defense in depth, not the actual fix: vendor markup can carry the
 *    inline `style="...url(...)"` form directly, with no `<style>` tag ever
 *    in the picture, so `checkTrueVector`'s own `EXTERNAL_REF_RE` check
 *    (gates/vector.ts) is what closes this for real — this override just
 *    keeps the `<style>` exclusion meaning what its comment says for the one
 *    path that can still produce a `<style>` tag.
 */
const SVGO_CONFIG: Config = {
  multipass: true,
  plugins: [{ name: 'preset-default', params: { overrides: { inlineStyles: false } } }],
};

/**
 * Shared post-processing for both paths: SVGO, then `sanitizeSvg`, then
 * `checkTrueVector` as a self-check. SVGO is not lenient the way resvg is
 * (Task 18 measured resvg accepting a bogus `viewBox` but throwing on an
 * unterminated `d=`); a probe here found svgo throws on truly malformed XML
 * (an unclosed tag, non-SVG text) rather than passing it through, so this
 * does not assume either vendor's SVG is well-formed.
 */
function finalizeVector(rawSvg: string): { ok: true; svg: string } | { ok: false; error: string } {
  let optimized: string;
  try {
    optimized = optimize(rawSvg, SVGO_CONFIG).data;
  } catch (err) {
    return { ok: false, error: `svgo could not parse the vendor SVG: ${errorMessage(err)}` };
  }
  const sanitized = sanitizeSvg(optimized);
  const gate = checkTrueVector(sanitized);
  if (!gate.pass) {
    return { ok: false, error: `true-vector self-check failed: ${gate.violations.join('; ')}` };
  }
  return { ok: true, svg: sanitized };
}

export interface Vectorizer {
  toVector(input: { png: Uint8Array; nativeSvg?: string }): Promise<VectorizeResult>;
}

export type VectorizeResult =
  | { ok: true; svg: string; source: 'recraft-native' | 'vectorizer'; costUsd: number }
  | {
      ok: false;
      retryable: boolean;
      error: string;
      /**
       * What Vectorizer.ai charged for a call that still failed — the same
       * contract `GenerateResult.costUsd` documents, one layer out. A response
       * that arrives `HTTP 200` and then fails (`response.text()` throwing on a
       * truncated body, or an SVG that fails the true-vector self-check) was
       * PAID FOR. Present on exactly those branches, absent otherwise, and the
       * caller must credit it to the ledger before it parks.
       *
       * The Recraft-native short-circuit never touches the network, so its
       * failures carry nothing: they really are free.
       */
      costUsd?: number;
    };

export function createVectorizer(deps: {
  fetchImpl: FetchLike;
  vectorizerToken: string;
}): Vectorizer {
  return {
    async toVector(input) {
      // Recraft-origin winners skip Vectorizer.ai entirely (the §13
      // single-vendor mitigation: ~$0.20 saved against a $1 anchor). This is
      // a hard short-circuit — fetchImpl is never touched below this branch.
      if (input.nativeSvg) {
        const processed = finalizeVector(input.nativeSvg);
        if (!processed.ok) return { ok: false, retryable: false, error: processed.error };
        return { ok: true, svg: processed.svg, source: 'recraft-native', costUsd: 0 };
      }

      // VERIFIED LIVE 2026-08-04 against the real API, as Ideogram was on
      // 2026-07-30 and Recraft on 2026-08-04 (both in generate.ts). Three
      // calls, all in the vendor's FREE TEST MODE — `mode=test` returns a
      // full-shaped response and charges 0.000000 credits (see the README).
      // THAT MODE IS A VERIFICATION TOOL ONLY AND IS DELIBERATELY NOT WIRED IN
      // HERE: this Worker never sends it, so what ships always pays.
      //
      // EVERY ASSUMPTION THIS ADAPTER WAS WRITTEN ON HELD, which is worth
      // recording because the credential shape was the flagged risk — had
      // `vectorizerToken` not been the pre-joined pair, every M2 that does not
      // take the Recraft native-SVG bypass would have failed. What is now
      // MEASURED, replacing what this comment previously took from
      // vectorizer.ai's published docs (read 2026-07-30):
      //
      //   * `Basic btoa("apiId:apiSecret")` of the single `PipelineSecrets`
      //     string is ACCEPTED — the pre-joined reading below is correct, as
      //     are the endpoint, the `image` + `output.file_format=svg` form
      //     fields, and reading the success body with `response.text()`
      //     (HTTP 200, `content-type: image/svg+xml`, 47899 bytes).
      //   * THE BODY IS SVG BEHIND AN XML PROLOG **AND A DOCTYPE**, and that
      //     DOCTYPE CARRIES AN EXTERNAL DTD URL
      //     (`http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd`) — an external
      //     reference arriving in vendor output, which is the exact class of
      //     defect this branch has already shipped into paid logos twice. It
      //     does NOT survive `finalizeVector`: SVGO's `removeDoctype` strips
      //     it, verified on the real response (47899 -> 23105 bytes, zero
      //     `http:` outside `xmlns` in the delivered SVG, gate clean).
      //
      //     BUT `removeDoctype` IS AN INHERITED `preset-default` PLUGIN NOBODY
      //     CHOSE, AND IT IS LOAD-BEARING, NOT BELT-AND-BRACES. Measured by
      //     mutation: override it off and the DOCTYPE *and its external URL*
      //     survive into the delivered file, and `checkTrueVector` PASSES IT
      //     (pass=true, violations=[]) — `<!DOCTYPE` matches neither the
      //     tag-allowlist scan (which needs `<name`, and `!` is not a name
      //     character) nor `hasNonFragmentReference` (which looks for `href=`
      //     and `url(`, and a DOCTYPE has neither). THE GATE IS NOT A SECOND
      //     LINE OF DEFENCE HERE; SVGO IS THE ONLY ONE. That is why
      //     vectorize.test.ts now pins it with the real captured prefix: the
      //     test is what makes an inherited default a checked decision.
      //   * THE CHARGE IS THE `x-credits-charged` RESPONSE HEADER — a header,
      //     not a body field, since the body is raw SVG — reported beside
      //     `x-credits-calculated`. The ledger bills from it below rather than
      //     from a constant that drifts unseen.
      //
      // Still unobserved, and so still inferred: any PAID call (all three
      // probes were test-mode, so a non-zero charge value has never been
      // seen), the credits->USD ratio (derived, not measured — see
      // `VECTORIZER_CREDITS_PER_USD`), and every non-200 error body.
      const body = new FormData();
      // `new Uint8Array(input.png)` (rather than `input.png` directly) is not
      // a semantic change — it re-copies into a plain `ArrayBuffer`-backed
      // view, which is what satisfies `BlobPart`'s stricter
      // `Uint8Array<ArrayBuffer>` (vs. `input.png`'s general
      // `Uint8Array<ArrayBufferLike>`, which could in principle be backed by
      // a `SharedArrayBuffer`). Same pattern already used at every other
      // typed-array boundary in this codebase (render.ts, generate.ts).
      body.append(
        'image',
        new Blob([new Uint8Array(input.png)], { type: 'image/png' }),
        'concept.png',
      );
      body.append('output.file_format', 'svg');

      // Computed OUTSIDE the network try/catch on purpose: btoa() throws
      // `InvalidCharacterError` for any character outside Latin1, and that is
      // a structural defect in the credential value itself, not a transient
      // network condition — the identical throw happens on every single
      // retry. Folding it into the same catch as the fetch call below would
      // misclassify it `retryable: true` and cost this exact token the same
      // park-forever pathology the whole retryable/non-retryable split in
      // this module exists to avoid (see the header comment).
      let authHeader: string;
      try {
        authHeader = `Basic ${btoa(deps.vectorizerToken)}`;
      } catch (err) {
        return {
          ok: false,
          retryable: false,
          error: `vectorizerToken is not a valid Basic-auth credential: ${errorMessage(err)}`,
        };
      }

      let response: Response;
      try {
        response = await deps.fetchImpl(VECTORIZER_URL, {
          method: 'POST',
          headers: { Authorization: authHeader },
          body,
        });
      } catch (err) {
        return { ok: false, retryable: true, error: errorMessage(err) };
      }

      if (!response.ok) {
        return {
          ok: false,
          retryable: isRetryableStatus(response.status),
          error: `vectorizer.ai returned ${response.status}`,
        };
      }

      // PAST THIS LINE THE VENDOR HAS BEEN BILLED: the trace ran and returned
      // 200. Both failures below are PAID failures and say so, because the
      // FR-5 ledger is the only bound on the park loop they feed (a retryable
      // failure deliberately consumes no attempt — Task 18 Ruling 1).
      // `billed` is the PLANNING figure; it stands only until the response
      // says what was really charged.
      const billed = IMAGE_COST_USD.vectorizer;

      // WHAT THE VENDOR SAYS IT CHARGED, not what we planned for. Read BEFORE
      // the body, for the same reason generate.ts reads Recraft's id header
      // first: the body is the half that can fail mid-stream, and the charge
      // is exactly what that failure branch has to report. Falls back to the
      // planning constant on any unusable count — see `vectorizerCreditsToUsd`
      // for why the fallback direction is upward, and why a free test-mode
      // call (`x-credits-charged: 0.000000`) therefore bills $0.20.
      const charged = vectorizerCreditsToUsd(response.headers.get('x-credits-charged')) ?? billed;

      let svgText: string;
      try {
        svgText = await response.text();
      } catch (err) {
        return { ok: false, retryable: true, error: errorMessage(err), costUsd: charged };
      }

      const processed = finalizeVector(svgText);
      if (!processed.ok) {
        return { ok: false, retryable: false, error: processed.error, costUsd: charged };
      }
      return {
        ok: true,
        svg: processed.svg,
        source: 'vectorizer',
        costUsd: charged,
      };
    },
  };
}
