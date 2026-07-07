// Haiku golden compiler (templates PRD §1.4/§8): turns a validated `JiffyBrief` into a
// `GoldenSet` the buyer will accept as the ONLY acceptance criteria for the build (§12).
// The model is forced (tool_choice) to call `report_golden_examples` so its output is
// structured JSON, never prose; `validateGoldenSet` (Task 9) is the real gate — the tool
// schema only gets the shape close enough that validation has something sane to check.
// One retry is allowed, feeding the validation errors back as a hard constraint; if the
// retry is still invalid the caller (proposer.ts) skips the gig rather than propose
// against goldens nobody validated.
//
// System prompt is template-agnostic and prompt-cached (repo convention); everything
// template- and brief-specific rides the user message. Every call reports its real
// token cost at pinned Haiku pricing (usageCostUsd copied from VoiceWright's
// generate.ts — same shape, same math, kept local so this module has no cross-app
// dependency).

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { BindableSurface } from './goldens.js';
import { validateGoldenSet } from './goldens.js';
import { HAIKU_MODEL_ID, HAIKU_PRICING_PER_MTOK } from './config.js';
import type { TemplateDefinition } from './templates/engine.js';
import type { GoldenSet, JiffyBrief, TemplateId } from './types.js';

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

// ---- proposal-time bindable surface (no slots exist yet — see task brief BINDING RESOLUTION) ----
//
// `TemplateDefinition.bindableTestids(slots)` needs real slot values, which don't exist
// until codegen (post-acceptance). At proposal time we only have the brief. For templates
// whose census is partly slot-derived (calculator `input-<name>`, form `field-<name>`,
// csv-dashboard `summary-<key>`/`chart-<n>`, link-in-bio `social-<network>`, pricing-table
// `feature-<key>-<planSlug>`/`plan*`), the reference brief's derived ids don't cover an
// arbitrary buyer's field names. `proposalBindable` widens the reference surface with a
// per-template prefix so the compiler (and validateGoldenSet) admit goldens for names that
// differ from the reference while still bounding assertions to the template's shape. This
// is deliberately loose — a real per-instance census re-validates at build time once slots
// exist (Task 17); tightening this further before then isn't this task's concern.
export const PER_TEMPLATE_DYNAMIC_PREFIXES: Record<TemplateId, string[]> = {
  landing: [],
  calculator: ['input-'],
  form: ['field-'],
  'csv-dashboard': ['summary-', 'chart-'],
  widget: [],
  'link-in-bio': ['social-'],
  'pricing-table': ['feature-', 'plan'],
  quiz: [],
  waitlist: [],
  transformer: [],
};

/** Human-readable naming-rule fragment for the templates whose bindable surface was
 *  widened above — told to the model so it knows the pattern to follow, not just that
 *  the prefix is "allowed". Templates with no dynamic prefix need no naming rule. */
const NAMING_RULES: Partial<Record<TemplateId, string>> = {
  calculator:
    "Input testids are `input-<name>` where <name> is each input's `name` from THIS brief " +
    "(not the reference brief's input names) — read the brief's `inputs` array.",
  form: "Field testids are `field-<name>` where <name> is each field's `name` from THIS brief.",
  'csv-dashboard':
    "Summary testids are `summary-<key>` (per this brief's declared aggregates) and chart " +
    'testids are `chart-<n>`, 1-indexed in the order this brief declares charts.',
  'link-in-bio': 'Social link testids are `social-<network>` where <network> is from THIS brief.',
  'pricing-table':
    "Every plan card carries testid `plan` (bind by `nth`, in the brief's plan order); price " +
    'and CTA elements are `plan-price`/`plan-cta` (also by `nth`); feature cells are ' +
    '`feature-<key>-<planSlug>` where <key> is the feature row key and <planSlug> is the ' +
    'normalized (lowercase, hyphenated) plan name, both from THIS brief.',
};

/**
 * Proposal-time bindable surface for a template: the reference surface's exact ids widened
 * with this template's dynamic-testid prefixes. `brief` isn't consulted (the surface is
 * template-shaped, not brief-shaped) but stays in the signature — proposer.ts calls this
 * per-gig with the classified brief in hand, and a future tightened implementation may want it.
 */
