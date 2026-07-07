// T5 "widget" — JiffyApp templates PRD T5, v1.0.0, $5. Frameable: the pipeline builds
// its worker script with `cspFor(ctx, { frameable: true })` for `def.id === 'widget'`
// (Task 19+); `render` itself never touches CSP.
//
// One variant per delivered tool (`faq | countdown | testimonials`), chosen at brief
// time — `items`' shape depends on the variant, so its full validation is cross-slot
// (variant + items together, like csv-dashboard's `crossSlotErrors`; each slot's own
// `validate` only sees its own value).
//
// Slot-kind note: `embedWidth`/`embedHeight` are buyer-declared pixel dimensions
// (100-2000). The engine's `kind: 'json'` check (`isJsonValue`) only accepts
// object/array values, and HTML `width`/`height` attributes are strings regardless —
// so these are declared `kind: 'copy'` holding a digit-only string (e.g. `"400"`),
// validated as an in-range integer by each slot's own `validate`, rather than widening
// the shared engine's JSON-kind check for one template's scalar need.
//
// `embed-snippet` is a readonly `<textarea>` whose *content* is the iframe HTML,
// `esc()`-ed as a whole so the browser shows it as copyable text instead of parsing it
// as a child `<iframe>` — the only template that escapes markup-as-content rather than
// buyer copy.
//
// `/app.js` is fully static (no marker injection): it reads `data-variant` off
// `widget-root` and `data-target` off `countdown` at runtime, so the same script
// serves all three variants without per-render templating.

import { briefErrorsForTemplate, MATCHER_KEYWORDS } from '../brief.js';
import type { FileSet, GoldenSet, JiffyBrief, SlotValues } from '../types.js';
import {
  esc,
  pageShell,
  SlotError,
  validateSlots,
  type RenderContext,
  type SlotSpec,
  type TemplateDefinition,
} from './engine.js';

const VARIANTS = ['faq', 'countdown', 'testimonials'] as const;
type WidgetVariant = (typeof VARIANTS)[number];

const VARIANT_TITLES: Record<WidgetVariant, string> = {
  faq: 'FAQ widget',
  countdown: 'Countdown widget',
  testimonials: 'Testimonials widget',
};

interface FaqItem {
  q: string;
  a: string;
}

interface CountdownItems {
  targetIso: string;
  label: string;
}

interface TestimonialItem {
  quote: string;
  author: string;
}

const DIMENSION_RE = /^[0-9]+$/;

function isWidgetVariant(value: unknown): value is WidgetVariant {
  return typeof value === 'string' && (VARIANTS as readonly string[]).includes(value);
}

function validateVariant(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return isWidgetVariant(value) ? [] : [`variant: must be one of ${VARIANTS.join('|')}`];
}

function validateDimension(name: string): (value: unknown) => string[] {
  return (value: unknown): string[] => {
    if (typeof value !== 'string' || !DIMENSION_RE.test(value)) {
      return [`${name}: must be an integer string, e.g. "400"`];
    }
    const n = Number(value);
    if (n < 100 || n > 2000) {
      return [`${name}: must be between 100 and 2000`];
    }
    return [];
  };
}

const SLOTS: SlotSpec[] = [
  {
    name: 'variant',
    kind: 'copy',
    required: true,
    description: 'Widget variant: one of "faq", "countdown", or "testimonials".',
    example: 'faq',
    validate: validateVariant,
  },
  {
    name: 'items',
    kind: 'json',
    required: true,
    description:
      'Shape depends on variant. faq: array of 1-12 `{ q: string; a: string }`. countdown: a ' +
      'single object `{ targetIso: string; label: string }` (targetIso is an ISO-8601 ' +
      'date-time). testimonials: array of 1-12 `{ quote: string; author: string }`.',
    example: [{ q: 'How does billing work?', a: 'Monthly, cancel anytime.' }],
  },
  {
    name: 'embedWidth',
    kind: 'copy',
    required: true,
    description:
      'Embed iframe width in pixels, as a digit-only string (e.g. "400"). Integer 100-2000.',
    example: '400',
    validate: validateDimension('embedWidth'),
  },
  {
    name: 'embedHeight',
    kind: 'copy',
    required: true,
    description:
      'Embed iframe height in pixels, as a digit-only string (e.g. "300"). Integer 100-2000.',
    example: '300',
    validate: validateDimension('embedHeight'),
  },
  {
    name: 'accentHex',
    kind: 'style',
    required: true,
    description: 'Brand accent color as a 6-digit hex code, e.g. #0F3D3E.',
    example: '#0F3D3E',
  },
];

