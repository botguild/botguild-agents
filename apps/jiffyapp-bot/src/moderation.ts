// Pinned moderation vendor client (§9): OpenAI Moderation, sole v1 vendor,
// FAIL CLOSED — a 429/5xx/network failure is an outage outcome, never a pass.
// The model id is pinned (not `-latest`) so every stored verdict names the
// exact model that produced it; a vendor swap (Azure Content Safety is the
// named future candidate) requires a checklist review + gig-terms bump, not a
// config flip. Pure fetch, injectable for tests — never call the live API
// from a test.
//
// Copied verbatim from apps/voicewright-bot/src/gates/moderation.ts (same pinned
// vendor/model/URL/fail-closed semantics), then extended with `moderateImage` — an omni
// multi-modal input (image_url) variant with identical fail-closed semantics, sharing the
// same request/parse/fail-closed plumbing via `callModeration`. `ModerationVerdict` is
// defined locally rather than imported from voicewright — this bot has its own types module.

export const MODERATION_VENDOR = 'openai';
export const MODERATION_MODEL = 'omni-moderation-2024-09-26';
const MODERATION_URL = 'https://api.openai.com/v1/moderations';

/** Snapshot of the moderation vendor's full verdict for one input (§9 evidence). */
export interface ModerationVerdict {
  vendor: string;
  model: string;
  flagged: boolean;
  /** The vendor's full response body, retained verbatim for dispute evidence. */
  response: unknown;
  checkedAt: string;
}

export type ModerationOutcome =
  | { ok: true; verdict: ModerationVerdict }
  | { ok: false; kind: 'outage'; detail: string };

export interface ModerationClient {
  moderate(text: string): Promise<ModerationOutcome>;
  /** Same fail-closed semantics as `moderate`, over an omni multi-modal image input. */
  moderateImage(dataUrl: string): Promise<ModerationOutcome>;
}

export interface ModerationClientConfig {
  apiKey: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface ModerationResponse {
  model?: string;
  results?: Array<{ flagged?: boolean }>;
}

/** The omni multi-modal input shape for a single image input. */
export function moderationInputForImage(dataUrl: string): unknown {
  return [{ type: 'image_url', image_url: { url: dataUrl } }];
}

export function createModerationClient(config: ModerationClientConfig): ModerationClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? ((): Date => new Date());

  /** Shared request/parse/fail-closed plumbing for both text and image moderation. */
  async function callModeration(input: unknown): Promise<ModerationOutcome> {
    let response: Response;
    try {
      response = await fetchImpl(MODERATION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: MODERATION_MODEL, input }),
      });
    } catch (err) {
      return { ok: false, kind: 'outage', detail: `network error: ${(err as Error).message}` };
    }

    // Any non-2xx fails closed. 429/5xx are genuine outages; a 4xx (bad key,
    // deprecated model) is a config fault — still never treated as a pass.
    if (!response.ok) {
      return { ok: false, kind: 'outage', detail: `moderation API responded ${response.status}` };
    }

    let body: ModerationResponse;
    try {
      body = (await response.json()) as ModerationResponse;
    } catch {
      return { ok: false, kind: 'outage', detail: 'moderation API returned unparseable JSON' };
    }

    const result = body.results?.[0];
    if (!result || typeof result.flagged !== 'boolean') {
      return {
        ok: false,
        kind: 'outage',
        detail: 'moderation API response missing results[0].flagged',
      };
    }

    return {
      ok: true,
      verdict: {
        vendor: MODERATION_VENDOR,
        model: body.model ?? MODERATION_MODEL,
        flagged: result.flagged,
        response: body, // full verdict snapshot, retained for §9 evidence
        checkedAt: now().toISOString(),
      },
    };
  }

  return {
    moderate(text: string): Promise<ModerationOutcome> {
      return callModeration(text);
    },
    moderateImage(dataUrl: string): Promise<ModerationOutcome> {
      return callModeration(moderationInputForImage(dataUrl));
    },
  };
}