export function proposalBindable(def: TemplateDefinition, brief: JiffyBrief): BindableSurface {
  void brief;
  const reference = def.bindableTestids(def.referenceSlots);
  return {
    exact: reference.exact,
    prefixes: [...reference.prefixes, ...PER_TEMPLATE_DYNAMIC_PREFIXES[def.id]],
  };
}

// ---- compiler ----

export interface GoldenCompiler {
  compile(
    brief: JiffyBrief,
    def: TemplateDefinition,
    bindable: BindableSurface,
  ): Promise<
    { ok: true; set: GoldenSet; costUsd: number } | { ok: false; errors: string[]; costUsd: number }
  >;
}

export interface GoldenCompilerConfig {
  apiKey: string;
  logger: Logger;
  /** Injectable for tests — never call the live API from a test. */
  fetchImpl?: typeof fetch;
}

const GOLDEN_SET_TOOL: Anthropic.Tool = {
  name: 'report_golden_examples',
  description:
    'Report the golden (acceptance) examples for this tool build, in canonical form. These ' +
    'are the ONLY assertions that will run against the live tool — the buyer accepts the ' +
    'build if, and only if, every one of them passes.',
  input_schema: {
    type: 'object',
    properties: {
      goldens: {
        type: 'array',
        description: "3-7 golden examples covering the brief's described behavior.",
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short human-readable label for this golden.' },
            steps: {
              type: 'array',
              description:
                'Ordered interaction steps run before the assertions below. May be an empty ' +
                'array for a page-load-only golden.',
              items: {
                type: 'object',
                properties: {
                  do: {
                    type: 'string',
                    enum: ['load', 'fill', 'select', 'click', 'paste', 'upload'],
                  },
                  fields: {
                    type: 'object',
                    description:
                      '"fill"/"select" only: testid -> value. "fill" values are strings, or ' +
                      'booleans for checkboxes. "select" values are the option string.',
                  },
                  testid: { type: 'string', description: '"click"/"paste"/"upload" only.' },
                  nth: { type: 'number', description: '"click" only: optional 0-based index.' },
                  text: {
                    type: 'string',
                    description: '"paste" only: literal text (exactly one of text|fixture).',
                  },
                  fixture: {
                    type: 'string',
                    description: '"paste"/"upload" only: key into the top-level "fixtures" object.',
                  },
                },
                required: ['do'],
              },
            },
            expect: {
              type: 'array',
              description: 'Assertions checked once the steps above have run.',
              items: {
                type: 'object',
                properties: {
                  testid: { type: 'string' },
                  nth: { type: 'number' },
                  equals: { type: 'string' },
                  contains: { type: 'string' },
                  count: { type: 'number' },
                  visible: { type: 'boolean' },
                  hidden: { type: 'boolean' },
                  hrefEquals: { type: 'string' },
                  hrefStartsWith: { type: 'string' },
                  attrEquals: {
                    type: 'object',
                    properties: { attr: { type: 'string' }, value: { type: 'string' } },
                  },
                  titleEquals: { type: 'string' },
                  metaEquals: {
                    type: 'object',
                    properties: { property: { type: 'string' }, value: { type: 'string' } },
                  },
                },
              },
            },
          },
          required: ['steps', 'expect'],
        },
      },
      fixtures: {
        type: 'object',
        description:
          'Optional named fixture content strings (e.g. golden CSV text) referenced by ' +
          'paste/upload steps via their "fixture" key.',
      },
    },
    required: ['goldens'],
  },
};

