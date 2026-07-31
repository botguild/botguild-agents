// Image vendor adapters (FR-4). One entry point, three back ends:
//   ideogram — lettering-heavy axes (its lettering quality is the whole reason
//              the OCR gate is winnable)
//   recraft  — the vector-native/icon-led axis; its native SVG export, when
//              present, lets M2 skip Vectorizer.ai entirely
//   flux     — the FREE taster only, via the Workers AI binding (near-free)
//
// Every path returns a result object rather than throwing: a vendor failure is
// a pipeline decision (retry within caps, or park), not an exception.

import { FLUX_MODEL_ID, IMAGE_COST_USD } from './config.js';
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
    // PAST THIS LINE THE VENDOR HAS BEEN BILLED. The generation ran; every
    // failure below is a PAID failure and carries `costUsd` so the FR-5 ledger
    // sees it (see `GenerateResult`).
    const billed = IMAGE_COST_USD.ideogram;
    // VERIFIED LIVE 2026-07-30 against the real API. `created` is an ISO
    // TIMESTAMP, not an id — the real per-request id is the `x-request-id`
    // RESPONSE HEADER, and that is what the licence manifest must persist.
    const requestId = response.headers.get('x-request-id') ?? undefined;
    const body = (await response.json()) as {
      created?: string;
      data?: Array<{ url?: string; seed?: number; is_image_safe?: boolean }>;
    };
    const first = body.data?.[0];
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
    //
    // Caught HERE rather than by the outer catch-all in `generate()`: that one
    // cannot know whether the vendor had already been paid, and would report
    // this paid failure as a free one.
    let png: Uint8Array;
    try {
      png = await fetchBytes(url);
    } catch (err) {
      return { ok: false, retryable: true, error: errorMessage(err), costUsd: billed };
    }
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
  }

  // NOT verified live, unlike Ideogram above — this shape is from Recraft's
  // documentation only; no API key was obtainable this session (its Generate
  // button is gated behind a prepaid API-units balance). Two things are
  // explicitly unproven: whether `style: "vector_illustration"` actually
  // returns SVG rather than a raster, and the exact response field names
  // below. The native-SVG branch is kept anyway — unproven, not dead code —
  // because if it does work it lets M2 skip Vectorizer.ai entirely
  // (~$0.15/job against a $1 anchor).
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
    const billed = IMAGE_COST_USD.recraft;
    const body = (await response.json()) as {
      id?: string;
      data?: Array<{ url?: string; image_id?: string }>;
    };
    const url = body.data?.[0]?.url;
    if (!url) {
      return {
        ok: false,
        retryable: true,
        error: 'recraft returned no image url',
        costUsd: billed,
      };
    }
    let bytes: Uint8Array;
    try {
      bytes = await fetchBytes(url);
    } catch (err) {
      return { ok: false, retryable: true, error: errorMessage(err), costUsd: billed };
    }
    const requestId = body.id ?? body.data?.[0]?.image_id;

    // A vector-native return is the prize: it lets M2 skip Vectorizer.ai. When
    // the URL yields only an SVG, the PNG comes back EMPTY — the pipeline
    // (Task 18) rasterizes the sanitized SVG at 1024px for the OCR/pHash gates
    // and persists the SVG to R2 for stage 2's short-circuit.
    if (!isPng(bytes)) {
      const text = new TextDecoder().decode(bytes);
      if (text.includes('<svg')) {
        return {
          ok: true,
          costUsd: IMAGE_COST_USD.recraft,
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
        costUsd: billed,
      };
    }
    return {
      ok: true,
      costUsd: IMAGE_COST_USD.recraft,
      concept: { axisId: '', vendor: 'recraft', vendorRequestId: requestId, png: bytes },
    };
  }

  async function generateFlux(prompt: string): Promise<GenerateResult> {
    const output = (await deps.ai.run(FLUX_MODEL_ID, { prompt })) as { image?: string };
    // THE MODEL HAS RUN AND BEEN BILLED — see `generateIdeogram`. Klein is
    // near-free per call ($0.001), but the park loop this feeds is unbounded
    // without a spend signal, so "small" is not "zero".
    const billed = IMAGE_COST_USD.flux;
    if (typeof output.image !== 'string') {
      return {
        ok: false,
        retryable: true,
        error: 'workers ai returned no image',
        costUsd: billed,
      };
    }
    let png: Uint8Array;
    try {
      const binary = atob(output.image);
      png = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) png[i] = binary.charCodeAt(i);
    } catch (err) {
      // `atob` throws `InvalidCharacterError` on a non-base64 payload. Caught
      // here, not by the outer catch-all, for the same reason as above.
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
        // No `costUsd`: this catch cannot tell a pre-billing network throw from
        // a post-billing one, so the paid branches attach their own cost
        // BEFORE unwinding here and nothing reaches this line already billed.
        return { ok: false, retryable: true, error: errorMessage(err) };
      }
    },
  };
}
