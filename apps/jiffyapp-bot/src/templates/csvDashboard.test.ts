import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSV_DASHBOARD, computeAggregates } from './csvDashboard.js';
import { renderReference } from './registry.js';
import { validateSlots } from './engine.js';
import { CHARTJS_JS } from './vendor/chartjs.js';
import { PAPAPARSE_JS } from './vendor/papaparse.js';

test('csv-dashboard reference render carries every contract testid', () => {
  const { html } = renderReference(CSV_DASHBOARD);
  for (const tid of CSV_DASHBOARD.elementContract(CSV_DASHBOARD.referenceSlots)) {
    assert.match(html, new RegExp(`data-testid="${tid}"`), tid);
  }
});

test('csv-dashboard escapes buyer copy', () => {
  const slots = { ...CSV_DASHBOARD.referenceSlots, headline: '<script>alert(1)</script>' };
  const files = CSV_DASHBOARD.render(slots, {
    slug: 's',
    toolUrl: 'https://s.jiffyapp.dev',
    publicBaseUrl: 'https://b.example',
    relay: null,
  });
  assert.equal(files['/index.html'].content.includes('<script>alert(1)'), false);
  assert.match(files['/index.html'].content, /&lt;script&gt;/);
});

test('csv-dashboard reference slots validate; missing required slot fails', () => {
  assert.deepEqual(validateSlots(CSV_DASHBOARD, CSV_DASHBOARD.referenceSlots), []);
  const { headline: _drop, ...rest } = CSV_DASHBOARD.referenceSlots as Record<string, unknown>;
  assert.ok(validateSlots(CSV_DASHBOARD, rest).length > 0);
});

test('csv-dashboard reference goldens bind only bindable testids', () => {
  const { exact, prefixes } = CSV_DASHBOARD.bindableTestids(CSV_DASHBOARD.referenceSlots);
  const ok = (tid: string) => exact.includes(tid) || prefixes.some((p) => tid.startsWith(p));
  for (const g of CSV_DASHBOARD.referenceGoldens.goldens) {
    for (const e of g.expect) {
      if ('testid' in e) assert.ok(ok(e.testid), e.testid);
    }
  }
});

test('"row" is bindable but not in the load-time element contract', () => {
  const { exact } = CSV_DASHBOARD.bindableTestids(CSV_DASHBOARD.referenceSlots);
  assert.ok(exact.includes('row'));
  assert.equal(CSV_DASHBOARD.elementContract(CSV_DASHBOARD.referenceSlots).includes('row'), false);
});

test('cross-slot validation rejects sum/avg aggregates on a non-number column', () => {
  const slots = {
    ...CSV_DASHBOARD.referenceSlots,
    aggregates: [{ key: 'total', label: 'Total', op: 'sum', column: 'month' }],
  };
  assert.throws(() => CSV_DASHBOARD.render(slots, refCtx()));
});

test('cross-slot validation rejects a sum aggregate missing column', () => {
  const slots = {
    ...CSV_DASHBOARD.referenceSlots,
    aggregates: [{ key: 'total', label: 'Total', op: 'sum' }],
  };
  assert.throws(() => CSV_DASHBOARD.render(slots, refCtx()));
});

test('cross-slot validation rejects a chart referencing an undeclared column', () => {
  const slots = {
    ...CSV_DASHBOARD.referenceSlots,
    charts: [{ type: 'bar', labelColumn: 'month', valueColumn: 'nope' }],
  };
  assert.throws(() => CSV_DASHBOARD.render(slots, refCtx()));
});

function refCtx() {
  return {
    slug: 's',
    toolUrl: 'https://s.jiffyapp.dev',
    publicBaseUrl: 'https://b.example',
    relay: null,
  };
}

test('rendered file set vendors Papa Parse and Chart.js verbatim', () => {
  const { files } = renderReference(CSV_DASHBOARD);
  assert.equal(files['/vendor/papaparse.js'].content, PAPAPARSE_JS);
  assert.equal(files['/vendor/chart.js'].content, CHARTJS_JS);
  assert.match(files['/index.html'].content, /<script src="\/vendor\/papaparse\.js">/);
  assert.match(files['/index.html'].content, /<script src="\/vendor\/chart\.js">/);
  assert.match(files['/index.html'].content, /<script src="\/app\.js">/);
});

test('rendered app.js embeds COLUMNS/AGGREGATES/CHARTS JSON and computeAggregates source with markers replaced', () => {
  const { files } = renderReference(CSV_DASHBOARD);
  const appJs = files['/app.js'].content;
  assert.equal(/\/\*__[A-Z_]+__\*\//.test(appJs), false, 'no leftover marker patterns');
  assert.equal(appJs.includes(JSON.stringify(CSV_DASHBOARD.referenceSlots.columns)), true);
  assert.equal(appJs.includes(JSON.stringify(CSV_DASHBOARD.referenceSlots.aggregates)), true);
  assert.equal(appJs.includes(JSON.stringify(CSV_DASHBOARD.referenceSlots.charts)), true);
  assert.equal(appJs.includes(computeAggregates.toString()), true);
});

test('app.js contains header-set-equality check logic', () => {
  const { files } = renderReference(CSV_DASHBOARD);
  const appJs = files['/app.js'].content;
  assert.match(appJs, /function sameSet/);
  assert.match(appJs, /Papa\.parse\(text, \{ header: true, skipEmptyLines: true \}\)/);
});

test('computeAggregates: sum/avg formatting and count for the reference fixture', () => {
  const rows = [{ revenue: '1000' }, { revenue: '2500' }, { revenue: '1500' }];
  const aggregates = CSV_DASHBOARD.referenceSlots.aggregates as Array<{
    key: string;
    label: string;
    op: 'sum' | 'avg' | 'count';
    column?: string;
  }>;
  const out = computeAggregates(rows, aggregates);
  assert.equal(out.total, '5,000');
  assert.equal(out.months, '3');
});

test('computeAggregates: avg rounds to at most 2 fraction digits', () => {
  const rows = [{ revenue: '10' }, { revenue: '11' }, { revenue: '12' }];
  const out = computeAggregates(rows, [
    { key: 'avg-rev', label: 'Average revenue', op: 'avg', column: 'revenue' },
  ]);
  assert.equal(out['avg-rev'], '11');
});

test('computeAggregates: non-numeric values are excluded from sum/avg', () => {
  const rows = [{ revenue: '100' }, { revenue: 'n/a' }, { revenue: '200' }];
  const out = computeAggregates(rows, [
    { key: 'total', label: 'Total', op: 'sum', column: 'revenue' },
  ]);
  assert.equal(out.total, '300');
});

test('computeAggregates: count ignores column entirely', () => {
  const rows = [{ a: '1' }, { a: '2' }];
  const out = computeAggregates(rows, [{ key: 'n', label: 'Count', op: 'count' }]);
  assert.equal(out.n, '2');
});

test('reference goldens fixtures match the CSV header shape used in the header-mismatch check', () => {
  const fixtures = CSV_DASHBOARD.referenceGoldens.fixtures ?? {};
  assert.equal(fixtures['sales.csv'], 'month,revenue\nJan,1000\nFeb,2500\nMar,1500\n');
  assert.equal(fixtures['bad.csv'], 'foo,bar\n1,2\n');
});
