// T10 "transformer" — JiffyApp templates PRD T10, v1.0.0, $15.
//
// Paste text in, get transformed text out: a buyer-declared pure `transform`
// function (`(input: string) => string`, may throw) runs client-side against the
// `input` textarea's value. Like calculator's `compute`, `transform` is injected
// into a static `/app.js` source by string-replacing a comment marker via a
// function replacer, never via an inline `<script>` tag (`script-src 'self'`
// forbids that across the whole catalog) and never via plain-string `.replace`
// (injected source can contain literal `$`-prefixed sequences that `.replace`
// would otherwise treat as special patterns).

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

const SLOTS: SlotSpec[] = [
  {
    name: 'headline',
    kind: 'copy',
    required: true,
    description: 'Page headline / title, e.g. "JSON Pretty-Printer".',
    example: 'JSON Pretty-Printer',
  },
  {
    name: 'inputLabel',
    kind: 'copy',
    required: true,
    description: 'Label above the input textarea.',
    example: 'Paste your JSON',
  },
  {
    name: 'outputLabel',
    kind: 'copy',
    required: true,
    description: 'Label above the output textarea.',
    example: 'Formatted result',
  },
  {
    name: 'placeholder',
    kind: 'copy',
    required: true,
    description: 'Placeholder text shown in the empty input textarea.',
    example: '{"example": true}',
  },
  {
    name: 'transform',
    kind: 'function',
    required: true,
    description:
      'Pure function `(input: string) => string`. Runs against the raw `input` textarea value ' +
      'and its return value is written verbatim into the `output` textarea. May throw for ' +
      'invalid input — the thrown error is caught and shown as `error-msg`; the function must ' +
      'not touch the network, storage, or the DOM.',
    example: '(input) => input.trim()',
  },
  {
    name: 'accentHex',
    kind: 'style',
    required: true,
    description: 'Brand accent color as a 6-digit hex code, e.g. #0F3D3E.',
    example: '#0F3D3E',
  },
];

const TRANSFORMER_TESTIDS = [
  'input',
  'transform-submit',
  'output',
  'copy-btn',
  'error-msg',
  'footer',
];

function elementContract(_slots: SlotValues): string[] {
  return [...TRANSFORMER_TESTIDS];
}

function bindableTestids(slots: SlotValues): { exact: string[]; prefixes: string[] } {
  return { exact: elementContract(slots), prefixes: [] };
}

