// Codegen (templates PRD FR-4/FR-6): turns a validated `JiffyBrief` + compiled `GoldenSet` into
// slot values for a `TemplateDefinition`. Round 0 is a full generation; repair rounds (>=1) feed
// back the prior attempt's slots and the pipeline's validation failures so the model narrows in
// rather than starting over. This module owns exactly ONE model call per round (plus at most one
// fallback try) — it never retries internally; the build pipeline's repair-round loop (Task 17,
// bounded by MAX_REPAIR_ROUNDS) is the retry budget, and the final round may set `escalate: true`
// to hand the same prompt to Haiku instead of Workers AI Qwen (FR-6).
//
// Qwen runs through the Workers AI binding (`AiLike`, a structural view of `env.AI` so tests can
// fake it) and costs a flat `CODEGEN_COST_PER_CALL_USD` per call — Workers AI doesn't return
// token-level usage the way the Anthropic API does, so the ledger uses a conservative constant.
// Haiku escalation goes through `@anthropic-ai/sdk` with the same prompt-caching pattern as the
// golden compiler (`goldenCompiler.ts`) and real usage-based cost (`usageCostUsd`, reused from
// there rather than re-derived here).
//
// Workers AI response shapes vary by model/catalog entry (`{ response: string }` for most text
// models, an OpenAI-ish `{ choices: [{ message: { content } }] }` for some) — `extractText`
// tolerates both plus a bare string, and returns '' for anything else so callers can detect the
// long-context/empty-response failure mode (FR-4) without throwing.
//
// This module never throws out of `generate()` — every failure path (model error, empty
// response, JSON parse failure, slot validation failure) returns `{ ok: false, errors, costUsd,
// model }` so the caller always gets a ledger-accountable result.

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import { parseClaudeJson } from '@botguild/agent-core';
import {
  CODEGEN_COST_PER_CALL_USD,
  CODEGEN_FALLBACK_MODEL_ID,
  CODEGEN_MODEL_ID,
  HAIKU_MODEL_ID,
} from './config.js';
import { usageCostUsd } from './goldenCompiler.js';
import { validateSlots, type TemplateDefinition } from './templates/engine.js';
import type { GoldenSet, JiffyBrief, SlotValues } from './types.js';

/** Structural view of the Workers AI binding — index.ts passes env.AI; tests pass a fake. */
export interface AiLike {
  run(
    model: string,
    options: { messages: Array<{ role: string; content: string }>; max_tokens?: number },
  ): Promise<unknown>;
}

export interface CodegenResult {
  ok: boolean;
  slots?: SlotValues;
  errors?: string[]; // slot-validation errors (or model-error message) when !ok
  costUsd: number; // deterministic ledger contribution for this call
  model: string; // model id actually used (evidence report)
}

export interface CodegenArgs {
  def: TemplateDefinition;
  brief: JiffyBrief;
  goldens: GoldenSet;
  priorSlots?: SlotValues; // round >= 1 (repair)
  failures?: string[]; // round >= 1 (repair) — the prior round's validateSlots errors
  escalate?: boolean; // final-round Haiku escalation (FR-6)
  instruction?: string; // edit jobs (Task 22): threads an edit instruction into the prompt
}

export interface Codegen {
  /** round 0 = full generation; rounds >= 1 = repair (prior slots + failure feedback). */
  generate(args: CodegenArgs): Promise<CodegenResult>;
}

export interface CodegenConfig {
  ai: AiLike;
  anthropicApiKey: string;
  logger: Logger;
  /** Injectable for tests — never call the live Anthropic API from a test. */
  fetchImpl?: typeof fetch;
  /**
   * Overrides `CODEGEN_FALLBACK_MODEL_ID` — test-only escape hatch so the dark
   * long-context-fallback engagement path (FR-4) is exercisable before the catalog id is
   * verified and flipped on in config.ts (see the recorded decision in config.ts). Production
   * callers omit this and get the real config constant ('' = disabled in v1).
   */
  fallbackModelId?: string;
}

