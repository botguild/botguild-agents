import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSFORMER } from './transformer.js';
import { renderReference } from './registry.js';
import { validateSlots } from './engine.js';

test('transformer reference render carries every contract testid', () => {
  const { html } = renderReference(TRANSFORMER);
  for (const tid of TRANSFORMER.elementContract(TRANSFORMER.referenceSlots)) {
    assert.match(html, new RegExp(`data-testid="${tid}"`), tid);
  }
});

test('transformer escapes buyer copy', () => {
  const slots = { ...TRANSFORMER.referenceSlots, headline: '<script>alert(1)</script>' };
  const files = TRANSFORMER.render(slots, {
    slug: 's',
    toolUrl: 'https://s.jiffyapp.dev',
    publicBaseUrl: 'https://b.example',
    relay: null,
  });
  assert.equal(files['/index.html'].content.includes('<script>alert(1)'), false);
  assert.match(files['/index.html'].content, /&lt;script&gt;/);
});

test('transformer reference slots validate; missing required slot fails', () => {
  assert.deepEqual(validateSlots(TRANSFORMER, TRANSFORMER.referenceSlots), []);
  const { headline: _drop, ...rest } = TRANSFORMER.referenceSlots as Record<string, unknown>;
  assert.ok(validateSlots(TRANSFORMER, rest).length > 0);
});

test('transformer reference goldens bind only bindable testids', () => {
  const { exact, prefixes } = TRANSFORMER.bindableTestids(TRANSFORMER.referenceSlots);
  const ok = (tid: string) => exact.includes(tid) || prefixes.some((p) => tid.startsWith(p));
  for (const g of TRANSFORMER.referenceGoldens.goldens) {
    for (const e of g.expect) {
      if ('testid' in e) assert.ok(ok(e.testid), e.testid);
    }
  }
});

test('rendered app.js embeds the transform source with the marker replaced', () => {
  const { files } = renderReference(TRANSFORMER);
  const appJs = files['/app.js'].content;
  assert.equal(/\/\*__[A-Z_]+__\*\//.test(appJs), false, 'no leftover marker patterns');
  assert.equal(appJs.includes(String(TRANSFORMER.referenceSlots.transform)), true);
  assert.match(appJs, /transform-submit/);
});

test('index.html loads app.js via a same-origin <script> tag', () => {
  const { html } = renderReference(TRANSFORMER);
  assert.match(html, /<script src="\/app\.js">/);
});

test('reference transform round-trips valid JSON via new Function (TEST ONLY)', () => {
  const src = TRANSFORMER.referenceSlots.transform as string;
  const fn = new Function('return (' + src + ')')() as (input: string) => string;
  assert.equal(fn('{"a":1}'), '{\n  "a": 1\n}');
});

test('reference goldens expected output strings match what the transform actually returns', () => {
  const src = TRANSFORMER.referenceSlots.transform as string;
  const fn = new Function('return (' + src + ')')() as (input: string) => string;

  const successGolden = TRANSFORMER.referenceGoldens.goldens[0];
  const pasteStep = successGolden.steps[0] as { do: 'paste'; testid: string; text?: string };
  const expectation = successGolden.expect[0] as { testid: string; equals: string };
  assert.equal(pasteStep.do, 'paste');
  assert.equal(fn(pasteStep.text as string), expectation.equals);

  const errorGolden = TRANSFORMER.referenceGoldens.goldens[1];
  const badStep = errorGolden.steps[0] as { do: 'paste'; testid: string; text?: string };
  assert.throws(() => fn(badStep.text as string));
});
