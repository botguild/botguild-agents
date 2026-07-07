// T2 "calculator" — JiffyApp templates PRD T2, v1.0.0, $25.
//
// Interactive estimator: buyer-declared inputs feed a buyer-declared pure `compute`
// function that returns pre-formatted currency strings (formatting lives inside the
// slot value so goldens can assert exact output). `/app.js` is the only place any
// script runs — `script-src 'self'` forbids inline scripts across the whole catalog,
// so the compute function and its config are injected into a static app.js source by
// string-replacing two comment markers, never by writing an inline <script> tag.

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

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const INPUT_TYPES = new Set(['number', 'text', 'select', 'checkbox']);

type CalculatorInputType = 'number' | 'text' | 'select' | 'checkbox';

interface CalculatorInput {
  name: string;
  label: string;
  type: CalculatorInputType;
  options?: string[];
}

function validateInputs(value: unknown): string[] {
  if (!Array.isArray(value)) return ['inputs: must be an array'];
  const errors: string[] = [];
  if (value.length < 1 || value.length > 8) {
    errors.push('inputs: must have 1-8 entries');
  }
  const seen = new Set<string>();
  value.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      errors.push(`inputs[${i}]: must be an object`);
      return;
    }
    const { name, label, type, options } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      errors.push(`inputs[${i}].name: must match ${NAME_RE.source}`);
    } else if (seen.has(name)) {
      errors.push(`inputs[${i}].name: duplicate name "${name}"`);
    } else {
      seen.add(name);
    }
    if (typeof label !== 'string' || label.trim().length === 0) {
      errors.push(`inputs[${i}].label: required non-empty string`);
    }
    if (typeof type !== 'string' || !INPUT_TYPES.has(type)) {
      errors.push(`inputs[${i}].type: must be one of number|text|select|checkbox`);
    }
    if (type === 'select') {
      const valid =
        Array.isArray(options) && options.length > 0 && options.every((o) => typeof o === 'string');
      if (!valid) {
        errors.push(`inputs[${i}].options: required non-empty string array for type "select"`);
      }
    }
  });
  return errors;
}

const SLOTS: SlotSpec[] = [
  {
    name: 'headline',
    kind: 'copy',
    required: true,
    description: 'Page headline / title, e.g. "Consulting Rate Estimator".',
    example: 'Consulting Rate Estimator',
  },
  {
    name: 'inputs',
    kind: 'json',
    required: true,
    description:
      'Array of 1-8 input specs, each `{ name: string; label: string; type: "number" | ' +
      '"text" | "select" | "checkbox"; options?: string[] }`. name must match /^[a-z][a-z0-9-]*$/ ' +
      'and be unique; select requires a non-empty options array.',
    example: [{ name: 'hours', label: 'Hours', type: 'number' }],
    validate: validateInputs,
  },
  {
    name: 'config',
    kind: 'json',
    required: true,
    description: 'Arbitrary rate/config object the compute function reads (rates, multipliers, …).',
    example: { rates: { junior: 90, senior: 150 }, rushMultiplier: 1.2 },
  },
  {
    name: 'compute',
    kind: 'function',
    required: true,
    description:
      'Pure function `(inputs, config) => { total: string; breakdown?: Record<string, string> }`. ' +
      'inputs arrive as `{ [name]: string | boolean }` (checkbox → boolean, everything else → ' +
      'string). Returns PRE-FORMATTED strings (e.g. "$1,800.00") — do all currency formatting ' +
      'inside the function so goldens can assert exact output.',
    example: '(inputs, config) => ({ total: "$0.00" })',
  },
  {
    name: 'resultLabel',
    kind: 'copy',
    required: true,
    description: 'Label shown next to the computed result, e.g. "Estimated total".',
    example: 'Estimated total',
  },
  {
    name: 'accentHex',
    kind: 'style',
    required: true,
    description: 'Brand accent color as a 6-digit hex code, e.g. #0F3D3E.',
    example: '#0F3D3E',
  },
];

function inputsFromSlots(slots: SlotValues): CalculatorInput[] {
  const value = slots.inputs;
  return Array.isArray(value) ? (value as CalculatorInput[]) : [];
}

