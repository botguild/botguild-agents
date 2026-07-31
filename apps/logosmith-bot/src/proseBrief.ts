// ---------------------------------------------------------------------------
// Prose brief intake (FR-1 fallback).
//
// MEASURED LIVE 2026-07-30: 0 of 78 open BotGuild gigs carried a fenced JSON
// block — or any `{...}` at all. Real gigs carry ordinary prose plus the
// platform's own structured fields (`acceptanceCriteria`, `deliverables`,
// `tags`), and it is the prose that names the brand. Without this fallback
// `parseLogoBrief` rejects essentially every real gig on the marketplace.
//
// THIS MODULE TURNS UNTRUSTED BUYER PROSE INTO THE INPUT THAT DRIVES EVERY
// DOWNSTREAM GUARD. The `brandName` it produces is the exact string the OCR
// readback gate compares a generated logo against, and the string the image
// vendors are told to render. If extraction invents it, the whole verification
// chain verifies the wrong thing — confidently. Three properties hold that
// down, and none of them is optional:
//
//  1. Extraction produces a CANDIDATE; `parseLogoBrief` DECIDES. The same
//     function the fenced path uses, unchanged, applied by re-fencing the
//     candidate — exactly the trick `pipeline.ts` already uses to re-validate a
//     stored `brief_json`. There is no relaxed variant and no "Haiku said so"
//     bypass, so a correction, a stored brief, and a prose extraction all
//     converge on one validation implementation.
//
//  2. Exactly two fields are read off the model's JSON: `brandName` and
//     `industry`. The other fields a `LogoBrief` can carry (`brief`,
//     `palettePreference`, `avoid`, `script`) reach the image prompts and the
//     moderation text, and are dropped here by CONSTRUCTION rather than by
//     name — an allow-list cannot fail open on a key nobody thought to block.
//
//  3. GROUNDING: the validated `brandName` must appear in the text the model
//     was actually shown. This is the analogue of the OCR gate's
//     `prompt_tokens` canary (gates/ocr.ts): a model that returns HTTP 200 and
//     well-formed JSON has not necessarily read its input. A brand name that
//     is not in the gig was invented, and an invented brand name would have
//     LogoSmith generating — and then OCR-"verifying" — a logo for a company
//     nobody named. Grounding is necessary, not sufficient: it cannot tell a
//     correctly-chosen name from a wrongly-chosen one, only a quoted name from
//     a fabricated one. That is the failure it exists to catch.
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk';
import { criterionText, type AcceptanceCriterion } from '@botguild/agent-core';
import { parseLogoBrief, type BriefResult, type LogoBriefExtractorLike } from './brief.js';
import { HAIKU_MODEL_ID, HAIKU_PRICING_PER_MTOK } from './config.js';
import type { LogoBrief } from './types.js';

/** The subset of a `Gig` extraction reads. `Gig` satisfies it structurally. */
export interface ProseGig {
  title?: string;
  description?: string;
  acceptanceCriteria?: AcceptanceCriterion[];
  deliverables?: string[];
  tags?: string[];
}

export type ProseBriefExtractor = LogoBriefExtractorLike<ProseGig>;

/**
 * Fold everything the buyer wrote into one payload.
 *
 * This string is BOTH the model's input and the corpus the extracted brand
 * name is grounded against, and that coupling is deliberate: the model may
 * quote from exactly what it was shown, so the two can never be built from
 * different fields. Widening the prompt widens what counts as grounded — which
 * is correct, and is why it must stay one function.
 */
export function buildProseExtractionInput(gig: ProseGig): string {
  const sections: string[] = [
    `TITLE: ${(gig.title ?? '').trim()}`,
    `DESCRIPTION:\n${(gig.description ?? '').trim()}`,
  ];

  const nonBlank = (values: string[]): string[] =>
    values.map((value) => value.trim()).filter((value) => value.length > 0);

  const criteria = nonBlank((gig.acceptanceCriteria ?? []).map(criterionText));
  if (criteria.length > 0) {
    sections.push(`ACCEPTANCE CRITERIA:\n${criteria.map((text) => `- ${text}`).join('\n')}`);
  }
  const deliverables = nonBlank(gig.deliverables ?? []);
  if (deliverables.length > 0) {
    sections.push(`DELIVERABLES:\n${deliverables.map((text) => `- ${text}`).join('\n')}`);
  }
  const tags = nonBlank(gig.tags ?? []);
  if (tags.length > 0) sections.push(`TAGS: ${tags.join(', ')}`);

  return sections.join('\n\n');
}

// MEASURED 2026-07-31 via the (free) count_tokens endpoint: this system prompt
// is 245 tokens, and system + a representative real-shaped gig is 412. Haiku
// 4.5's minimum cacheable prefix is 4096, so the `cache_control` marker below
// is a NO-OP — axes.ts documents the live confirmation (two identical calls
// each returned cache_creation_input_tokens: 0 and cache_read_input_tokens: 0,
// with no error). The marker is kept for shape-consistency with axes.ts and
// because it is free, but PROMPT CACHING IS NOT A COST CONTROL ON THIS CALL.
// The cost control is the call ORDERING in sweeps.ts, which runs extraction
// only on gigs that already cleared the relevance bar.
const SYSTEM_PROMPT =
  'You extract a logo brief from a marketplace gig posting written in ordinary prose. ' +
  'Return ONLY a JSON object of the shape {"brandName": <string|null>, "industry": <string|null>}, ' +
  'with no prose, no explanation and no markdown fences.\n' +
  'brandName MUST be copied VERBATIM from the gig text: the exact characters the buyer wrote, ' +
  'with no reformatting, no expansion of abbreviations, no re-casing and no invention. It is the ' +
  'string that will be rendered as lettering on a logo and then read back character by character, ' +
  'so a rewritten name is as wrong as a made-up one.\n' +
  'If the gig does not clearly name a brand, company, product or site to put on the logo, return ' +
  '{"brandName": null}. Declining is correct and expected; guessing is not. A guessed name ' +
  'produces a logo for a company nobody named.\n' +
  'industry is a short noun phrase for what the brand does (for example "boutique inn" or ' +
  '"developer tools SaaS"). Infer it from the gig when it is not stated outright.';