const HARD_RULES =
  'Respond with ONLY a JSON object mapping slot names to values. Copy slots are plain strings. ' +
  'Function slots are JS source strings for PURE functions — no DOM, no network, no globals, no ' +
  'imports. You are filling slots in a fixed template; you cannot add files, scripts, or structure.';

function slotTable(def: TemplateDefinition): string {
  const rows = def.slots.map((spec) => {
    const requiredness = spec.required ? 'required' : 'optional';
    return `- ${spec.name} (${spec.kind}, ${requiredness}): ${spec.description} Example: ${JSON.stringify(spec.example)}`;
  });
  return `Slots to fill:\n${rows.join('\n')}`;
}

function goldenSection(goldens: GoldenSet): string {
  return (
    'Golden examples: the generated values MUST make every golden pass exactly — match ' +
    'formatted strings character-for-character; testids referenced by goldens dictate your ' +
    `slot names (e.g. input-<name> fields):\n${JSON.stringify(goldens, null, 2)}`
  );
}

/** Builds the { system, user } prompt pair. Exported for direct assertion in tests. */
export function buildCodegenPrompt(args: {
  def: TemplateDefinition;
  brief: JiffyBrief;
  goldens: GoldenSet;
  priorSlots?: SlotValues;
  failures?: string[];
  instruction?: string;
}): { system: string; user: string } {
  const { def, brief, goldens, priorSlots, failures, instruction } = args;

  const system = [slotTable(def), HARD_RULES, goldenSection(goldens)].join('\n\n');

  const userParts = [`Brief:\n${JSON.stringify(brief, null, 2)}`];

  if (instruction) {
    userParts.push(`EDIT INSTRUCTION (change only what this requires): ${instruction}`);
  }

  const isRepair = priorSlots !== undefined || (failures !== undefined && failures.length > 0);
  if (isRepair) {
    if (priorSlots !== undefined) {
      userParts.push(`Prior slots:\n${JSON.stringify(priorSlots, null, 2)}`);
    }
    if (failures !== undefined && failures.length > 0) {
      userParts.push(
        `Failures from the prior attempt:\n${failures.map((f) => `- ${f}`).join('\n')}`,
      );
    }
    userParts.push('change only what is needed to fix these failures');
  }

  return { system, user: userParts.join('\n\n') };
}

/** Tolerant Workers AI response-shape normalizer. Exported for tests. */
export function extractText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.response === 'string') return obj.response;
    if (Array.isArray(obj.choices)) {
      const first = obj.choices[0];
      if (first && typeof first === 'object') {
        const message = (first as Record<string, unknown>).message;
        if (message && typeof message === 'object') {
          const content = (message as Record<string, unknown>).content;
          if (typeof content === 'string') return content;
        }
      }
    }
  }
  return '';
}

/** JSON.parse in place any `json`-kind slot that arrived as a JSON string; leave unparseable
 *  values as-is so validateSlots rejects them with a clear error (never throws here). */
function normalizeJsonSlots(def: TemplateDefinition, slots: SlotValues): SlotValues {
  const out: SlotValues = { ...slots };
  for (const spec of def.slots) {
    if (spec.kind !== 'json') continue;
    const value = out[spec.name];
    if (typeof value !== 'string') continue;
    try {
      out[spec.name] = JSON.parse(value);
    } catch {
      // leave the string in place; validateSlots will reject it with a clear error
    }
  }
  return out;
}

function parseAndValidate(
  text: string,
  def: TemplateDefinition,
  model: string,
  costUsd: number,
): CodegenResult {
  let parsed: SlotValues;
  try {
    parsed = parseClaudeJson<SlotValues>(text);
  } catch (err) {
    return { ok: false, errors: [`model error: ${(err as Error).message}`], costUsd, model };
  }

  const normalized = normalizeJsonSlots(def, parsed);
  const errors = validateSlots(def, normalized);
  if (errors.length > 0) {
    return { ok: false, errors, costUsd, model };
  }
  return { ok: true, slots: normalized, costUsd, model };
}

