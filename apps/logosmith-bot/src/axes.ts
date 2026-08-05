// Style-axis compilation (FR-3). Haiku turns the brief into three prompts on
// three DECLARED, distinct axes. The axis ids persist to D1 and feed the
// distinctness gate — which is why the model is never allowed to choose the
// axis set or the vendor routing: it writes the prompt text, we own the
// taxonomy. A model that renamed the axes could satisfy "three distinct axis
// labels" while producing three identical lockups.

import Anthropic from '@anthropic-ai/sdk';
import { HAIKU_MODEL_ID } from './config.js';
import type { LogoBrief, StyleAxis } from './types.js';

/** The fixed v1 axis taxonomy and its vendor routing (FR-4). */
export const DEFAULT_AXES: readonly StyleAxis[] = [
  {
    id: 'wordmark',
    label: 'lettering-forward wordmark',
    prompt: '',
    vendor: 'ideogram',
  },
  {
    id: 'lockup',
    label: 'icon + wordmark lockup',
    prompt: '',
    vendor: 'ideogram',
  },
  {
    id: 'emblem',
    label: 'emblem / monogram',
    prompt: '',
    vendor: 'recraft',
  },
] as const;

/** The deterministic prompt used as the fallback and as the model's template. */
export function buildAxisPrompt(brief: LogoBrief, axis: StyleAxis): string {
  const parts = [
    `A professional ${axis.label} logo for "${brief.brandName}", a ${brief.industry}.`,
    'The brand name must be rendered as clean, correctly spelled, legible lettering.',
  ];
  if (brief.brief) parts.push(`Style direction: ${brief.brief}.`);
  if (brief.palettePreference?.length) {
    parts.push(`Preferred colours: ${brief.palettePreference.join(', ')}.`);
  }
  if (brief.avoid?.length) parts.push(`Avoid: ${brief.avoid.join(', ')}.`);
  parts.push('Flat vector style, plain background, no photographic texture, no mockup.');
  return parts.join(' ');
}

export interface AxisCompiler {
  compile(brief: LogoBrief): Promise<StyleAxis[]>;
}

// MEASURED 2026-07-30: this system prompt plus a representative user message is
// 143 tokens. Haiku 4.5's minimum cacheable prefix is 4096, so the
// `cache_control` marker below is a NO-OP — two identical live calls each
// returned cache_creation_input_tokens: 0 and cache_read_input_tokens: 0, with
// no error. The marker is kept (it is free, and becomes live if the prompt
// grows past the floor or the model changes) but prompt caching is NOT a cost
// control on this call. See the verified-live note under this task.
const SYSTEM_PROMPT =
  'You write image-generation prompts for logo design. You will be given a brand brief and three ' +
  'fixed style axes. Return ONLY JSON of the shape {"axes":[{"id":"...","label":"...","prompt":"..."}]} ' +
  'with exactly one entry per supplied axis id, preserving the ids. Each prompt must contain the ' +
  'brand name verbatim and must describe a visually distinct composition from the other two.';

export function createAxisCompiler(deps: {
  anthropic: Anthropic;
  axes?: readonly StyleAxis[];
}): AxisCompiler {
  const axes = deps.axes ?? DEFAULT_AXES;

  return {
    async compile(brief) {
      // The deterministic prompts are both the fallback and the floor: if the
      // model adds nothing usable, the job still runs.
      const fallback = axes.map((axis) => ({ ...axis, prompt: buildAxisPrompt(brief, axis) }));

      try {
        const response = await deps.anthropic.messages.create({
          model: HAIKU_MODEL_ID,
          max_tokens: 1024,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [
            {
              role: 'user',
              content: JSON.stringify({
                brief,
                axes: axes.map((a) => ({ id: a.id, label: a.label })),
                baseline: fallback.map((a) => ({ id: a.id, prompt: a.prompt })),
              }),
            },
          ],
        });

        const text = response.content.find((block) => block.type === 'text');
        if (!text || text.type !== 'text') return fallback;
        const parsed = JSON.parse(text.text) as {
          axes?: Array<{ id?: string; label?: string; prompt?: string }>;
        };
        if (!Array.isArray(parsed.axes)) return fallback;

        // Vendor routing and axis ids are ours, not the model's.
        const compiled = axes.map((axis) => {
          const match = parsed.axes!.find((a) => a.id === axis.id);
          const prompt =
            typeof match?.prompt === 'string' && match.prompt.includes(brief.brandName)
              ? match.prompt
              : buildAxisPrompt(brief, axis);
          return { ...axis, label: match?.label ?? axis.label, prompt };
        });
        return compiled;
      } catch {
        return fallback;
      }
    },
  };
}