/** Anthropic usage counters, as far as spend accounting cares. */
interface HaikuUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

const billable = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * What one extraction call cost, off the shipped Haiku rate card.
 *
 * The two cache classes are priced even though caching is inert at today's
 * prefix size (see SYSTEM_PROMPT) — they become live the moment the prompt
 * grows past the 4096-token floor, and a cost function that silently ignored
 * them would understate spend exactly then. A missing or non-finite counter
 * reports 0, which UNDERSTATES a call that failed mid-flight after the model
 * ran; there is no usage to read in that case and no way to guess it.
 */
export function extractionCostUsd(usage: HaikuUsage | undefined | null): number {
  if (!usage) return 0;
  const rate = HAIKU_PRICING_PER_MTOK;
  return (
    (billable(usage.input_tokens) * rate.input +
      billable(usage.output_tokens) * rate.output +
      billable(usage.cache_creation_input_tokens) * rate.cacheWrite +
      billable(usage.cache_read_input_tokens) * rate.cacheRead) /
    1_000_000
  );
}

/**
 * Casefold and collapse whitespace runs — and deliberately nothing else.
 *
 * Every further normalization makes grounding MORE permissive, which is the
 * wrong direction for a check whose whole job is to refuse names the buyer did
 * not write. Folding punctuation would let the model turn "Harbor and Vine"
 * into "Harbor & Vine" and still pass, and that rewritten string is what gets
 * rendered as lettering and then OCR-compared.
 */
const groundingForm = (text: string): string => text.toLowerCase().replace(/\s+/gu, ' ').trim();

/** Pull the first JSON object out of a response that may carry prose or fences. */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createProseBriefExtractor(deps: {
  anthropic: Anthropic;
  /**
   * Called EXACTLY ONCE per `extract`, on every path including failures — a
   * refused extraction still burned tokens. Required rather than optional: at
   * the $1 introductory anchor (config.ts `SEED_PRICE_USD`) this call is a real
   * fraction of margin, and an extractor that could be constructed without a
   * spend sink is an extractor whose cost goes unrecorded by default.
   */
  recordSpend: (costUsd: number) => void;
}): ProseBriefExtractor {
  return {
    async extract(gig: ProseGig): Promise<BriefResult<LogoBrief>> {
      const source = buildProseExtractionInput(gig);

      let response: Anthropic.Message;
      try {
        response = await deps.anthropic.messages.create({
          model: HAIKU_MODEL_ID,
          max_tokens: 256,
          // The brand name must come back byte-identical to the gig text.
          temperature: 0,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: source }],
        });
      } catch (err) {
        deps.recordSpend(0);
        return {
          ok: false,
          reason: `prose brief extraction failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      deps.recordSpend(extractionCostUsd(response.usage));

      const block = response.content.find((part) => part.type === 'text');
      if (!block || block.type !== 'text') {
        return { ok: false, reason: 'prose brief extraction returned no text block' };
      }
      const parsed = extractJsonObject(block.text);
      if (!parsed) {
        return { ok: false, reason: 'prose brief extraction did not return parseable JSON' };
      }

      // The declined case is a first-class answer, not a malformed one: the
      // system prompt asks for it by name, and it is the whole reason the model
      // has an alternative to guessing.
      const rawBrandName = parsed['brandName'];
      if (rawBrandName === null || rawBrandName === undefined) {
        return {
          ok: false,
          reason:
            'this gig does not clearly name a brand for the logo, and the extractor declined to ' +
            'guess one',
        };
      }
      if (typeof rawBrandName !== 'string') {
        return { ok: false, reason: 'prose brief extraction returned a non-string brandName' };
      }
      const rawIndustry = parsed['industry'];

      // THE ALLOW-LIST. Exactly two keys cross from the model into the brief;
      // everything else it emitted is dropped because it is never read.
      const candidate = {
        brandName: rawBrandName,
        industry: typeof rawIndustry === 'string' ? rawIndustry : '',
      };

      // THE SAME VALIDATION THE FENCED PATH APPLIES — non-blank fields and the
      // Latin-script v1 scope rule — by re-fencing the candidate through the
      // real parser rather than reimplementing its rules. A brand name that
      // itself contains a ``` fence breaks the round-trip and lands here as an
      // unparseable block, i.e. fails closed.
      const validated = parseLogoBrief(`\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``);
      if (!validated.ok) return validated;

      const brandName = validated.brief.brandName;
      if (!groundingForm(source).includes(groundingForm(brandName))) {
        return {
          ok: false,
          reason:
            `the extracted brand name "${brandName}" does not appear in the gig — refusing to ` +
            'build a logo around a name the buyer never wrote',
        };
      }
      return validated;
    },
  };
}
