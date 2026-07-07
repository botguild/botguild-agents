import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAITLIST } from './waitlist.js';
import { REFERENCE_CTX, renderReference } from './registry.js';
import { SlotError, validateSlots } from './engine.js';

test('waitlist reference render carries every contract testid', () => {
  const { html } = renderReference(WAITLIST);
  for (const tid of WAITLIST.elementContract(WAITLIST.referenceSlots)) {
    assert.match(html, new RegExp(`data-testid="${tid}"`), tid);
  }
});

test('waitlist escapes buyer copy', () => {
  const slots = { ...WAITLIST.referenceSlots, headline: '<script>alert(1)</script>' };
  const files = WAITLIST.render(slots, {
    slug: 's',
    toolUrl: 'https://s.jiffyapp.dev',
    publicBaseUrl: 'https://b.example',
    relay: { toolId: 't', token: 'tok' },
  });
  assert.equal(files['/index.html'].content.includes('<script>alert(1)'), false);
  assert.match(files['/index.html'].content, /&lt;script&gt;/);
});

test('waitlist reference slots validate; missing required slot fails', () => {
  assert.deepEqual(validateSlots(WAITLIST, WAITLIST.referenceSlots), []);
  const { headline: _drop, ...rest } = WAITLIST.referenceSlots as Record<string, unknown>;
  assert.ok(validateSlots(WAITLIST, rest).length > 0);
});

test('waitlist rejects a non-ISO launchIso', () => {
  const slots = { ...WAITLIST.referenceSlots, launchIso: 'not-a-date' };
  assert.ok(validateSlots(WAITLIST, slots).length > 0);
});

test('waitlist reference goldens bind only bindable testids', () => {
  const { exact, prefixes } = WAITLIST.bindableTestids(WAITLIST.referenceSlots);
  const ok = (tid: string) => exact.includes(tid) || prefixes.some((p) => tid.startsWith(p));
  for (const g of WAITLIST.referenceGoldens.goldens) {
    for (const e of g.expect) {
      if ('testid' in e) assert.ok(ok(e.testid), e.testid);
    }
  }
});

test('waitlist render throws SlotError when ctx.relay is null', () => {
  assert.throws(
    () => WAITLIST.render(WAITLIST.referenceSlots, { ...REFERENCE_CTX, relay: null }),
    (err: unknown) => err instanceof SlotError && err.errors.includes('relay context required'),
  );
});

test('waitlist render surfaces slot errors before the relay-context check', () => {
  const { headline: _drop, ...rest } = WAITLIST.referenceSlots as Record<string, unknown>;
  assert.throws(
    () => WAITLIST.render(rest, { ...REFERENCE_CTX, relay: null }),
    (err: unknown) => err instanceof SlotError && !err.errors.includes('relay context required'),
  );
});

test('rendered app.js contains the exact relay URL and TEST_MODE logic', () => {
  const { files } = renderReference(WAITLIST);
  const appJs = files['/app.js'].content;
  assert.match(
    appJs,
    /https:\/\/jiffyapp-bot\.example\.workers\.dev\/relay\/ref-tool\?t=ref-token/,
  );
  assert.match(appJs, /new URLSearchParams\(location\.search\)\.has\('jiffytest'\)/);
});

test('rendered HTML carries data-target verbatim (never ticking text) in the static markup', () => {
  const { html } = renderReference(WAITLIST);
  assert.match(html, /data-target="2026-09-01T09:00:00Z"/);
});

test('index.html loads app.js via a same-origin <script> tag', () => {
  const { html } = renderReference(WAITLIST);
  assert.match(html, /<script src="\/app\.js">/);
});