export function createCodegen(config: CodegenConfig): Codegen {
  const anthropic = new Anthropic({
    apiKey: config.anthropicApiKey,
    ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
  });
  const fallbackModelId = config.fallbackModelId ?? CODEGEN_FALLBACK_MODEL_ID;

  async function runAi(model: string, prompt: { system: string; user: string }): Promise<string> {
    const raw = await config.ai.run(model, {
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      max_tokens: 4000,
    });
    return extractText(raw);
  }

  async function generateViaQwen(
    def: TemplateDefinition,
    prompt: { system: string; user: string },
  ): Promise<CodegenResult> {
    let calls = 0;
    let text = '';
    let model = CODEGEN_MODEL_ID;
    let errorMessage: string | undefined;

    calls += 1;
    try {
      text = await runAi(CODEGEN_MODEL_ID, prompt);
    } catch (err) {
      errorMessage = (err as Error).message;
    }

    const primaryFailed = errorMessage !== undefined || text.trim().length === 0;

    if (primaryFailed) {
      config.logger.warn(
        { model: CODEGEN_MODEL_ID, empty: errorMessage === undefined, err: errorMessage },
        'codegen: primary Workers AI call failed or returned empty text',
      );

      if (!fallbackModelId) {
        const message = errorMessage ?? 'empty response from model';
        return {
          ok: false,
          errors: [`model error: ${message}`],
          costUsd: calls * CODEGEN_COST_PER_CALL_USD,
          model: CODEGEN_MODEL_ID,
        };
      }

      model = fallbackModelId;
      errorMessage = undefined;
      calls += 1;
      try {
        text = await runAi(fallbackModelId, prompt);
      } catch (err) {
        errorMessage = (err as Error).message;
      }

      const fallbackFailed = errorMessage !== undefined || text.trim().length === 0;
      if (fallbackFailed) {
        config.logger.warn(
          { model, empty: errorMessage === undefined, err: errorMessage },
          'codegen: fallback Workers AI call also failed or returned empty text',
        );
        const message = errorMessage ?? 'empty response from model';
        return {
          ok: false,
          errors: [`model error: ${message}`],
          costUsd: calls * CODEGEN_COST_PER_CALL_USD,
          model,
        };
      }
    }

    return parseAndValidate(text, def, model, calls * CODEGEN_COST_PER_CALL_USD);
  }

  async function generateViaHaiku(
    def: TemplateDefinition,
    prompt: { system: string; user: string },
  ): Promise<CodegenResult> {
    try {
      const response = await anthropic.messages.create({
        model: HAIKU_MODEL_ID,
        max_tokens: 4000,
        system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: prompt.user }],
      });

      const costUsd = usageCostUsd(response.usage);
      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text',
      );
      const text = textBlock?.text ?? '';

      config.logger.info(
        {
          model: HAIKU_MODEL_ID,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          costUsd,
        },
        'codegen: haiku escalation call complete',
      );

      return parseAndValidate(text, def, HAIKU_MODEL_ID, costUsd);
    } catch (err) {
      config.logger.warn({ err }, 'codegen: haiku escalation call failed');
      return {
        ok: false,
        errors: [`model error: ${(err as Error).message}`],
        costUsd: 0,
        model: HAIKU_MODEL_ID,
      };
    }
  }

  return {
    async generate(args) {
      const { def, brief, goldens, priorSlots, failures, escalate, instruction } = args;
      const prompt = buildCodegenPrompt({ def, brief, goldens, priorSlots, failures, instruction });

      if (escalate) {
        return generateViaHaiku(def, prompt);
      }
      return generateViaQwen(def, prompt);
    },
  };
}
