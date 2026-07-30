// T4 "csv-dashboard" — JiffyApp templates PRD T4, v1.0.0, $25.
//
// Buyer-declared CSV shape (columns), summary math (aggregates), and chart wiring
// (charts) drive a client-side data viewer: paste or upload a CSV, get a row table, a
// handful of computed summaries, and one or more Chart.js charts — no server round
// trip, no relay. Papa Parse and Chart.js are vendored (see `./vendor/`) and served
// from `/vendor/*.js`, same-origin, so `script-src 'self'` covers them without a CDN.
//
// `computeAggregates` is the one piece of "logic" this template ships that isn't
// buyer-authored: it's a real exported TS function (unit-testable directly), and its
// *compiled source* is embedded into `/app.js` via `.toString()` — same marker-replace,
// function-replacer technique as calculator's `compute` and form's field spec, so that
// injected JSON/source containing literal `$`-prefixed sequences is never misread as a
// String.replace special pattern.

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
import { CHARTJS_JS } from './vendor/chartjs.js';
import { PAPAPARSE_JS } from './vendor/papaparse.js';

const AGG_KEY_RE = /^[a-z][a-z0-9-]*$/;
const COLUMN_TYPES = new Set(['string', 'number']);
const AGG_OPS = new Set(['sum', 'avg', 'count']);
const CHART_TYPES = new Set(['bar', 'line']);

export type CsvColumnType = 'string' | 'number';

export interface CsvColumn {
  name: string;
  type: CsvColumnType;
}

export type CsvAggregateOp = 'sum' | 'avg' | 'count';

export interface CsvAggregate {
  key: string;
  label: string;
  op: CsvAggregateOp;
  column?: string;
}

export type CsvChartType = 'bar' | 'line';

export interface CsvChart {
  type: CsvChartType;
  labelColumn: string;
  valueColumn: string;
}

/**
 * Pure aggregate math the tool ships — the same function is unit-tested directly here
 * AND embedded (via `.toString()`) into the rendered `/app.js`, so there is exactly one
 * implementation, never a hand-duplicated client copy that could drift.
 */
export function computeAggregates(
  rows: ReadonlyArray<Record<string, string>>,
  aggregates: ReadonlyArray<CsvAggregate>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const agg of aggregates) {
    if (agg.op === 'count') {
      result[agg.key] = String(rows.length);
      continue;
    }
    const column = agg.column;
    const values = rows
      .map((row) => (column ? Number(row[column]) : NaN))
      .filter((n) => Number.isFinite(n));
    let total = 0;
    for (const n of values) total += n;
    const num = agg.op === 'avg' ? (values.length > 0 ? total / values.length : 0) : total;
    result[agg.key] = num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return result;
}

function validateColumns(value: unknown): string[] {
  if (!Array.isArray(value)) return ['columns: must be an array'];
  const errors: string[] = [];
  if (value.length < 2 || value.length > 12) {
    errors.push('columns: must have 2-12 entries');
  }
  const seen = new Set<string>();
  value.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      errors.push(`columns[${i}]: must be an object`);
      return;
    }
    const { name, type } = item as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim().length === 0) {
      errors.push(`columns[${i}].name: required non-empty string`);
    } else if (seen.has(name)) {
      errors.push(`columns[${i}].name: duplicate name "${name}"`);
    } else {
      seen.add(name);
    }
    if (typeof type !== 'string' || !COLUMN_TYPES.has(type)) {
      errors.push(`columns[${i}].type: must be "string" or "number"`);
    }
  });
  return errors;
}

function validateAggregates(value: unknown): string[] {
  if (!Array.isArray(value)) return ['aggregates: must be an array'];
  const errors: string[] = [];
  if (value.length < 1 || value.length > 4) {
    errors.push('aggregates: must have 1-4 entries');
  }
  const seen = new Set<string>();
  value.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      errors.push(`aggregates[${i}]: must be an object`);
      return;
    }
    const { key, label, op, column } = item as Record<string, unknown>;
    if (typeof key !== 'string' || !AGG_KEY_RE.test(key)) {
      errors.push(`aggregates[${i}].key: must match ${AGG_KEY_RE.source}`);
    } else if (seen.has(key)) {
      errors.push(`aggregates[${i}].key: duplicate key "${key}"`);
    } else {
      seen.add(key);
    }
    if (typeof label !== 'string' || label.trim().length === 0) {
      errors.push(`aggregates[${i}].label: required non-empty string`);
    }
    if (typeof op !== 'string' || !AGG_OPS.has(op)) {
      errors.push(`aggregates[${i}].op: must be one of sum|avg|count`);
    }
    if (column !== undefined && typeof column !== 'string') {
      errors.push(`aggregates[${i}].column: must be a string when present`);
    }
  });
  return errors;
}

