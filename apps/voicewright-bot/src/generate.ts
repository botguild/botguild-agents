// Haiku generation (FR-4): angle-structured variants in the learned brand
// voice, regeneration prompts that feed gate failures back as constraints
// (FR-5/FR-7), and the FREE gig's plain-language rewrite (Story B). The
// system prompt is stable and prompt-cached (repo convention — see
// agent-core's proposer.ts); everything gig-specific rides the user message.
//
// Every call reports its real token cost at pinned Haiku pricing — the FR-5
// $1.50 cap is enforced by the pipeline from these numbers, so cost
// accounting is pure and unit-tested.

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import { parseClaudeJson } from '@botguild/agent-core';
import { HAIKU_MODEL_ID, HAIKU_PRICING_PER_MTOK } from './config.js';
import type { AdBrief, Variant } from './types.js';

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Real-usage dollars at pinned Haiku 4.5 list pricing. */
export function usageCostUsd(usage: UsageLike): number {
  const perTok = 1 / 1_000_000;
  return (
    usage.input_tokens * HAIKU_PRICING_PER_MTOK.input * perTok +
    usage.output_tokens * HAIKU_PRICING_PER_MTOK.output * perTok +
    (usage.cache_creation_input_tokens ?? 0) * HAIKU_PRICING_PER_MTOK.cacheWrite * perTok +
    (usage.cache_read_input_tokens ?? 0) * HAIKU_PRICING_PER_MTOK.cacheRead * perTok
  );
}

export type DraftVariant = Omit<Variant, 'id'>;

export interface GeneratedBatch {
  variants: DraftVariant[];
  costUsd: number;
}

export interface CopyGenerator {
  /** Generate `count` fresh variants across ≥ `angleCount` distinct angles. */
  generateBatch(brief: AdBrief, count: number, avoidAngles?: string[]): Promise<GeneratedBatch>;
  /** Regenerate one variant, feeding its gate failures back as constraints. */
  regenerateVariant(
    brief: AdBrief,
    failed: Variant,
    failures: string[],
  ): Promise<{ variant: DraftVariant; costUsd: number }>;
  /** Story B: rewrite one paragraph at a plain-language reading grade. */
  rewritePlainLanguage(
    paragraph: string,
    feedback?: string,
  ): Promise<{ rewrite: string; costUsd: number }>;
}

const AD_SYSTEM_PROMPT = `You are VoiceWright, a senior performance-marketing copywriter producing Facebook/Instagram ad copy for paid clients on the BotGuild marketplace.

You write short-form ad copy that converts while staying strictly on-brand and policy-safe. You always work from the client's brand voice guide and offer, and you treat their policy constraints as hard prohibitions, never suggestions.

Hard rules for every line you write:
- Headlines are at most 36 grapheme clusters (user-perceived characters). Primary text is at most 112. These targets leave safety margin below Meta's limits; NEVER exceed them and never pad to reach them.
- Every variant carries an "angle" tag: a short label for the persuasion angle it takes (e.g. "social-proof", "urgency", "problem-agitation", "value", "curiosity"). Variants in different angles must read genuinely differently — different framing, different vocabulary, different structure — not the same sentence reworded.
- No personal-attribute call-outs ("Are you overweight?", "struggling with debt?"). No miracle/cure/guaranteed-outcome claims. No repeated punctuation (!!, ??). No ALL-CAPS shouting words.
- Respect every client policy constraint exactly as written.

Output format: respond with ONLY a JSON object of the shape
{"variants": [{"angle": "...", "headline": "...", "primaryText": "...", "description": "..."}]}
where "description" is the short link description (a few words, under 30 characters). No prose before or after the JSON.`;

const REWRITE_SYSTEM_PROMPT = `You are VoiceWright's plain-language editor. Rewrite the paragraph you are given so it is easier to read: shorter sentences, common words, active voice. Preserve the meaning and all factual content. The rewrite must be at the same or a lower Flesch-Kincaid grade than the input — never harder to read. Respond with ONLY the rewritten paragraph, no preamble.`;