function elementContract(slots: SlotValues): string[] {
  const inputIds = inputsFromSlots(slots)
    .filter((i) => i && typeof i.name === 'string')
    .map((i) => `input-${i.name}`);
  return [...inputIds, 'calc-submit', 'result', 'reset', 'footer'];
}

function bindableTestids(slots: SlotValues): { exact: string[]; prefixes: string[] } {
  return { exact: elementContract(slots), prefixes: ['breakdown-'] };
}

function briefErrors(brief: JiffyBrief): string[] {
  return briefErrorsForTemplate('calculator', brief);
}

function renderControl(input: CalculatorInput): string {
  const testid = `input-${input.name}`;
  if (input.type === 'select') {
    const options = (input.options ?? [])
      .map((opt) => `<option value="${esc(opt)}">${esc(opt)}</option>`)
      .join('');
    return `<select data-testid="${testid}" name="${esc(input.name)}">${options}</select>`;
  }
  if (input.type === 'checkbox') {
    return `<input data-testid="${testid}" name="${esc(input.name)}" type="checkbox">`;
  }
  return `<input data-testid="${testid}" name="${esc(input.name)}" type="${input.type}">`;
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
.calculator { max-width: 640px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
h1 { font-size: clamp(1.5rem, 3vw, 2.25rem); margin: 0 0 1.5rem; }
form { display: grid; gap: 1.25rem; background: var(--surface); border-radius: 0.75rem; padding: 1.5rem; }
label { display: grid; gap: 0.4rem; font-weight: 600; }
input, select {
  font: inherit;
  padding: 0.6rem 0.75rem;
  border: 1px solid #8a969b;
  border-radius: 0.4rem;
  background: #fff;
  color: var(--text);
}
input[type="checkbox"] { justify-self: start; width: 1.25rem; height: 1.25rem; }
button { font: inherit; font-weight: 600; padding: 0.7rem 1.4rem; border-radius: 0.5rem; border: none; cursor: pointer; }
button[type="submit"] { background: var(--accent); color: #fff; }
button[type="reset"] { background: transparent; color: var(--text); border: 1px solid #8a969b; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
output { display: block; margin-top: 1.5rem; font-size: 1.1rem; }
output strong { display: block; font-size: 1.75rem; margin-top: 0.25rem; }
#breakdown { margin-top: 0.75rem; color: var(--muted); font-size: 0.95rem; }
.jiffy-footer { text-align: center; padding: 2rem 1.5rem; color: var(--muted); font-size: 0.85rem; }
.jiffy-footer a { color: var(--muted); }
`;
}

const APP_JS_TEMPLATE = `'use strict';
const CONFIG = /*__CONFIG_JSON__*/;
const compute = /*__COMPUTE_FN__*/;
document.getElementById('calc-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const values = {};
  for (const el of e.target.elements) {
    if (!el.name) continue;
    values[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  const out = compute(values, CONFIG);
  document.querySelector('[data-testid="result"]').textContent = out.total;
  const dl = document.getElementById('breakdown');
  dl.textContent = '';
  for (const [k, v] of Object.entries(out.breakdown ?? {})) {
    const div = document.createElement('div');
    div.setAttribute('data-testid', 'breakdown-' + k);
    div.textContent = v;
    dl.appendChild(div);
  }
});
`;

function buildAppJs(config: unknown, compute: string): string {
  // Replacement text is passed via a function (not a string) so that dollar-sign
  // sequences inside it (e.g. the reference compute's `'$' + n.toLocaleString(...)`,
  // which contains the literal substring `$'`) are inserted verbatim instead of being
  // interpreted as String.replace's special `$&`/`$'`/`` $` ``/`$n` patterns.
  return APP_JS_TEMPLATE.replace('/*__CONFIG_JSON__*/', () => JSON.stringify(config)).replace(
    '/*__COMPUTE_FN__*/',
    () => compute,
  );
}

function render(slots: SlotValues, ctx: RenderContext): FileSet {
  const errors = validateSlots(CALCULATOR, slots);
  if (errors.length > 0) throw new SlotError(errors);

  const headline = slots.headline as string;
  const inputs = slots.inputs as CalculatorInput[];
  const config = slots.config;
  const compute = slots.compute as string;
  const resultLabel = slots.resultLabel as string;
  const accentHex = slots.accentHex as string;

  const inputsHtml = inputs
    .map(
      (input) => `
      <label>${esc(input.label)}
        ${renderControl(input)}
      </label>`,
    )
    .join('');

  const body = `<main class="calculator">
  <h1>${esc(headline)}</h1>
  <form id="calc-form">${inputsHtml}
    <button type="submit" data-testid="calc-submit">Calculate</button>
    <button type="reset" data-testid="reset">Reset</button>
  </form>
  <output>
    <span>${esc(resultLabel)}</span>
    <strong data-testid="result"></strong>
    <dl id="breakdown"></dl>
  </output>
</main>`;

  const html = pageShell({ title: headline, body, ctx });
  const css = buildStyles(accentHex);
  const appJs = buildAppJs(config, compute);

  return {
    '/index.html': { content: html, contentType: 'text/html; charset=utf-8' },
    '/styles.css': { content: css, contentType: 'text/css; charset=utf-8' },
    '/app.js': { content: appJs, contentType: 'text/javascript; charset=utf-8' },
  };
}

const referenceBrief: JiffyBrief = {
  template: 'calculator',
  name: 'Consulting Rate Estimator',
  description:
    'Consulting rate estimator: hours worked, seniority level (junior/senior/principal), and ' +
    'an optional rush surcharge. Rates: junior $90/hr, senior $150/hr, principal $220/hr. Rush ' +
    'jobs add a 20% surcharge to the total.',
  copy: { headline: 'Consulting Rate Estimator' },
  brand: { accentHex: '#154734' },
};

const referenceCompute = `(inputs, config) => {
  const hours = Number(inputs.hours) || 0;
  const rate = config.rates[inputs.seniority] ?? 0;
  let total = hours * rate;
  if (inputs.rush) total = total * config.rushMultiplier;
  const fmt = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return { total: fmt(total), breakdown: { base: fmt(hours * rate) } };
}`;

const referenceSlots: SlotValues = {
  headline: 'Consulting Rate Estimator',
  inputs: [
    { name: 'hours', label: 'Hours', type: 'number' },
    {
      name: 'seniority',
      label: 'Seniority',
      type: 'select',
      options: ['junior', 'senior', 'principal'],
    },
    { name: 'rush', label: 'Rush job', type: 'checkbox' },
  ],
  config: { rates: { junior: 90, senior: 150, principal: 220 }, rushMultiplier: 1.2 },
  compute: referenceCompute,
  resultLabel: 'Estimated total',
  accentHex: '#154734',
};

const referenceGoldens: GoldenSet = {
  goldens: [
    {
      title: 'Rush senior estimate',
      steps: [
        { do: 'fill', fields: { 'input-hours': '10', 'input-rush': true } },
        { do: 'select', fields: { 'input-seniority': 'senior' } },
        { do: 'click', testid: 'calc-submit' },
      ],
      expect: [
        { testid: 'result', equals: '$1,800.00' },
        { testid: 'breakdown-base', equals: '$1,500.00' },
      ],
    },
    {
      title: 'Junior estimate without rush',
      steps: [
        { do: 'fill', fields: { 'input-hours': '2', 'input-rush': false } },
        { do: 'select', fields: { 'input-seniority': 'junior' } },
        { do: 'click', testid: 'calc-submit' },
      ],
      expect: [{ testid: 'result', equals: '$180.00' }],
    },
    {
      title: 'Headline renders',
      steps: [],
      expect: [{ titleEquals: 'Consulting Rate Estimator' }],
    },
  ],
};

export const CALCULATOR: TemplateDefinition = {
  id: 'calculator',
  version: '1.0.0',
  priceUsd: 25,
  matcherKeywords: MATCHER_KEYWORDS.calculator,
  elementContract,
  bindableTestids,
  slots: SLOTS,
  briefErrors,
  render,
  goldenGuidance:
    'fill inputs by testid (`input-<name>`), click `calc-submit`, `equals` on `result` (and ' +
    '`breakdown-<key>` when the brief names components). Values must be exactly what the ' +
    'compute function formats (currency strings). One load-only golden asserting headline is ' +
    'allowed.',
  referenceBrief,
  referenceSlots,
  referenceGoldens,
};
