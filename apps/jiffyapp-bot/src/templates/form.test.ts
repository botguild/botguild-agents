import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORM } from './form.js';
import { REFERENCE_CTX, renderReference } from './registry.js';
import { SlotError, validateSlots } from './engine.js';

test('form reference render carries every contract testid', () => {
  const { html } = renderReference(FORM);
  for (const tid of FORM.elementContract(FORM.referenceSlots)) {
    assert.match(html, new RegExp(`data-testid="${tid}"`), tid);
  }
});

test('form escapes buyer copy', () => {
  const slots = { ...FORM.referenceSlots, headline: '<script>alert(1)</script>' };
  const files = FORM.render(slots, {
    slug: 's',
    toolUrl: 'https://s.jiffyapp.dev',
    publicBaseUrl: 'https://b.example',
    relay: { toolId: 't', token: 'tok' },
  });
  assert.equal(files['/index.html'].content.includes('<script>alert(1)'), false);
  assert.match(files['/index.html'].content, /&lt;script&gt;/);
});

test('form reference slots validate; missing required slot fails', () => {
  assert.deepEqual(validateSlots(FORM, FORM.referenceSlots), []);
  const { headline: _drop, ...rest } = FORM.referenceSlots as Record<string, unknown>;
  assert.ok(validateSlots(FORM, rest).length > 0);
});

test('form reference goldens bind only bindable testids', () => {
  const { exact, prefixes } = FORM.bindableTestids(FORM.referenceSlots);
  const ok = (tid: string) => exact.includes(tid) || prefixes.some((p) => tid.startsWith(p));
  for (const g of FORM.referenceGoldens.goldens) {
    for (const e of g.expect) {
      if ('testid' in e) assert.ok(ok(e.testid), e.testid);
    }
  }
});

test('form bindableTestids has no prefixes (exact census only)', () => {
  const { prefixes } = FORM.bindableTestids(FORM.referenceSlots);
  assert.deepEqual(prefixes, []);
});

test('form render throws SlotError when ctx.relay is null', () => {
  assert.throws(
    () => FORM.render(FORM.referenceSlots, { ...REFERENCE_CTX, relay: null }),
    (err: unknown) => err instanceof SlotError && err.errors.includes('relay context required'),
  );
});

test('form render surfaces slot errors before the relay-context check', () => {
  const { headline: _drop, ...rest } = FORM.referenceSlots as Record<string, unknown>;
  assert.throws(
    () => FORM.render(rest, { ...REFERENCE_CTX, relay: null }),
    (err: unknown) => err instanceof SlotError && !err.errors.includes('relay context required'),
  );
});

test('rendered app.js contains the exact relay URL and TEST_MODE logic', () => {
  const { files } = renderReference(FORM);
  const appJs = files['/app.js'].content;
  assert.match(
    appJs,
    /https:\/\/jiffyapp-bot\.example\.workers\.dev\/relay\/ref-tool\?t=ref-token/,
  );
  assert.match(appJs, /new URLSearchParams\(location\.search\)\.has\('jiffytest'\)/);
});

test('rendered index.html has one field-<name> control per declared field with correct tag/type', () => {
  const { html } = renderReference(FORM);
  const fields = FORM.referenceSlots.fields as Array<{ name: string; type: string }>;
  for (const field of fields) {
    const testid = `field-${field.name}`;
    const tagMatch = new RegExp(`<(input|textarea)[^>]*data-testid="${testid}"[^>]*>`).exec(html);
    assert.ok(tagMatch, `no control found for ${testid}`);
    const tag = tagMatch![0];
    if (field.type === 'textarea') {
      assert.match(tag, /^<textarea/);
    } else {
      assert.match(tag, /^<input/);
      assert.match(tag, new RegExp(`type="${field.type}"`));
    }
  }
});

test('form success-msg and error-msg render hidden by default', () => {
  const { html } = renderReference(FORM);
  assert.match(html, /<p data-testid="success-msg" hidden>/);
  assert.match(html, /<p data-testid="error-msg" hidden>/);
});

test('index.html loads app.js via a same-origin <script> tag', () => {
  const { html } = renderReference(FORM);
  assert.match(html, /<script src="\/app\.js">/);
});
