import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALCULATOR } from './calculator.js';
import { renderReference } from './registry.js';
import { validateSlots } from './engine.js';

test('calculator reference render carries every contract testid', () => {
  const { html } = renderReference(CALCULATOR);
  for (const tid of CALCULATOR.elementContract(CALCULATOR.referenceSlots)) {
    assert.match(html, new RegExp(`data-testid="${tid}"`), tid);
  }
});

test('calculator escapes buyer copy', () => {
  const slots = { ...CALCULATOR.referenceSlots, headline: '<script>alert(1)</script>' };
  const files = CALCULATOR.render(slots, {
    slug: 's',
    toolUrl: 'https://s.jiffyapp.dev',
    publicBaseUrl: 'https://b.example',
    relay: null,
  });
  assert.equal(files['/index.html'].content.includes('<script>alert(1)'), false);
  assert.match(files['/index.html'].content, /&lt;script&gt;/);
});

test('calculator reference slots validate; missing required slot fails', () => {
  assert.deepEqual(validateSlots(CALCULATOR, CALCULATOR.referenceSlots), []);
  const { headline: _drop, ...rest } = CALCULATOR.referenceSlots as Record<string, unknown>;
  assert.ok(validateSlots(CALCULATOR, rest).length > 0);
});

test('calculator reference goldens bind only bindable testids', () => {
  const { exact, prefixes } = CALCULATOR.bindableTestids(CALCULATOR.referenceSlots);
  const ok = (tid: string) => exact.includes(tid) || prefixes.some((p) => tid.startsWith(p));
  for (const g of CALCULATOR.referenceGoldens.goldens) {
    for (const e of g.expect) {
      if ('testid' in e) assert.ok(ok(e.testid), e.testid);
    }
  }
});

test('reference compute function produces the exact golden-expected currency strings', () => {
  const slots = CALCULATOR.referenceSlots as Record<string, unknown>;
  const config = slots.config;
  const fn = new Function('return (' + String(slots.compute) + ')')() as (
    inputs: Record<string, string | boolean>,
    config: unknown,
  ) => { total: string; breakdown?: Record<string, string> };

  const rush = fn({ hours: '10', seniority: 'senior', rush: true }, config);
  assert.equal(rush.total, '$1,800.00');
  assert.equal(rush.breakdown?.base, '$1,500.00');

  const noRush = fn({ hours: '2', seniority: 'junior', rush: false }, config);
  assert.equal(noRush.total, '$180.00');
});

test('rendered app.js embeds the JSON config and compute source with markers replaced', () => {
  const { files } = renderReference(CALCULATOR);
  const appJs = files['/app.js'].content;
  const slots = CALCULATOR.referenceSlots as Record<string, unknown>;
  assert.equal(appJs.includes('/*__CONFIG_JSON__*/'), false);
  assert.equal(appJs.includes('/*__COMPUTE_FN__*/'), false);
  assert.match(appJs, /const CONFIG = /);
  assert.equal(appJs.includes(JSON.stringify(slots.config)), true);
  assert.equal(appJs.includes(String(slots.compute)), true);
});

test('rendered index.html carries one input-<name> testid per declared input with correct control types', () => {
  const { html } = renderReference(CALCULATOR);
  const inputs = CALCULATOR.referenceSlots.inputs as Array<{
    name: string;
    type: string;
  }>;
  for (const input of inputs) {
    const testid = `input-${input.name}`;
    const tagMatch = new RegExp(`<(select|input)[^>]*data-testid="${testid}"[^>]*>`).exec(html);
    assert.ok(tagMatch, `no control found for ${testid}`);
    const tag = tagMatch![0];
    if (input.type === 'select') {
      assert.match(tag, /^<select/);
    } else if (input.type === 'checkbox') {
      assert.match(tag, /^<input/);
      assert.match(tag, /type="checkbox"/);
    } else {
      assert.match(tag, /^<input/);
      assert.match(tag, new RegExp(`type="${input.type}"`));
    }
  }
});