function validateCharts(value: unknown): string[] {
  if (!Array.isArray(value)) return ['charts: must be an array'];
  const errors: string[] = [];
  if (value.length < 1 || value.length > 3) {
    errors.push('charts: must have 1-3 entries');
  }
  value.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      errors.push(`charts[${i}]: must be an object`);
      return;
    }
    const { type, labelColumn, valueColumn } = item as Record<string, unknown>;
    if (typeof type !== 'string' || !CHART_TYPES.has(type)) {
      errors.push(`charts[${i}].type: must be one of bar|line`);
    }
    if (typeof labelColumn !== 'string' || labelColumn.trim().length === 0) {
      errors.push(`charts[${i}].labelColumn: required non-empty string`);
    }
    if (typeof valueColumn !== 'string' || valueColumn.trim().length === 0) {
      errors.push(`charts[${i}].valueColumn: required non-empty string`);
    }
  });
  return errors;
}

const SLOTS: SlotSpec[] = [
  {
    name: 'headline',
    kind: 'copy',
    required: true,
    description: 'Page headline / title, e.g. "Monthly Sales Dashboard".',
    example: 'Monthly Sales Dashboard',
  },
  {
    name: 'columns',
    kind: 'json',
    required: true,
    description:
      'Array of 2-12 declared CSV columns, each `{ name: string; type: "string" | "number" }`. ' +
      '`name` must match the CSV header text exactly and be unique.',
    example: [
      { name: 'month', type: 'string' },
      { name: 'revenue', type: 'number' },
    ],
    validate: validateColumns,
  },
  {
    name: 'aggregates',
    kind: 'json',
    required: true,
    description:
      'Array of 1-4 summary specs, each `{ key: string; label: string; op: "sum" | "avg" | ' +
      '"count"; column?: string }`. `key` must match /^[a-z][a-z0-9-]*$/ and be unique (drives ' +
      'the `summary-<key>` testid). `column` is required for "sum"/"avg" and must name a ' +
      'declared column of type "number"; ignored for "count".',
    example: [{ key: 'total', label: 'Total revenue', op: 'sum', column: 'revenue' }],
    validate: validateAggregates,
  },
  {
    name: 'charts',
    kind: 'json',
    required: true,
    description:
      'Array of 1-3 chart specs, each `{ type: "bar" | "line"; labelColumn: string; ' +
      'valueColumn: string }`. `labelColumn`/`valueColumn` must name declared columns.',
    example: [{ type: 'bar', labelColumn: 'month', valueColumn: 'revenue' }],
    validate: validateCharts,
  },
  {
    name: 'accentHex',
    kind: 'style',
    required: true,
    description: 'Brand accent color as a 6-digit hex code, e.g. #0F3D3E.',
    example: '#0F3D3E',
  },
];

function columnsFromSlots(slots: SlotValues): CsvColumn[] {
  const value = slots.columns;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is CsvColumn =>
      typeof v === 'object' && v !== null && typeof (v as CsvColumn).name === 'string',
  );
}

function aggregatesFromSlots(slots: SlotValues): CsvAggregate[] {
  const value = slots.aggregates;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is CsvAggregate =>
      typeof v === 'object' && v !== null && typeof (v as CsvAggregate).key === 'string',
  );
}

function chartsFromSlots(slots: SlotValues): CsvChart[] {
  const value = slots.charts;
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is CsvChart => typeof v === 'object' && v !== null);
}

/**
 * Cross-slot checks that `validateSlots` cannot express — each `SlotSpec.validate`
 * only sees its own field's value, but "aggregates[i].column must be a declared
 * number column" and "charts[i].*Column must be a declared column" both need the
 * `columns` slot too. Defensive against malformed input (never throws).
 */
