// ---------------------------------------------------------------------------
// Blocking moderation (FR-14): a Claude (Haiku) pass over auto-pulled titles /
// headlines / a description of the rendered output. FAIL CLOSED — a timeout or
// error is never a pass. On the synchronous OG path the caller enforces the 5s
// budget (config.MODERATION_BUDGET_MS): an `unavailable` outcome inside the
// window means "respond 202 and finish asynchronously", never "deliver".
//
// `fetch` is injectable via the SDK so tests never call the live API.
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import { parseClaudeJson } from '@botguild/agent-core';
import { HAIKU_MODEL_ID, MODERATION_BUDGET_MS } from './config.js';

export type ModerationOutcome =
  /** Passed — safe to deliver. */
  | { status: 'clean' }
  /** Rejected by the model — never deliver. */
  | { status: 'flagged'; reason: string }
  /** Timed out or errored — fail closed; on the sync path → 202 + async. */
  | { status: 'unavailable'; detail: string };

export interface Moderator {
  moderate(text: string, budgetMs?: number): Promise<ModerationOutcome>;
}

export interface ModeratorConfig {
  apiKey: string;
  logger: Logger;
  /** Injectable for tests — never call the live API from a test. */
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT = `You are ThumbForge's content-safety reviewer. You are shown the text that will appear on, or was used to generate, a rendered image (a title, a headline, and/or a short description of the composed graphic). Decide whether it is safe to publish as an on-brand marketing/thumbnail image.

Flag content that is hateful, harassing, sexual/exploitative, violent, self-harm-promoting, illegal, or clearly deceptive/scammy. Ordinary marketing copy, product names, and neutral editorial headlines are safe.

Respond with ONLY a JSON object: {"flagged": boolean, "reason": string}. "reason" is a short phrase (empty when not flagged). No prose before or after the JSON.`;

interface ModerationVerdict {
  flagged?: unknown;
  reason?: unknown;
}

export function createModerator(config: ModeratorConfig): Moderator {
  const anthropic = new Anthropic({
    apiKey: config.apiKey,
    ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
  });

  return {
    async moderate(
      text: string,
      budgetMs: number = MODERATION_BUDGET_MS,
    ): Promise<ModerationOutcome> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budgetMs);
      try {
        const response = await anthropic.messages.create(
          {
            model: HAIKU_MODEL_ID,
            max_tokens: 256,
            system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: text }],
          },
          { signal: controller.signal },
        );
        const raw = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        const verdict = parseClaudeJson<ModerationVerdict>(raw);
        if (!verdict || typeof verdict.flagged !== 'boolean') {
          return {
            status: 'unavailable',
            detail: 'moderation response missing a boolean `flagged`',
          };
        }
        return verdict.flagged
          ? {
              status: 'flagged',
              reason: typeof verdict.reason === 'string' ? verdict.reason : 'flagged',
            }
          : { status: 'clean' };
      } catch (err) {
        const detail = controller.signal.aborted
          ? `moderation exceeded the ${budgetMs}ms budget`
          : `moderation call failed: ${(err as Error).message}`;
        config.logger.warn({ detail }, 'moderation unavailable — failing closed');
        return { status: 'unavailable', detail };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
