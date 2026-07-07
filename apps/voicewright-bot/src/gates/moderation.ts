// Pinned moderation vendor client (§9): OpenAI Moderation, sole v1 vendor,
// FAIL CLOSED — a 429/5xx/network failure is an outage outcome, never a pass.
// The model id is pinned (not `-latest`) so every stored verdict names the
// exact model that produced it; a vendor swap (Azure Content Safety is the
// named future candidate) requires a checklist review + gig-terms bump, not a
// config flip. Pure fetch, injectable for tests — never call the live API
// from a test.

import type { ModerationVerdict } from '../types.js';

export const MODERATION_VENDOR = 'openai';
export const MODERATION_MODEL = 'omni-moderation-2024-09-26';
const MODERATION_URL = 'https://api.openai.com/v1/moderations';

export type ModerationOutcome =
  | { ok: true; verdict: ModerationVerdict }
  | { ok: false; kind: 'outage'; detail: string };

export interface ModerationClient {
  moderate(text: string): Promise<ModerationOutcome>;
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

export function createModerationClient(config: ModerationClientConfig): ModerationClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? ((): Date => new Date());

  return {
    async moderate(text: string): Promise<ModerationOutcome> {
      let response: Response;
      try {
        response = await fetchImpl(MODERATION_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ model: MODERATION_MODEL, input: text }),
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
        return { ok: false, kind: 'outage', detail: 'moderation API response missing results[0].flagged' };
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
    },
  };
}
