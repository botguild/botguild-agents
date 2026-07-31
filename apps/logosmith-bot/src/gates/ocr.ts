// ---------------------------------------------------------------------------
// Lettering readback gate (FR-5, §9) — the headline gate.
//
// Every paid concept's visible brand text is transcribed by the pinned Workers
// AI vision model and matched against the brand name at a normalized
// similarity threshold. Failing concepts are REGENERATED, never delivered.
//
// This is not classical OCR: a vision model is nondeterministic and can drift
// between versions. Two consequences are baked in here — temperature 0, and a
// verdict snapshot (model id + raw transcription + score) that becomes the
// contractual record of what passed at delivery time.
//
// Normalization is deliberately conservative. Folding case, NFKC forms,
// diacritics, punctuation and whitespace makes "Harbor & Vine" match
// "HARBOR&VINE"; folding digits or symbols into letters would make "H@rb0r"
// match "Harbor", which is exactly the failure the gate exists to catch.
// ---------------------------------------------------------------------------

import { OCR_SIMILARITY_THRESHOLD, SCOUT_MODEL_ID } from '../config.js';
import type { AiLike, OcrVerdict } from '../types.js';

export type OcrOutcome =
  | { status: 'ok'; verdict: OcrVerdict }
  | { status: 'unavailable'; error: string };

export interface OcrGate {
  check(png: Uint8Array, brandName: string, threshold?: number): Promise<OcrOutcome>;
}

/** NFKC case-fold, strip diacritics, drop punctuation and whitespace. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '') // combining marks (diacritics)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, '');
}

/** Levenshtein distance, iterative two-row form. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Normalized similarity ratio in [0, 1] over already-normalized strings.
 *
 * AN EMPTY SIDE SCORES 0, NOT 1, AND THAT IS THE WHOLE GATE.
 *
 * This function used to answer `1` when BOTH sides were empty, which made the
 * lettering readback vacuously satisfiable. `isLatinScript` admits `\p{P}` and
 * assorted symbols, so `&&&` was a valid brand name; `normalizeForMatch` drops
 * all punctuation, so it normalized to `""`; a model reporting no legible
 * lettering at all transcribed to `""` as well — and the two empties matched
 * perfectly. With the `prompt_tokens` canary SATISFIED (the image really did
 * arrive), the gate returned `{ transcription: "   ", score: 1, pass: true }`.
 *
 * Everything downstream then asserts a verification that did not happen: the
 * M1 note, the progress page's "Lettering readback: PASS (1.00)",
 * `report.json`, the warranty terms and the dispute document. A false claim in
 * an evidence document, reached with no attacker at all.
 *
 * Intake refuses such a brand name outright (`parseLogoBrief`), so this is the
 * second of two independent guards. It is not redundant: this is the one that
 * holds if any other caller ever hands the gate an unrenderable reference, and
 * "nothing to compare against" is an absence of evidence, never a pass.
 */
export function similarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

const VISION_PROMPT =
  'Transcribe the text visible in this logo image EXACTLY as it appears, character for character. ' +
  'Do not correct spelling, do not guess at a brand name, do not add words that are not visibly ' +
  'rendered. Also report whether the image contains unsafe or inappropriate content. ' +
  'Respond with ONLY JSON: {"text":"<exact transcription>","unsafe":<true|false>}';

/**
 * Floor on `usage.prompt_tokens` below which we assume the image never
 * reached the model. Measured: 40 with the image silently dropped, 2497 with
 * a 1024px image ingested. 500 sits far from both.
 */
export const MIN_VISION_PROMPT_TOKENS = 500;

/** base64 for Workers (no Buffer): chunked to avoid blowing the arg limit. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Pull the first JSON object out of a response that may carry prose or fences. */
function extractJson(text: string): { text?: unknown; unsafe?: unknown } | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as { text?: unknown; unsafe?: unknown };
  } catch {
    return null;
  }
}

export function createOcrGate(deps: { ai: AiLike; now?: () => Date }): OcrGate {
  const now = deps.now ?? ((): Date => new Date());

  return {
    async check(png, brandName, threshold = OCR_SIMILARITY_THRESHOLD) {
      try {
        // VERIFIED LIVE 2026-07-30. Scout is a CHAT model: it takes
        // `messages` with content parts and a base64 data URI. The
        // byte-array `{ prompt, image: [...png] }` form used by the older
        // llava-style models is ACCEPTED WITH HTTP 200 AND SILENTLY IGNORES
        // THE IMAGE — measured prompt_tokens 40, and the model returned a
        // confident, well-formed, entirely hallucinated transcription ("The
        // quick brown fox jumps over the lazy dog" for an image reading
        // "ACME"). The correct form measured prompt_tokens 2497 and returned
        // "ACME". Do not "simplify" this back to the byte-array form.
        const output = (await deps.ai.run(SCOUT_MODEL_ID, {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: VISION_PROMPT },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${toBase64(png)}` } },
              ],
            },
          ],
          // Nondeterminism is the risk (§13); pin it as far down as the API allows.
          temperature: 0,
          max_tokens: 256,
        })) as { response?: unknown; usage?: { prompt_tokens?: number } };

        // Hallucination canary. A prompt that carried a 1024px image measures
        // in the thousands of tokens; an ignored image measures in the tens.
        // Without this check a silently-dropped image yields a confident wrong
        // verdict — the one failure this gate exists to prevent. Too-low means
        // UNAVAILABLE (park and retry), never a pass or a fail.
        //
        // `typeof x === 'number'` is NOT sufficient on its own: `typeof NaN
        // === 'number'`, and `NaN < 500` is false, which would let the canary
        // silently pass through. Anything that isn't a finite number collapses
        // to 0 and fails closed.
        const rawPromptTokens = output.usage?.prompt_tokens;
        const promptTokens =
          typeof rawPromptTokens === 'number' && Number.isFinite(rawPromptTokens)
            ? rawPromptTokens
            : 0;
        if (promptTokens < MIN_VISION_PROMPT_TOKENS) {
          return {
            status: 'unavailable',
            error: `vision request carried no image (prompt_tokens=${promptTokens}); refusing to verdict on a text-only response`,
          };
        }

        // `response` arrives already parsed when the model emits clean JSON,
        // and as a string otherwise — handle both.
        const parsed =
          typeof output.response === 'string'
            ? extractJson(output.response)
            : ((output.response ?? null) as { text?: unknown; unsafe?: unknown } | null);
        if (!parsed || typeof parsed.text !== 'string') {
          return { status: 'unavailable', error: 'vision model returned no usable transcription' };
        }
        // A present-but-wrong-typed `unsafe` (e.g. the JSON string "true"
        // rather than the boolean true) can't be trusted either way — refuse
        // to verdict rather than silently coercing it. Absent is fine: that's
        // today's default-to-false behavior, unchanged below.
        if (parsed.unsafe !== undefined && typeof parsed.unsafe !== 'boolean') {
          return {
            status: 'unavailable',
            error: 'vision model returned a non-boolean unsafe flag',
          };
        }

        const transcription = parsed.text;
        const score = similarity(normalizeForMatch(transcription), normalizeForMatch(brandName));
        const unsafe = parsed.unsafe === true;

        return {
          status: 'ok',
          verdict: {
            model: SCOUT_MODEL_ID,
            transcription,
            score,
            unsafe,
            // An unsafe image never passes, however well it spells.
            pass: score >= threshold && !unsafe,
            checkedAt: now().toISOString(),
          },
        };
      } catch (err) {
        return { status: 'unavailable', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