const SYSTEM_PROMPT = `You are the golden-example compiler for JiffyApp, a bot that builds small web tools on the BotGuild marketplace and hands buyers a fixed set of browser-automatable "golden examples" as the complete, immutable acceptance criteria for delivery.

You call the report_golden_examples tool with 3-7 golden examples per tool. Every example is later executed literally, in a real headless browser, against the built page — so it must be mechanically precise, not a paraphrase of what the page will show.

Hard rules, no exceptions:
- Every string you assert (equals/contains/hrefEquals/hrefStartsWith/titleEquals/metaEquals/attrEquals values) must be the EXACT string the tool will actually render — exact casing, punctuation, and whitespace. Never approximate.
- Currency and other formatted numbers must be asserted in their exact rendered form (e.g. "$1,800.00", not "1800" or "$1800").
- NEVER assert a value that changes with wall-clock time (a ticking countdown, "time remaining", a live clock). If a countdown or timer exists, assert a stable underlying attribute (e.g. a data-* target timestamp) instead of the rendered, changing text.
- Drive a <select> input with a "select" step (fields: testid -> option string), never with "fill" — "fill" is for text/number inputs and checkboxes only.
- Drive a checkbox with a boolean value inside a "fill" step's fields (true/false), never a string.
- Every testid you reference (in steps or expectations) must be one this specific template can actually render for this specific brief — stick to the bindable testids you are given; do not invent ids.
- Titles must be unique and describe what the golden proves, not "Test 1".
- Where the template affords a failure/edge path (invalid input, empty required field, mismatched data), include at least one golden that exercises it — a tool that only ever proves the happy path is under-specified.
- Prefer one load-only golden (empty steps) when the template has static, load-time content worth pinning (a headline, a title, meta tags) — but do not pad the set with redundant load-only goldens once one exists.

Always call report_golden_examples. Never respond with prose.`;

function buildUserPrompt(
  brief: JiffyBrief,
  def: TemplateDefinition,
  bindable: BindableSurface,
): string {
  const namingRule = NAMING_RULES[def.id];
  const sections = [
    def.goldenGuidance,
    `Bindable testids: exact [${bindable.exact.join(', ')}], prefixes [${bindable.prefixes.join(', ')}]`,
  ];
  if (namingRule) sections.push(`Naming rules: ${namingRule}`);
  sections.push(`Brief:\n\`\`\`json\n${JSON.stringify(brief, null, 2)}\n\`\`\``);
  return sections.join('\n\n');
}

export function createGoldenCompiler(config: GoldenCompilerConfig): GoldenCompiler {
  const anthropic = new Anthropic({
    apiKey: config.apiKey,
    ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
  });

  async function callHaiku(userText: string): Promise<{ toolInput: unknown; costUsd: number }> {
    const response = await anthropic.messages.create({
      model: HAIKU_MODEL_ID,
      max_tokens: 2000,
      tools: [GOLDEN_SET_TOOL],
      tool_choice: { type: 'tool', name: GOLDEN_SET_TOOL.name },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userText }],
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
      'golden compiler haiku call complete',
    );

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === 'tool_use' && block.name === GOLDEN_SET_TOOL.name,
    );
    if (!toolUse) throw new Error('model did not call report_golden_examples');
    return { toolInput: toolUse.input, costUsd };
  }

  return {
    async compile(brief, def, bindable) {
      const userPrompt = buildUserPrompt(brief, def, bindable);
      let costUsd = 0;

      let firstInput: unknown;
      try {
        const first = await callHaiku(userPrompt);
        firstInput = first.toolInput;
        costUsd += first.costUsd;
      } catch (err) {
        config.logger.warn({ err, templateId: def.id }, 'golden compiler: first call failed');
        return { ok: false, errors: [`model call failed: ${(err as Error).message}`], costUsd };
      }

      const firstResult = validateGoldenSet(firstInput, bindable);
      if (firstResult.ok) {
        return { ok: true, set: firstResult.set, costUsd };
      }

      config.logger.info(
        { templateId: def.id, errors: firstResult.errors },
        'golden compiler: first attempt invalid, retrying once',
      );

      const retryPrompt = `${userPrompt}\n\nYour previous attempt failed validation: ${firstResult.errors.join('; ')}. Emit a corrected set that fixes every one of these problems.`;

      let retryInput: unknown;
      try {
        const retry = await callHaiku(retryPrompt);
        retryInput = retry.toolInput;
        costUsd += retry.costUsd;
      } catch (err) {
        config.logger.warn({ err, templateId: def.id }, 'golden compiler: retry call failed');
        return {
          ok: false,
          errors: [...firstResult.errors, `retry failed: ${(err as Error).message}`],
          costUsd,
        };
      }

      const retryResult = validateGoldenSet(retryInput, bindable);
      if (retryResult.ok) {
        return { ok: true, set: retryResult.set, costUsd };
      }

      config.logger.warn(
        { templateId: def.id, errors: retryResult.errors },
        'golden compiler: retry still invalid, giving up',
      );
      return { ok: false, errors: retryResult.errors, costUsd };
    },
  };
}