/**
 * Cross-slot validation: `items`' shape depends on `variant`, which `items`' own
 * `validate` cannot see. Silent no-op when `variant` itself is invalid/absent —
 * that error is already reported by `variant`'s own validate/required check.
 */
function crossSlotErrors(slots: SlotValues): string[] {
  const variant = slots.variant;
  const items = slots.items;
  if (!isWidgetVariant(variant)) return [];
  if (items === undefined || items === null) return [];

  const errors: string[] = [];
  if (variant === 'faq') {
    if (!Array.isArray(items)) {
      errors.push('items: must be an array of { q, a } for variant "faq"');
    } else {
      if (items.length < 1 || items.length > 12) {
        errors.push('items: must have 1-12 entries for variant "faq"');
      }
      items.forEach((item, i) => {
        if (typeof item !== 'object' || item === null) {
          errors.push(`items[${i}]: must be an object`);
          return;
        }
        const { q, a } = item as Record<string, unknown>;
        if (typeof q !== 'string' || q.trim().length === 0) {
          errors.push(`items[${i}].q: required non-empty string`);
        }
        if (typeof a !== 'string' || a.trim().length === 0) {
          errors.push(`items[${i}].a: required non-empty string`);
        }
      });
    }
  } else if (variant === 'countdown') {
    if (typeof items !== 'object' || items === null || Array.isArray(items)) {
      errors.push('items: must be a single object { targetIso, label } for variant "countdown"');
    } else {
      const { targetIso, label } = items as Record<string, unknown>;
      if (typeof targetIso !== 'string' || !Number.isFinite(Date.parse(targetIso))) {
        errors.push('items.targetIso: must be a valid ISO-8601 date-time string');
      }
      if (typeof label !== 'string' || label.trim().length === 0) {
        errors.push('items.label: required non-empty string');
      }
    }
  } else {
    if (!Array.isArray(items)) {
      errors.push('items: must be an array of { quote, author } for variant "testimonials"');
    } else {
      if (items.length < 1 || items.length > 12) {
        errors.push('items: must have 1-12 entries for variant "testimonials"');
      }
      items.forEach((item, i) => {
        if (typeof item !== 'object' || item === null) {
          errors.push(`items[${i}]: must be an object`);
          return;
        }
        const { quote, author } = item as Record<string, unknown>;
        if (typeof quote !== 'string' || quote.trim().length === 0) {
          errors.push(`items[${i}].quote: required non-empty string`);
        }
        if (typeof author !== 'string' || author.trim().length === 0) {
          errors.push(`items[${i}].author: required non-empty string`);
        }
      });
    }
  }
  return errors;
}

function elementContract(slots: SlotValues): string[] {
  const base = ['widget-root', 'embed-snippet', 'footer'];
  const variant = slots.variant;
  if (variant === 'faq') return [...base, 'faq-item', 'faq-question', 'faq-answer'];
  if (variant === 'countdown') return [...base, 'countdown'];
  if (variant === 'testimonials') return [...base, 'testimonial-item'];
  return base;
}

function bindableTestids(slots: SlotValues): { exact: string[]; prefixes: string[] } {
  return { exact: elementContract(slots), prefixes: [] };
}

function briefErrors(brief: JiffyBrief): string[] {
  return briefErrorsForTemplate('widget', brief);
}

