import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINK_IN_BIO } from './linkInBio.js';
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

test('link-in-bio reference render carries every contract testid', () => {
  const { html } = renderReference(LINK_IN_BIO);
  for (const tid of LINK_IN_BIO.elementContract(LINK_IN_BIO.referenceSlots)) {
    assert.match(html, new RegExp(`data-testid="${tid}"`), tid);
  }
});

test('link-in-bio escapes buyer copy', () => {
  const slots = { ...LINK_IN_BIO.referenceSlots, displayName: '<script>alert(1)</script>' };
  const files = LINK_IN_BIO.render(slots, refCtx());
  assert.equal(files['/index.html'].content.includes('<script>alert(1)'), false);
  assert.match(files['/index.html'].content, /&lt;script&gt;/);
});

test('link-in-bio reference slots validate; missing required slot fails', () => {
  assert.deepEqual(validateSlots(LINK_IN_BIO, LINK_IN_BIO.referenceSlots), []);
  const { displayName: _drop, ...rest } = LINK_IN_BIO.referenceSlots as Record<string, unknown>;
  assert.ok(validateSlots(LINK_IN_BIO, rest).length > 0);
});

test('link-in-bio reference goldens bind only bindable testids', () => {
  const { exact, prefixes } = LINK_IN_BIO.bindableTestids(LINK_IN_BIO.referenceSlots);
  const ok = (tid: string) => exact.includes(tid) || prefixes.some((p) => tid.startsWith(p));
  for (const g of LINK_IN_BIO.referenceGoldens.goldens) {
    for (const e of g.expect) {
      if ('testid' in e) assert.ok(ok(e.testid), e.testid);
    }
  }
});

test('"avatar" is census-gated: absent by default, present only when avatarDataUrl is set', () => {
  assert.equal(LINK_IN_BIO.elementContract(LINK_IN_BIO.referenceSlots).includes('avatar'), false);
  const withAvatar = {
    ...LINK_IN_BIO.referenceSlots,
    avatarDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  };
  assert.ok(LINK_IN_BIO.elementContract(withAvatar).includes('avatar'));
  const html = LINK_IN_BIO.render(withAvatar, refCtx())['/index.html'].content;
  assert.match(html, /data-testid="avatar"/);
});

test('rejects an avatarDataUrl that is not a data:image/ URI', () => {
  const slots = { ...LINK_IN_BIO.referenceSlots, avatarDataUrl: 'https://example.com/avatar.png' };
  assert.ok(validateSlots(LINK_IN_BIO, slots).length > 0);
});

test('rejects a link url that is not http(s)/mailto', () => {
  const slots = { ...LINK_IN_BIO.referenceSlots, links: [{ label: 'Bad', url: 'ftp://x' }] };
  assert.ok(validateSlots(LINK_IN_BIO, slots).length > 0);
});

test('rejects an unknown social network and duplicate networks', () => {
  const unknown = {
    ...LINK_IN_BIO.referenceSlots,
    socials: [{ network: 'myspace', url: 'https://myspace.com/x' }],
  };
  assert.ok(validateSlots(LINK_IN_BIO, unknown).length > 0);

  const dup = {
    ...LINK_IN_BIO.referenceSlots,
    socials: [
      { network: 'github', url: 'https://github.com/a' },
      { network: 'github', url: 'https://github.com/b' },
    ],
  };
  assert.ok(validateSlots(LINK_IN_BIO, dup).length > 0);
});

test('rejects a social url that is not https', () => {
  const slots = {
    ...LINK_IN_BIO.referenceSlots,
    socials: [{ network: 'github', url: 'http://github.com/x' }],
  };
  assert.ok(validateSlots(LINK_IN_BIO, slots).length > 0);
});

test('"social-<network>" testids are generated per declared social entry', () => {
  const census = LINK_IN_BIO.elementContract(LINK_IN_BIO.referenceSlots);
  assert.ok(census.includes('social-github'));
  assert.ok(census.includes('social-x'));
});

test('rendered HTML carries no <script> tag — link-in-bio is fully static', () => {
  const { files, html } = renderReference(LINK_IN_BIO);
  assert.equal(files['/app.js'], undefined);
  assert.equal(html.includes('<script'), false);
});

test('OG meta tags render from ogTitle/ogDescription', () => {
  const { html } = renderReference(LINK_IN_BIO);
  assert.match(html, /<meta property="og:title" content="Jordan Lane — links">/);
  assert.match(html, /<meta property="og:description"/);
});