function briefUserPrompt(brief: AdBrief): string {
  const constraints =
    brief.policyConstraints.length > 0
      ? `\nHard policy constraints from the client (absolute prohibitions):\n${brief.policyConstraints.map((c) => `- ${c}`).join('\n')}`
      : '';
  return `Brand voice guide:\n${brief.brandVoiceGuide}\n\nOffer being advertised: ${brief.offer}\nPlatform: ${brief.platform}\nLanding page: ${brief.creative.landingUrl}${constraints}`;
}

interface VariantsPayload {
  variants?: Array<{ angle?: unknown; headline?: unknown; primaryText?: unknown; description?: unknown }>;
}

export function parseVariantsPayload(text: string): DraftVariant[] {
  const payload = parseClaudeJson<VariantsPayload>(text);
  if (!payload || !Array.isArray(payload.variants)) {
    throw new Error('model response has no variants array');
  }
  return payload.variants.map((v, idx) => {
    if (
      typeof v.angle !== 'string' ||
      typeof v.headline !== 'string' ||
      typeof v.primaryText !== 'string' ||
      typeof v.description !== 'string'
    ) {
      throw new Error(`variant ${idx} is missing angle/headline/primaryText/description strings`);
    }
    return {
      angle: v.angle.trim(),
      headline: v.headline.trim(),
      primaryText: v.primaryText.trim(),
      description: v.description.trim(),
    };
  });
}

export interface CopyGeneratorConfig {
  apiKey: string;
  logger: Logger;
  /** Injectable for tests — never call the live API from a test. */
  fetchImpl?: typeof fetch;
}

export function createCopyGenerator(config: CopyGeneratorConfig): CopyGenerator {
  const anthropic = new Anthropic({
    apiKey: config.apiKey,
    ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
  });

  async function call(
    system: string,
    userPrompt: string,
    maxTokens: number,
  ): Promise<{ text: string; costUsd: number }> {
    const response = await anthropic.messages.create({
      model: HAIKU_MODEL_ID,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    });
    const costUsd = usageCostUsd(response.usage);
    config.logger.info(
      {
        model: HAIKU_MODEL_ID,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens,
        costUsd,
      },
      'haiku call complete',
    );
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    return { text, costUsd };
  }

  return {
    async generateBatch(brief, count, avoidAngles = []): Promise<GeneratedBatch> {
      const avoid =
        avoidAngles.length > 0
          ? `\nThe batch already contains variants tagged: ${avoidAngles.join(', ')}. Prefer fresh angles and phrasing clearly distinct from those.`
          : '';
      const prompt =
        `${briefUserPrompt(brief)}\n\nWrite exactly ${count} ad variants spread across at least ` +
        `${Math.min(brief.angleCount, count)} distinct angles.${avoid}`;
      const { text, costUsd } = await call(AD_SYSTEM_PROMPT, prompt, 8192);
      return { variants: parseVariantsPayload(text), costUsd };
    },

    async regenerateVariant(brief, failed, failures): Promise<{ variant: DraftVariant; costUsd: number }> {
      const prompt =
        `${briefUserPrompt(brief)}\n\nThe following variant FAILED validation and must be rewritten from scratch ` +
        `(same angle "${failed.angle}", entirely new copy):\n` +
        `headline: ${failed.headline}\nprimaryText: ${failed.primaryText}\ndescription: ${failed.description}\n\n` +
        `Validation failures to fix — treat each as a hard constraint:\n${failures.map((f) => `- ${f}`).join('\n')}\n\n` +
        `Write exactly 1 replacement variant.`;
      const { text, costUsd } = await call(AD_SYSTEM_PROMPT, prompt, 1024);
      const variants = parseVariantsPayload(text);
      if (variants.length === 0) throw new Error('regeneration returned no variant');
      return { variant: variants[0] as DraftVariant, costUsd };
    },

    async rewritePlainLanguage(paragraph, feedback): Promise<{ rewrite: string; costUsd: number }> {
      const prompt = feedback
        ? `${paragraph}\n\n(Your previous rewrite was rejected: ${feedback}. Try again, simpler.)`
        : paragraph;
      const { text, costUsd } = await call(REWRITE_SYSTEM_PROMPT, prompt, 1024);
      return { rewrite: text.trim(), costUsd };
    },
  };
}