function crossSlotErrors(slots: SlotValues): string[] {
  const errors: string[] = [];
  const columns = columnsFromSlots(slots);
  const columnNames = new Set(columns.map((c) => c.name));
  const numberColumnNames = new Set(columns.filter((c) => c.type === 'number').map((c) => c.name));

  aggregatesFromSlots(slots).forEach((agg, i) => {
    if (agg.op === 'sum' || agg.op === 'avg') {
      if (typeof agg.column !== 'string' || !numberColumnNames.has(agg.column)) {
        errors.push(
          `aggregates[${i}].column: required for op "${agg.op}" and must be a declared number column`,
        );
      }
    }
  });

  chartsFromSlots(slots).forEach((chart, i) => {
    if (typeof chart.labelColumn === 'string' && !columnNames.has(chart.labelColumn)) {
      errors.push(`charts[${i}].labelColumn: must reference a declared column`);
    }
    if (typeof chart.valueColumn === 'string' && !columnNames.has(chart.valueColumn)) {
      errors.push(`charts[${i}].valueColumn: must reference a declared column`);
    }
  });

  return errors;
}

function elementContract(slots: SlotValues): string[] {
  const chartIds = chartsFromSlots(slots).map((_, i) => `chart-${i + 1}`);
  const summaryIds = aggregatesFromSlots(slots).map((a) => `summary-${a.key}`);
  return [
    'csv-input',
    'csv-upload',
    'render-submit',
    'table',
    ...chartIds,
    ...summaryIds,
    'error-msg',
    'footer',
  ];
}

function bindableTestids(slots: SlotValues): { exact: string[]; prefixes: string[] } {
  return { exact: [...elementContract(slots), 'row'], prefixes: [] };
}

