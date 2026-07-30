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
  | { ok: false; retryable: boolean; error: string };

export interface Generator {
  generate(axis: StyleAxis, prompt: string): Promise<GenerateResult>;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const isPng = (bytes: Uint8Array): boolean =>
  bytes.length > 8 && PNG_MAGIC.every((byte, i) => bytes[i] === byte);

/** 5xx and 429 are worth another attempt; 4xx means the request itself is wrong. */
const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

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
    if (!url) return { ok: false, retryable: true, error: 'ideogram returned no image url' };
    // The URL is EPHEMERAL — signed, with a 24 h `exp`. Fetch it now; never
    // persist it. The pipeline PUTs the bytes to R2 immediately (Task 18) so a
    // parked or DLQ-replayed job never depends on a dead vendor link.
    const png = await fetchBytes(url);
    if (!isPng(png)) return { ok: false, retryable: true, error: 'ideogram asset was not a PNG' };
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
    const body = (await response.json()) as {
      id?: string;
      data?: Array<{ url?: string; image_id?: string }>;
    };
    const url = body.data?.[0]?.url;
    if (!url) return { ok: false, retryable: true, error: 'recraft returned no image url' };
    const bytes = await fetchBytes(url);
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
      return { ok: false, retryable: true, error: 'recraft asset was neither PNG nor SVG' };
    }
    return {
      ok: true,
      costUsd: IMAGE_COST_USD.recraft,
      concept: { axisId: '', vendor: 'recraft', vendorRequestId: requestId, png: bytes },
    };
  }

  async function generateFlux(prompt: string): Promise<GenerateResult> {
    const output = (await deps.ai.run(FLUX_MODEL_ID, { prompt })) as { image?: string };
    if (typeof output.image !== 'string') {
      return { ok: false, retryable: true, error: 'workers ai returned no image' };
    }
    const binary = atob(output.image);
    const png = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) png[i] = binary.charCodeAt(i);
    if (!isPng(png)) return { ok: false, retryable: true, error: 'workers ai asset was not a PNG' };
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
        return {
          ok: false,
          retryable: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