function briefErrors(brief: JiffyBrief): string[] {
  return briefErrorsForTemplate('transformer', brief);
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
.transformer { max-width: 720px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
h1 { font-size: clamp(1.5rem, 3vw, 2.25rem); margin: 0 0 1.5rem; }
label { display: grid; gap: 0.4rem; font-weight: 600; margin-bottom: 1.25rem; }
textarea {
  font: inherit;
  padding: 0.6rem 0.75rem;
  border: 1px solid #8a969b;
  border-radius: 0.4rem;
  background: #fff;
  color: var(--text);
  min-height: 10rem;
  resize: vertical;
}
textarea[readonly] { background: var(--surface); }
.actions { display: flex; gap: 0.75rem; margin-bottom: 1.25rem; }
button { font: inherit; font-weight: 600; padding: 0.7rem 1.4rem; border-radius: 0.5rem; border: none; cursor: pointer; }
button[data-testid="transform-submit"] { background: var(--accent); color: #fff; }
button[data-testid="copy-btn"] { background: transparent; color: var(--text); border: 1px solid #8a969b; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
[data-testid="error-msg"] { color: #9b1c1c; margin-top: -0.5rem; margin-bottom: 1.25rem; }
.jiffy-footer { text-align: center; padding: 2rem 1.5rem; color: var(--muted); font-size: 0.85rem; }
.jiffy-footer a { color: var(--muted); }
`;
}

const APP_JS_TEMPLATE = `'use strict';
const transform = /*__TRANSFORM_FN__*/;

const inputEl = document.querySelector('[data-testid="input"]');
const outputEl = document.querySelector('[data-testid="output"]');
const errorEl = document.querySelector('[data-testid="error-msg"]');

document.querySelector('[data-testid="transform-submit"]').addEventListener('click', () => {
  try {
    outputEl.value = transform(inputEl.value);
    errorEl.hidden = true;
    errorEl.textContent = '';
  } catch (e) {
    errorEl.textContent = 'Could not transform this input.';
    errorEl.hidden = false;
  }
});

document.querySelector('[data-testid="copy-btn"]').addEventListener('click', () => {
  try {
    navigator.clipboard.writeText(outputEl.value);
  } catch (e) {
    // Clipboard access can be denied/unavailable; no golden binds to this control.
  }
});
`;

function buildAppJs(transform: string): string {
  // Function replacer (not a plain string) — see calculator.ts header for why.
  return APP_JS_TEMPLATE.replace('/*__TRANSFORM_FN__*/', () => transform);
}

function render(slots: SlotValues, ctx: RenderContext): FileSet {
  const errors = validateSlots(TRANSFORMER, slots);
  if (errors.length > 0) throw new SlotError(errors);

  const headline = slots.headline as string;
  const inputLabel = slots.inputLabel as string;
  const outputLabel = slots.outputLabel as string;
  const placeholder = slots.placeholder as string;
  const transform = slots.transform as string;
  const accentHex = slots.accentHex as string;

  const body = `<main class="transformer">
  <h1>${esc(headline)}</h1>
  <label>${esc(inputLabel)}
    <textarea data-testid="input" placeholder="${esc(placeholder)}"></textarea>
  </label>
  <p data-testid="error-msg" hidden></p>
  <div class="actions">
    <button type="button" data-testid="transform-submit">Transform</button>
    <button type="button" data-testid="copy-btn">Copy result</button>
  </div>
  <label>${esc(outputLabel)}
    <textarea data-testid="output" readonly></textarea>
  </label>
</main>
<script src="/app.js"></script>`;

  const html = pageShell({ title: headline, body, ctx });
  const css = buildStyles(accentHex);
  const appJs = buildAppJs(transform);

  return {
    '/index.html': { content: html, contentType: 'text/html; charset=utf-8' },
    '/styles.css': { content: css, contentType: 'text/css; charset=utf-8' },
    '/app.js': { content: appJs, contentType: 'text/javascript; charset=utf-8' },
  };
}

const referenceBrief: JiffyBrief = {
  template: 'transformer',
  name: 'JSON Pretty-Printer',
  description:
    'Paste minified or messy JSON and get back a nicely indented, 2-space pretty-printed ' +
    'version. Invalid JSON shows a clear error instead of crashing.',
  copy: { headline: 'JSON Pretty-Printer' },
  brand: { accentHex: '#1f2933' },
};

const referenceSlots: SlotValues = {
  headline: 'JSON Pretty-Printer',
  inputLabel: 'Paste your JSON',
  outputLabel: 'Formatted result',
  placeholder: '{"example": true}',
  transform: '(input) => JSON.stringify(JSON.parse(input), null, 2)',
  accentHex: '#1f2933',
};

const referenceGoldens: GoldenSet = {
  goldens: [
    {
      title: 'Valid JSON is pretty-printed',
      steps: [
        { do: 'paste', testid: 'input', text: '{"a":1,"b":[2]}' },
        { do: 'click', testid: 'transform-submit' },
      ],
      expect: [{ testid: 'output', equals: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}' }],
    },
    {
      title: 'Invalid JSON shows an error',
      steps: [
        { do: 'paste', testid: 'input', text: 'not json' },
        { do: 'click', testid: 'transform-submit' },
      ],
      expect: [{ testid: 'error-msg', visible: true }],
    },
    {
      title: 'Page loads with headline title',
      steps: [],
      expect: [{ titleEquals: 'JSON Pretty-Printer' }],
    },
  ],
};

export const TRANSFORMER: TemplateDefinition = {
  id: 'transformer',
  version: '1.0.0',
  priceUsd: 15,
  matcherKeywords: MATCHER_KEYWORDS.transformer,
  elementContract,
  bindableTestids,
  slots: SLOTS,
  briefErrors,
  render,
  goldenGuidance:
    'paste text into `input`, click `transform-submit` ⇒ `equals(output, ...)` (the exact ' +
    'string the transform function returns); invalid-input paste ⇒ `visible(error-msg)`. ' +
    '`copy-btn` is never bound by a golden (clipboard access is not observable headlessly). ' +
    'One load-only golden asserting `titleEquals` is allowed.',
  referenceBrief,
  referenceSlots,
  referenceGoldens,
};
