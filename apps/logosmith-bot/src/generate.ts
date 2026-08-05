// Image vendor adapters (FR-4). One entry point, three back ends:
//   ideogram — lettering-heavy axes (its lettering quality is the whole reason
//              the OCR gate is winnable)
//   recraft  — the vector-native/icon-led axis; its native SVG export, when
//              present, lets M2 skip Vectorizer.ai entirely
//   flux     — the FREE taster only, via the Workers AI binding (near-free)
//
// Every path returns a result object rather than throwing: a vendor failure is
// a pipeline decision (retry within caps, or park), not an exception.

import { FLUX_MODEL_ID, IMAGE_COST_USD, recraftCreditsToUsd } from './config.js';
import type { AiLike, Concept, FetchLike, StyleAxis } from './types.js';

export type GenerateResult =
  | { ok: true; concept: Omit<Concept, 'slot'>; costUsd: number }
  | {
      ok: false;
      retryable: boolean;
      error: string;
      /**
       * WHAT THE VENDOR CHARGED FOR A CALL THAT STILL FAILED.
       *
       * A failure is not the same as a free failure. Everything below an
       * `HTTP 200` — a missing `data[0].url`, a dead/expired asset CDN link, an
       * asset that is not the image type it claimed — happens AFTER the vendor
       * accepted, ran and billed the generation. Present on exactly those
       * branches; ABSENT (not `0`) when the request never reached a billable
       * state, so the two cases stay distinguishable at the call site.
       *
       * The caller MUST credit this to the FR-5 spend ledger before it parks.
       * A retryable failure deliberately consumes no FR-5 attempt (Task 18
       * Ruling 1), so `attempts` cannot bound this loop and `spendUsd` is the
       * ONLY thing that can — and `MAX_SPEND_USD` cannot bound spend it never
       * sees. A dead CDN link on an otherwise-healthy vendor is enough:
       * park → cron unpark → regenerate → park, every fifteen minutes, each
       * cycle paying for one more image the ledger reported as free.
       */
      costUsd?: number;
    };