function buildStyles(accentHex: string): string {
  return `:root {
  --accent: ${accentHex};
  --text: #12181b;
  --muted: #45535a;
  --bg: #ffffff;
  --surface: #f4f6f5;
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--text);
  background: var(--bg);
  line-height: 1.5;
}
.widget { max-width: 560px; margin: 0 auto; padding: 2rem 1.5rem 3rem; }
.faq-list { display: grid; gap: 0.75rem; margin-bottom: 2rem; }
.faq-item { background: var(--surface); border-radius: 0.6rem; padding: 0.25rem 1rem; }
.faq-item button {
  font: inherit;
  font-weight: 600;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  padding: 0.75rem 0;
  cursor: pointer;
  color: var(--text);
}
.faq-item p { margin: 0 0 0.75rem; color: var(--muted); }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.countdown-widget { text-align: center; margin-bottom: 2rem; }
.countdown-label { color: var(--muted); margin: 0 0 0.5rem; }
[data-testid="countdown"] { font-size: 1.75rem; font-weight: 700; }
.testimonials-list { list-style: none; margin: 0 0 2rem; padding: 0; display: grid; gap: 1rem; }
.testimonials-list li { background: var(--surface); border-radius: 0.6rem; padding: 1rem 1.25rem; }
.testimonials-list blockquote { margin: 0 0 0.5rem; }
.testimonials-list cite { color: var(--muted); font-style: normal; font-size: 0.9rem; }
.embed { margin-top: 1.5rem; }
.embed label { display: block; font-weight: 600; margin-bottom: 0.4rem; }
.embed textarea {
  width: 100%;
  min-height: 6rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid #8a969b;
  border-radius: 0.4rem;
  background: var(--surface);
  color: var(--text);
  resize: vertical;
}
.jiffy-footer { text-align: center; padding: 2rem 1.5rem; color: var(--muted); font-size: 0.85rem; }
.jiffy-footer a { color: var(--muted); }
`;
}

const APP_JS = `'use strict';
const root = document.querySelector('[data-testid="widget-root"]');
const variant = root ? root.getAttribute('data-variant') : null;

if (variant === 'faq') {
  const questions = document.querySelectorAll('[data-testid="faq-question"]');
  const answers = document.querySelectorAll('[data-testid="faq-answer"]');
  questions.forEach((question, i) => {
    question.addEventListener('click', () => {
      const answer = answers[i];
      if (answer) answer.hidden = !answer.hidden;
    });
  });
} else if (variant === 'countdown') {
  const countdownEl = document.querySelector('[data-testid="countdown"]');
  if (countdownEl) {
    const targetMs = new Date(countdownEl.getAttribute('data-target')).getTime();
    const tick = () => {
      const diff = Math.max(0, targetMs - Date.now());
      const totalSeconds = Math.floor(diff / 1000);
      const d = Math.floor(totalSeconds / 86400);
      const h = Math.floor((totalSeconds % 86400) / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = totalSeconds % 60;
      countdownEl.textContent = d + 'd ' + h + 'h ' + m + 'm ' + s + 's';
    };
    tick();
    setInterval(tick, 1000);
  }
}
`;

function renderFaq(items: FaqItem[]): string {
  const itemsHtml = items
    .map(
      (item) => `
    <div data-testid="faq-item">
      <button type="button" data-testid="faq-question">${esc(item.q)}</button>
      <p data-testid="faq-answer" hidden>${esc(item.a)}</p>
    </div>`,
    )
    .join('');
  return `<section class="faq-list">${itemsHtml}
    </section>`;
}

function renderCountdown(items: CountdownItems): string {
  return `<section class="countdown-widget">
      <p class="countdown-label">${esc(items.label)}</p>
      <p data-testid="countdown" data-target="${esc(items.targetIso)}"></p>
    </section>`;
}

function renderTestimonials(items: TestimonialItem[]): string {
  const itemsHtml = items
    .map(
      (item) => `
      <li data-testid="testimonial-item">
        <blockquote>${esc(item.quote)}</blockquote>
        <cite>${esc(item.author)}</cite>
      </li>`,
    )
    .join('');
  return `<ul class="testimonials-list">${itemsHtml}
    </ul>`;
}

