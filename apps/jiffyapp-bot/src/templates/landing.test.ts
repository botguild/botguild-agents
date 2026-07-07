import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANDING } from './landing.js';
import { renderReference } from './registry.js';
import { validateSlots } from './engine.js';

test('landing reference render carries every contract testid', () => {
  const { html } = renderReference(LANDING);
  for (const tid of LANDING.elementContract(LANDING.referenceSlots)) {
    assert.match(html, new RegExp(`data-testid="${tid}"`), tid);
  }
});

test('landing escapes buyer copy', () => {
  const slots = { ...LANDING.referenceSlots, headline: '<script>alert(1)</script>' };
  const files = LANDING.render(slots, {
    slug: 's',
    toolUrl: 'https://s.jiffyapp.dev',
    publicBaseUrl: 'https://b.example',
    relay: null,
  });
  assert.equal(files['/index.html'].content.includes('<script>alert(1)'), false);
  assert.match(files['/index.html'].content, /&lt;script&gt;/);
});

test('landing reference slots validate; missing required slot fails', () => {
  assert.deepEqual(validateSlots(LANDING, LANDING.referenceSlots), []);
  const { headline: _drop, ...rest } = LANDING.referenceSlots as Record<string, unknown>;
  assert.ok(validateSlots(LANDING, rest).length > 0);
});

test('landing reference goldens bind only bindable testids', () => {
  const { exact, prefixes } = LANDING.bindableTestids(LANDING.referenceSlots);
  const ok = (tid: string) => exact.includes(tid) || prefixes.some((p) => tid.startsWith(p));
  for (const g of LANDING.referenceGoldens.goldens) {
    for (const e of g.expect) {
      if ('testid' in e) assert.ok(ok(e.testid), e.testid);
    }
  }
});
