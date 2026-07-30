import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIDGET } from './widget.js';
import { renderReference } from './registry.js';
import { validateSlots } from './engine.js';

function refCtx() {
  return {
    slug: 's',
    toolUrl: 'https://s.jiffyapp.dev',
    publicBaseUrl: 'https://b.example',
    relay: null,
  };
}

test('widget reference render carries every contract testid', () => {
  const { html } = renderReference(WIDGET);
  for (const tid of WIDGET.elementContract(WIDGET.referenceSlots)) {
    assert.match(html, new RegExp(`data-testid="${tid}"`), tid);
  }
});

test('widget escapes buyer copy', () => {
  const slots = {
    ...WIDGET.referenceSlots,
    items: [{ q: '<script>alert(1)</script>', a: 'safe answer' }],
  };
  const files = WIDGET.render(slots, refCtx());
  assert.equal(files['/index.html'].content.includes('<script>alert(1)'), false);
  assert.match(files['/index.html'].content, /&lt;script&gt;/);
});

test('widget reference slots validate; missing required slot fails', () => {
  assert.deepEqual(validateSlots(WIDGET, WIDGET.referenceSlots), []);
  const { variant: _drop, ...rest } = WIDGET.referenceSlots as Record<string, unknown>;
  assert.ok(validateSlots(WIDGET, rest).length > 0);
});

test('widget rejects an invalid variant', () => {
  const slots = { ...WIDGET.referenceSlots, variant: 'carousel' };
  assert.ok(validateSlots(WIDGET, slots).length > 0);
});

test('widget rejects out-of-range and non-integer embed dimensions', () => {
  assert.ok(validateSlots(WIDGET, { ...WIDGET.referenceSlots, embedWidth: '50' }).length > 0);
  assert.ok(validateSlots(WIDGET, { ...WIDGET.referenceSlots, embedWidth: '2001' }).length > 0);
  assert.ok(validateSlots(WIDGET, { ...WIDGET.referenceSlots, embedWidth: '4.5' }).length > 0);
  assert.ok(validateSlots(WIDGET, { ...WIDGET.referenceSlots, embedWidth: 'abc' }).length > 0);
  assert.deepEqual(validateSlots(WIDGET, { ...WIDGET.referenceSlots, embedWidth: '100' }), []);
  assert.deepEqual(validateSlots(WIDGET, { ...WIDGET.referenceSlots, embedWidth: '2000' }), []);
});

test('widget reference goldens bind only bindable testids', () => {
  const { exact, prefixes } = WIDGET.bindableTestids(WIDGET.referenceSlots);
  const ok = (tid: string) => exact.includes(tid) || prefixes.some((p) => tid.startsWith(p));
  for (const g of WIDGET.referenceGoldens.goldens) {
    for (const e of g.expect) {
      if ('testid' in e) assert.ok(ok(e.testid), e.testid);
    }
  }
});

test('index.html loads app.js via a same-origin <script> tag', () => {
  const { html } = renderReference(WIDGET);
  assert.match(html, /<script src="\/app\.js">/);
});

test('embed-snippet escapes the iframe markup so it renders as copyable text, not a child iframe', () => {
  const { html } = renderReference(WIDGET);
  assert.equal(html.includes('<iframe'), false);
  assert.match(
    html,
    /&lt;iframe src=&quot;https:\/\/reference\.jiffyapp\.dev&quot; width=&quot;400&quot; height=&quot;300&quot;/,
  );
  assert.match(html, /data-testid="embed-snippet"/);
});

test('cross-slot validation rejects faq items shaped for the wrong variant', () => {
  const slots = {
    ...WIDGET.referenceSlots,
    items: { targetIso: '2026-01-01T00:00:00Z', label: 'x' },
  };
  assert.ok(validateSlots(WIDGET, slots).length === 0); // items kind check alone passes (object)
  assert.throws(() => WIDGET.render(slots, refCtx()));
});

test('cross-slot validation rejects a faq item missing q/a', () => {
  const slots = { ...WIDGET.referenceSlots, items: [{ q: 'only a question' }] };
  assert.throws(() => WIDGET.render(slots, refCtx()));
});

test('faq variant elementContract/bindable', () => {
  assert.deepEqual(WIDGET.elementContract(WIDGET.referenceSlots), [
    'widget-root',
    'embed-snippet',
    'footer',
    'faq-item',
    'faq-question',
    'faq-answer',
  ]);
});

test('countdown variant renders data-target and the countdown census', () => {
  const slots = {
    variant: 'countdown',
    items: { targetIso: '2026-12-25T00:00:00Z', label: 'Launching in' },
    embedWidth: '500',
    embedHeight: '250',
    accentHex: '#123456',
  };
  assert.deepEqual(validateSlots(WIDGET, slots), []);
  const files = WIDGET.render(slots, refCtx());
  const html = files['/index.html'].content;
  assert.match(html, /data-testid="countdown" data-target="2026-12-25T00:00:00Z"/);
  assert.deepEqual(WIDGET.elementContract(slots), [
    'widget-root',
    'embed-snippet',
    'footer',
    'countdown',
  ]);
});

test('countdown variant rejects a non-ISO targetIso', () => {
  const slots = {
    variant: 'countdown',
    items: { targetIso: 'not-a-date', label: 'Launching in' },
    embedWidth: '500',
    embedHeight: '250',
    accentHex: '#123456',
  };
  assert.throws(() => WIDGET.render(slots, refCtx()));
});

test('testimonials variant renders each quote/author and the testimonials census', () => {
  const slots = {
    variant: 'testimonials',
    items: [
      { quote: 'Great tool!', author: 'A. Buyer' },
      { quote: 'Saved me hours.', author: 'B. Buyer' },
    ],
    embedWidth: '400',
    embedHeight: '300',
    accentHex: '#123456',
  };
  assert.deepEqual(validateSlots(WIDGET, slots), []);
  const files = WIDGET.render(slots, refCtx());
  const html = files['/index.html'].content;
  assert.match(html, /Great tool!/);
  assert.match(html, /A\. Buyer/);
  assert.deepEqual(WIDGET.elementContract(slots), [
    'widget-root',
    'embed-snippet',
    'footer',
    'testimonial-item',
  ]);
});

test('app.js reads variant/target from the DOM instead of per-render markers', () => {
  const { files } = renderReference(WIDGET);
  const appJs = files['/app.js'].content;
  assert.match(appJs, /getAttribute\('data-variant'\)/);
  assert.match(appJs, /getAttribute\('data-target'\)/);
  assert.equal(/\/\*__[A-Z_]+__\*\//.test(appJs), false, 'no leftover marker patterns');
});

test('faq toggle logic pairs faq-question[i] with faq-answer[i] by index', () => {
  const { files } = renderReference(WIDGET);
  const appJs = files['/app.js'].content;
  assert.match(appJs, /faq-question/);
  assert.match(appJs, /answers\[i\]/);
});