function render(slots: SlotValues, ctx: RenderContext): FileSet {
  const errors = [...validateSlots(WIDGET, slots), ...crossSlotErrors(slots)];
  if (errors.length > 0) throw new SlotError(errors);

  const variant = slots.variant as WidgetVariant;
  const items = slots.items;
  const embedWidth = slots.embedWidth as string;
  const embedHeight = slots.embedHeight as string;
  const accentHex = slots.accentHex as string;
  const variantTitle = VARIANT_TITLES[variant];

  let variantHtml: string;
  if (variant === 'faq') {
    variantHtml = renderFaq(items as FaqItem[]);
  } else if (variant === 'countdown') {
    variantHtml = renderCountdown(items as CountdownItems);
  } else {
    variantHtml = renderTestimonials(items as TestimonialItem[]);
  }

  const iframeSnippet = `<iframe src="${ctx.toolUrl}" width="${embedWidth}" height="${embedHeight}" loading="lazy" title="${variantTitle}"></iframe>`;

  const body = `<main class="widget" data-testid="widget-root" data-variant="${esc(variant)}">
  ${variantHtml}
  <section class="embed">
    <label for="jiffy-embed-snippet">Embed this widget</label>
    <textarea readonly data-testid="embed-snippet" id="jiffy-embed-snippet">${esc(iframeSnippet)}</textarea>
  </section>
</main>
<script src="/app.js"></script>`;

  const html = pageShell({ title: variantTitle, body, ctx });
  const css = buildStyles(accentHex);

  return {
    '/index.html': { content: html, contentType: 'text/html; charset=utf-8' },
    '/styles.css': { content: css, contentType: 'text/css; charset=utf-8' },
    '/app.js': { content: APP_JS, contentType: 'text/javascript; charset=utf-8' },
  };
}

const referenceBrief: JiffyBrief = {
  template: 'widget',
  name: 'Support FAQ widget',
  description:
    'Embeddable FAQ accordion widget for a product support page: three common questions, ' +
    'collapsed by default, expanding on click. Embedded via an iframe snippet.',
  copy: {},
  brand: { accentHex: '#1f2933' },
};

const referenceSlots: SlotValues = {
  variant: 'faq',
  items: [
    { q: 'How do I reset my password?', a: 'Use the "Forgot password" link on the sign-in page.' },
    { q: 'Do you offer refunds?', a: 'Yes, within 30 days of purchase, no questions asked.' },
    { q: 'Is there a free plan?', a: 'Yes — the Free plan supports up to 3 projects.' },
  ],
  embedWidth: '400',
  embedHeight: '300',
  accentHex: '#1f2933',
};

const referenceGoldens: GoldenSet = {
  goldens: [
    {
      title: 'Three FAQ items render',
      steps: [],
      expect: [{ testid: 'faq-item', count: 3 }],
    },
    {
      title: 'Clicking a question reveals its answer',
      steps: [{ do: 'click', testid: 'faq-question', nth: 1 }],
      expect: [{ testid: 'faq-answer', nth: 1, visible: true }],
    },
    {
      title: 'Embed snippet contains the tool URL',
      steps: [],
      expect: [{ testid: 'embed-snippet', contains: 'https://reference.jiffyapp.dev' }],
    },
    {
      title: 'Answers are collapsed on load',
      steps: [],
      expect: [{ testid: 'faq-answer', nth: 0, hidden: true }],
    },
  ],
};

export const WIDGET: TemplateDefinition = {
  id: 'widget',
  version: '1.0.0',
  priceUsd: 5,
  matcherKeywords: MATCHER_KEYWORDS.widget,
  elementContract,
  bindableTestids,
  slots: SLOTS,
  briefErrors,
  render,
  goldenGuidance:
    'faq: `count(faq-item)`, `click(faq-question, nth)` ⇒ `visible(faq-answer, nth)`, and a ' +
    'load golden asserting the first answer is `hidden`. countdown: `attrEquals` on ' +
    "`countdown`'s `data-target` (never the ticking text). testimonials: `count(testimonial-" +
    'item)`. Every variant: `contains(embed-snippet, <tool URL>)`.',
  referenceBrief,
  referenceSlots,
  referenceGoldens,
};