function briefErrors(brief: JiffyBrief): string[] {
  return briefErrorsForTemplate('csv-dashboard', brief);
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
.dashboard { max-width: 960px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
h1 { font-size: clamp(1.5rem, 3vw, 2.25rem); margin: 0 0 1.5rem; }
.input-panel { display: grid; gap: 1rem; background: var(--surface); border-radius: 0.75rem; padding: 1.5rem; margin-bottom: 1.5rem; }
label { display: grid; gap: 0.4rem; font-weight: 600; }
textarea, input[type="file"] {
  font: inherit;
  padding: 0.6rem 0.75rem;
  border: 1px solid #8a969b;
  border-radius: 0.4rem;
  background: #fff;
  color: var(--text);
}
textarea { min-height: 8rem; resize: vertical; }
button { font: inherit; font-weight: 600; padding: 0.7rem 1.4rem; border-radius: 0.5rem; border: none; cursor: pointer; background: var(--accent); color: #fff; justify-self: start; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
[data-testid="error-msg"] { color: #9b1c1c; margin: 0 0 1.5rem; }
.summaries { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; }
.summary { background: var(--surface); border-radius: 0.5rem; padding: 0.75rem 1.25rem; }
.summary-label { display: block; color: var(--muted); font-size: 0.85rem; }
.summary output { font-size: 1.35rem; font-weight: 700; }
.charts { display: grid; gap: 1.5rem; margin-bottom: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.charts canvas { max-width: 100%; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--surface); }
th { color: var(--muted); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.03em; }
.jiffy-footer { text-align: center; padding: 2rem 1.5rem; color: var(--muted); font-size: 0.85rem; }
.jiffy-footer a { color: var(--muted); }
`;
}

const APP_JS_TEMPLATE = `'use strict';
const COLUMNS = /*__COLUMNS__*/;
const AGGREGATES = /*__AGGREGATES__*/;
const CHARTS = /*__CHARTS__*/;
const computeAggregates = /*__COMPUTE_AGGREGATES__*/;

const inputEl = document.querySelector('[data-testid="csv-input"]');
const uploadEl = document.querySelector('[data-testid="csv-upload"]');
const tableBodyEl = document.querySelector('[data-testid="table"] tbody');
const errorEl = document.querySelector('[data-testid="error-msg"]');
let chartInstances = [];

function expectedColumnNames() {
  return COLUMNS.map((c) => c.name);
}

function sameSet(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

function clearOutputs() {
  tableBodyEl.textContent = '';
  for (const chart of chartInstances) chart.destroy();
  chartInstances = [];
  for (const agg of AGGREGATES) {
    const el = document.querySelector('[data-testid="summary-' + agg.key + '"]');
    if (el) el.textContent = '';
  }
}

function showError(message) {
  clearOutputs();
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function renderData(text) {
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  const fields = (parsed.meta && parsed.meta.fields) || [];
  const expected = expectedColumnNames();
  if ((parsed.errors && parsed.errors.length > 0) || !sameSet(fields, expected)) {
    showError('Could not read this CSV. Expected columns: ' + expected.join(', '));
    return;
  }

  errorEl.hidden = true;
  errorEl.textContent = '';
  clearOutputs();

  for (const row of parsed.data) {
    const tr = document.createElement('tr');
    tr.setAttribute('data-testid', 'row');
    for (const col of COLUMNS) {
      const td = document.createElement('td');
      td.textContent = row[col.name];
      tr.appendChild(td);
    }
    tableBodyEl.appendChild(tr);
  }

  const summary = computeAggregates(parsed.data, AGGREGATES);
  for (const agg of AGGREGATES) {
    const el = document.querySelector('[data-testid="summary-' + agg.key + '"]');
    if (el) el.textContent = summary[agg.key];
  }

  CHARTS.forEach((chart, i) => {
    const canvas = document.querySelector('[data-testid="chart-' + (i + 1) + '"]');
    if (!canvas) return;
    const labels = parsed.data.map((row) => row[chart.labelColumn]);
    const values = parsed.data.map((row) => Number(row[chart.valueColumn]) || 0);
    chartInstances.push(
      new Chart(canvas, {
        type: chart.type,
        data: { labels: labels, datasets: [{ label: chart.valueColumn, data: values }] },
      }),
    );
  });
}

document.querySelector('[data-testid="render-submit"]').addEventListener('click', () => {
  const file = uploadEl.files && uploadEl.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = () => renderData(String(reader.result));
    reader.readAsText(file);
    return;
  }
  renderData(inputEl.value);
});
`;

function buildAppJs(columns: CsvColumn[], aggregates: CsvAggregate[], charts: CsvChart[]): string {
  // Function replacers (not plain strings) — see calculator.ts header for why: the
  // JSON payloads here can contain `$`-prefixed sequences that String.replace would
  // otherwise misinterpret as its special `$&`/`$'`/`` $` ``/`$n` patterns.
  return APP_JS_TEMPLATE.replace('/*__COLUMNS__*/', () => JSON.stringify(columns))
    .replace('/*__AGGREGATES__*/', () => JSON.stringify(aggregates))
    .replace('/*__CHARTS__*/', () => JSON.stringify(charts))
    .replace('/*__COMPUTE_AGGREGATES__*/', () => computeAggregates.toString());
}

function render(slots: SlotValues, ctx: RenderContext): FileSet {
  const errors = [...validateSlots(CSV_DASHBOARD, slots), ...crossSlotErrors(slots)];
  if (errors.length > 0) throw new SlotError(errors);

  const headline = slots.headline as string;
  const columns = slots.columns as CsvColumn[];
  const aggregates = slots.aggregates as CsvAggregate[];
  const charts = slots.charts as CsvChart[];
  const accentHex = slots.accentHex as string;

  const summariesHtml = aggregates
    .map(
      (agg) =>
        `<div class="summary"><span class="summary-label">${esc(agg.label)}</span><output data-testid="summary-${esc(agg.key)}"></output></div>`,
    )
    .join('');

  const chartsHtml = charts
    .map((_, i) => `<canvas data-testid="chart-${i + 1}"></canvas>`)
    .join('');

  const theadHtml = columns.map((col) => `<th>${esc(col.name)}</th>`).join('');

  const body = `<main class="dashboard">
  <h1>${esc(headline)}</h1>
  <section class="input-panel">
    <label>Paste CSV
      <textarea data-testid="csv-input" rows="8"></textarea>
    </label>
    <label>Or upload a CSV file
      <input data-testid="csv-upload" type="file" accept=".csv,text/csv">
    </label>
    <button type="button" data-testid="render-submit">Render dashboard</button>
  </section>
  <p data-testid="error-msg" hidden></p>
  <section class="summaries">${summariesHtml}</section>
  <section class="charts">${chartsHtml}</section>
  <table data-testid="table">
    <thead><tr>${theadHtml}</tr></thead>
    <tbody></tbody>
  </table>
</main>
<script src="/vendor/papaparse.js"></script>
<script src="/vendor/chart.js"></script>
<script src="/app.js"></script>`;

  const html = pageShell({ title: headline, body, ctx });
  const css = buildStyles(accentHex);
  const appJs = buildAppJs(columns, aggregates, charts);

  return {
    '/index.html': { content: html, contentType: 'text/html; charset=utf-8' },
    '/styles.css': { content: css, contentType: 'text/css; charset=utf-8' },
    '/app.js': { content: appJs, contentType: 'text/javascript; charset=utf-8' },
    '/vendor/papaparse.js': {
      content: PAPAPARSE_JS,
      contentType: 'text/javascript; charset=utf-8',
    },
    '/vendor/chart.js': { content: CHARTJS_JS, contentType: 'text/javascript; charset=utf-8' },
  };
}

const referenceBrief: JiffyBrief = {
  template: 'csv-dashboard',
  name: 'Monthly Sales Dashboard',
  description:
    'Paste or upload monthly sales CSV data (month, revenue) and see a data table, total ' +
    'revenue, months reported, and a bar chart of revenue by month.',
  copy: { headline: 'Monthly Sales Dashboard' },
  brand: { accentHex: '#0f4c81' },
};

const referenceSlots: SlotValues = {
  headline: 'Monthly Sales Dashboard',
  columns: [
    { name: 'month', type: 'string' },
    { name: 'revenue', type: 'number' },
  ],
  aggregates: [
    { key: 'total', label: 'Total revenue', op: 'sum', column: 'revenue' },
    { key: 'months', label: 'Months reported', op: 'count' },
  ],
  charts: [{ type: 'bar', labelColumn: 'month', valueColumn: 'revenue' }],
  accentHex: '#0f4c81',
};

const referenceGoldens: GoldenSet = {
  goldens: [
    {
      title: 'Sales CSV renders rows, totals, and chart',
      steps: [
        { do: 'paste', testid: 'csv-input', fixture: 'sales.csv' },
        { do: 'click', testid: 'render-submit' },
      ],
      expect: [
        { testid: 'row', count: 3 },
        { testid: 'summary-total', equals: '5,000' },
        { testid: 'summary-months', equals: '3' },
        { testid: 'chart-1', visible: true },
      ],
    },
    {
      title: 'Mismatched columns show an error',
      steps: [
        { do: 'paste', testid: 'csv-input', fixture: 'bad.csv' },
        { do: 'click', testid: 'render-submit' },
      ],
      expect: [{ testid: 'error-msg', visible: true }],
    },
    {
      title: 'Page loads with headline title',
      steps: [],
      expect: [{ titleEquals: 'Monthly Sales Dashboard' }],
    },
  ],
  fixtures: {
    'sales.csv': 'month,revenue\nJan,1000\nFeb,2500\nMar,1500\n',
    'bad.csv': 'foo,bar\n1,2\n',
  },
};

export const CSV_DASHBOARD: TemplateDefinition = {
  id: 'csv-dashboard',
  version: '1.0.0',
  priceUsd: 25,
  matcherKeywords: MATCHER_KEYWORDS['csv-dashboard'],
  elementContract,
  bindableTestids,
  slots: SLOTS,
  briefErrors,
  render,
  goldenGuidance:
    'paste a fixture CSV into `csv-input` (or `upload` onto `csv-upload`), click ' +
    '`render-submit` ⇒ `count` on `row`, `equals` on `summary-<key>` (exact formatted ' +
    'string), `visible(chart-<n>)`. A header-mismatched fixture ⇒ `visible(error-msg)`. One ' +
    'load-only golden asserting `titleEquals` is allowed (the census has no `headline` testid).',
  referenceBrief,
  referenceSlots,
  referenceGoldens,
};