export interface Generator {
  generate(axis: StyleAxis, prompt: string): Promise<GenerateResult>;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const isPng = (bytes: Uint8Array): boolean =>
  bytes.length > 8 && PNG_MAGIC.every((byte, i) => bytes[i] === byte);

/** 5xx and 429 are worth another attempt; 4xx means the request itself is wrong. */
const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Run everything that happens AFTER a vendor accepted and billed a request, and
 * make sure any failure inside it still reports what we were charged.
 *
 * STRUCTURAL, NOT AN ENUMERATION, AND THAT IS THE WHOLE POINT. The first
 * version of this fix wrapped the two calls that were known to throw and left a
 * comment on the outer catch-all asserting "nothing reaches this line already
 * billed". That sentence was FALSE, and false for six separate paths: a 200
 * whose body is a CDN/WAF interstitial, a body that is literal JSON `null`
 * (`body.data` then throws on null), a stream that resets mid-read, the same two
 * on the Recraft leg, and `ai.run` resolving null. Every one of them escaped to
 * the outer catch and reported `retryable: true` with NO cost — the identical
 * unmetered park loop the `costUsd` field exists to close, one branch over.
 *
 * A comment claiming a safety property is the most expensive kind to get wrong:
 * it is precisely what stops the next reader from checking. So the property is
 * now enforced by the shape of the code rather than asserted about it — a new
 * dereference added anywhere below a billing point cannot silently opt out of
 * cost attribution, because it is inside this wrapper by construction.
 */
async function billedAttempt(
  costUsd: number,
  attempt: () => Promise<GenerateResult>,
): Promise<GenerateResult> {
  try {
    return await attempt();
  } catch (err) {
    return { ok: false, retryable: true, error: errorMessage(err), costUsd };
  }
}

export function createGenerator(deps: {
  fetchImpl: FetchLike;
  ai: AiLike;
  ideogramApiKey: string;
  recraftApiKey: string;
}): Generator {
  async function fetchBytes(url: string): Promise<Uint8Array> {
    const response = await deps.fetchImpl(url);
    if (!response.ok) throw new Error(`asset fetch returned ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function generateIdeogram(prompt: string): Promise<GenerateResult> {
    const response = await deps.fetchImpl('https://api.ideogram.ai/v1/ideogram-v3/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': deps.ideogramApiKey },
      body: JSON.stringify({ prompt, rendering_speed: 'QUALITY', num_images: 1 }),
    });
    if (!response.ok) {
      return {
        ok: false,
        retryable: isRetryableStatus(response.status),
        error: `ideogram returned ${response.status}`,
      };
    }
    // PAST THIS LINE THE VENDOR HAS BEEN BILLED. The generation ran, so every
    // failure below is a PAID failure — including the ones nobody enumerated.
    // `billedAttempt` is what makes that structural rather than a claim.
    const billed = IMAGE_COST_USD.ideogram;
    return billedAttempt(billed, async () => {
      // VERIFIED LIVE 2026-07-30 against the real API. `created` is an ISO
      // TIMESTAMP, not an id — the real per-request id is the `x-request-id`
      // RESPONSE HEADER, and that is what the licence manifest must persist.
      const requestId = response.headers.get('x-request-id') ?? undefined;
      // Both of the next two lines can throw on a 200: an unparseable body (a
      // CDN/WAF interstitial, a reset stream) from `json()`, and a body of
      // literal `null` from the `body.data` dereference.
      const body = (await response.json()) as {
        created?: string;
        data?: Array<{ url?: string; seed?: number; is_image_safe?: boolean }>;
      } | null;
      const first = body?.data?.[0];
      const url = first?.url;
      if (!url) {
        return {
          ok: false,
          retryable: true,
          error: 'ideogram returned no image url',
          costUsd: billed,
        };
      }
      // The URL is EPHEMERAL — signed, with a 24 h `exp`. Fetch it now; never
      // persist it. The pipeline PUTs the bytes to R2 immediately (Task 18) so a
      // parked or DLQ-replayed job never depends on a dead vendor link.
      const png = await fetchBytes(url);
      if (!isPng(png)) {
        return {
          ok: false,
          retryable: true,
          error: 'ideogram asset was not a PNG',
          costUsd: billed,
        };
      }
      return {
        ok: true,
        costUsd: IMAGE_COST_USD.ideogram,
        // `seed` makes a concept reproducible; record it in the gate audit detail.
        concept: {
          axisId: '',
          vendor: 'ideogram',
          vendorRequestId: requestId,
          png,
          seed: first.seed,
        },
      };
    });
  }

  // VERIFIED LIVE 2026-08-04 against the real API, as Ideogram above was on
  // 2026-07-30. Two calls, each one `recraftv3` `vector_illustration` image.
  // What was measured, replacing what this comment previously guessed from
  // documentation:
  //
  //   * `style: "vector_illustration"` DOES return SVG, not a raster
  //     (`image/svg+xml`, ~40-50 kB), and that SVG passes `checkTrueVector`
  //     clean BOTH raw and after `sanitizeSvg` — zero violations either way,
  //     no `<image>` element, no external references, sanitizer byte-identical.
  //     THE NATIVE-SVG BYPASS IS REAL: whenever the winning concept came from
  //     this axis, M2 skips the ~$0.20 Vectorizer.ai call — a fifth of the
  //     whole $1 anchor. The raster branch below is now the unobserved one.
  //   * THE REQUEST ID IS THE `x-recraft-requestid` RESPONSE HEADER. The body
  //     has no `id` field at all (top-level keys: `created`, `credits`,
  //     `data`), and `created` is a UNIX TIMESTAMP, not an id — the identical
  //     trap already found and fixed one vendor up. `data[0].image_id` names
  //     the OUTPUT ASSET, not the call, so it is a labelled fallback only.
  //   * `credits` REPORTS WHAT THE VENDOR CHARGED (80 for one image). The
  //     ledger bills from it rather than from a constant that drifts unseen.
  //
  // Still unobserved, and so still inferred: non-200 error bodies, the raster
  // return, and any response that omits the header or the credit count.
  async function generateRecraft(prompt: string): Promise<GenerateResult> {
    const response = await deps.fetchImpl('https://external.api.recraft.ai/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deps.recraftApiKey}`,
      },
      body: JSON.stringify({ prompt, style: 'vector_illustration', model: 'recraftv3', n: 1 }),
    });
    if (!response.ok) {
      return {
        ok: false,
        retryable: isRetryableStatus(response.status),
        error: `recraft returned ${response.status}`,
      };
    }
    // PAST THIS LINE THE VENDOR HAS BEEN BILLED — see `generateIdeogram`.
    // `billed` is the PLANNING figure; it stands only until the body tells us
    // what was really charged, and remains the value attributed by
    // `billedAttempt`'s catch, which by definition never got to read a body.
    const billed = IMAGE_COST_USD.recraft;
    return billedAttempt(billed, async () => {
      // VERIFIED LIVE 2026-08-04: the per-call id is this RESPONSE HEADER, and
      // nothing in the body is one. Read before `json()` so a body that fails
      // to parse cannot take the header down with it.
      const headerRequestId = response.headers.get('x-recraft-requestid') ?? undefined;
      const body = (await response.json()) as {
        created?: number;
        credits?: number;
        data?: Array<{ url?: string; image_id?: string }>;
      } | null;
      // WHAT THE VENDOR SAYS IT CHARGED, not what we planned for. Falls back
      // to the planning constant on any unusable count — see
      // `recraftCreditsToUsd` for why the fallback direction is upward.
      const charged = recraftCreditsToUsd(body?.credits) ?? billed;
      const url = body?.data?.[0]?.url;
      if (!url) {
        return {
          ok: false,
          retryable: true,
          error: 'recraft returned no image url',
          costUsd: charged,
        };
      }
      const bytes = await fetchBytes(url);
      // FALLBACK ONLY, AND IT IS AN ASSET ID, NOT A REQUEST ID. `image_id`
      // names the image that was produced; the licence manifest and the
      // dispute document need the id a VENDOR can look the CALL up by, which
      // is what a payer takes to them. Kept so a response that somehow
      // arrives without the header still records something traceable rather
      // than nothing — but the header is what provenance actually rests on.
      const requestId = headerRequestId ?? body?.data?.[0]?.image_id;

      // A vector-native return is the prize: it lets M2 skip Vectorizer.ai. When
      // the URL yields only an SVG, the PNG comes back EMPTY — the pipeline
      // (Task 18) rasterizes the sanitized SVG at 1024px for the OCR/pHash gates
      // and persists the SVG to R2 for stage 2's short-circuit.
      if (!isPng(bytes)) {
        const text = new TextDecoder().decode(bytes);
        if (text.includes('<svg')) {
          return {
            ok: true,
            costUsd: charged,
            concept: {
              axisId: '',
              vendor: 'recraft',
              vendorRequestId: requestId,
              png: new Uint8Array(0),
              nativeSvg: text,
            },
          };
        }
        return {
          ok: false,
          retryable: true,
          error: 'recraft asset was neither PNG nor SVG',
          costUsd: charged,
        };
      }
      return {
        ok: true,
        costUsd: charged,
        concept: { axisId: '', vendor: 'recraft', vendorRequestId: requestId, png: bytes },
      };
    });
  }

  async function generateFlux(prompt: string): Promise<GenerateResult> {
    const output = (await deps.ai.run(FLUX_MODEL_ID, { prompt })) as { image?: string } | null;
    // THE MODEL HAS RUN AND BEEN BILLED — see `generateIdeogram`. Klein is
    // near-free per call ($0.001), but the park loop this feeds is unbounded
    // without a spend signal, so "small" is not "zero".
    const billed = IMAGE_COST_USD.flux;
    return billedAttempt(billed, async () => {
      // `output?.image` rather than `output.image`: `ai.run` resolving null is
      // one of the paths that used to throw straight past cost attribution.
      if (typeof output?.image !== 'string') {
        return {
          ok: false,
          retryable: true,
          error: 'workers ai returned no image',
          costUsd: billed,
        };
      }
      // `atob` throws `InvalidCharacterError` on a non-base64 payload; the
      // wrapper attributes it, so this branch only has to name it well.
      let png: Uint8Array;
      try {
        const binary = atob(output.image);
        png = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) png[i] = binary.charCodeAt(i);
      } catch (err) {
        return {
          ok: false,
          retryable: true,
          error: `workers ai returned an undecodable image: ${errorMessage(err)}`,
          costUsd: billed,
        };
      }
      if (!isPng(png)) {
        return {
          ok: false,
          retryable: true,
          error: 'workers ai asset was not a PNG',
          costUsd: billed,
        };
      }
      return {
        ok: true,
        costUsd: IMAGE_COST_USD.flux,
        concept: { axisId: '', vendor: 'flux', png },
      };
    });
  }

  return {
    async generate(axis, prompt) {
      try {
        const result =
          axis.vendor === 'ideogram'
            ? await generateIdeogram(prompt)
            : axis.vendor === 'recraft'
              ? await generateRecraft(prompt)
              : await generateFlux(prompt);
        // Stamp the axis id here so no back end has to remember to.
        return result.ok ? { ...result, concept: { ...result.concept, axisId: axis.id } } : result;
      } catch (err) {
        // WHAT ACTUALLY REACHES HERE, enumerated rather than asserted: a throw
        // from `fetchImpl`/`ai.run` itself, i.e. before any response existed.
        // Everything after a vendor accepted a request runs inside
        // `billedAttempt`, which attributes its own cost and returns normally.
        //
        // NO `costUsd`, AND THAT IS A CONSERVATIVE GUESS, NOT A PROOF. A
        // transport throw may mean the request never arrived, or that it
        // arrived, was billed, and we lost the response — the two are
        // indistinguishable from here. This under-reports the second case. It
        // is a known gap, bounded by `sweepParkedJobs`' age bound rather than
        // its spend bound; an earlier version of this comment claimed no billed
        // call could reach this line, which was false for six paths.
        return { ok: false, retryable: true, error: errorMessage(err) };
      }
    },
  };
}
