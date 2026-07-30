// Input moderation (FR-2). The brand name and brief are screened BEFORE any
// image-API call — never generate from an unscreened brief.
//
// Fail-closed is the whole point: a vendor 429, a 5xx, a network drop, or a
// body we cannot parse all return `unavailable`, and the caller parks the job
// for cron re-enqueue. An outage must never read as a pass.

import type { FetchLike } from './types.js';

export const MODERATION_VENDOR = 'openai';
export const MODERATION_MODEL = 'omni-moderation-2024-09-26';

export interface ModerationVerdict {
  vendor: string;
  model: string;
  flagged: boolean;
  /** The vendor's full response body, retained verbatim for dispute evidence. */
  response: unknown;
  checkedAt: string;
}

export type ModerationOutcome =
  | { status: 'clear'; verdict: ModerationVerdict }
  | { status: 'flagged'; verdict: ModerationVerdict }
  | { status: 'unavailable'; error: string };

export interface ModerationClient {
  screen(text: string): Promise<ModerationOutcome>;
}

export function createModerationClient(deps: {
  fetchImpl: FetchLike;
  apiKey: string;
  now?: () => Date;
}): ModerationClient {
  const now = deps.now ?? ((): Date => new Date());

  return {
    async screen(text) {
      try {
        const response = await deps.fetchImpl('https://api.openai.com/v1/moderations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${deps.apiKey}`,
          },
          body: JSON.stringify({ model: MODERATION_MODEL, input: text }),
        });
        if (!response.ok) {
          return { status: 'unavailable', error: `moderation vendor returned ${response.status}` };
        }
        const body = (await response.json()) as { results?: Array<{ flagged?: boolean }> };
        const first = body.results?.[0];
        if (!first || typeof first.flagged !== 'boolean') {
          return {
            status: 'unavailable',
            error: 'moderation response was not in the expected shape',
          };
        }
        const verdict: ModerationVerdict = {
          vendor: MODERATION_VENDOR,
          model: MODERATION_MODEL,
          flagged: first.flagged,
          response: body,
          checkedAt: now().toISOString(),
        };
        return first.flagged ? { status: 'flagged', verdict } : { status: 'clear', verdict };
      } catch (err) {
        return { status: 'unavailable', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
