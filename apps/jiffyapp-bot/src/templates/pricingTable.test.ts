import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICING_TABLE } from './pricingTable.js';
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

test('pricing-table reference render carries every contract testid', () => {
  const { html } = renderReference(PRICING_TABLE);
  for (const tid of PRICING_TABLE.elementContract(PRICING_TABLE.referenceSlots)) {
    assert.match(html, new RegExp(`data-testid="${tid}"`), tid);
  }
});

test('pricing-table escapes buyer copy', () => {
  const slots = { ...PRICING_TABLE.referenceSlots, headline: '<script>alert(1)</script>' };
  const files = PRICING_TABLE.render(slots, refCtx());
  assert.equal(files['/index.html'].content.includes('<script>alert(1)'), false);
  assert.match(files['/index.html'].content, /&lt;script&gt;/);
});

test('pricing-table reference slots validate; missing required slot fails', () => {
  assert.deepEqual(validateSlots(PRICING_TABLE, PRICING_TABLE.referenceSlots), []);
  const { headline: _drop, ...rest } = PRICING_TABLE.referenceSlots as Record<string, unknown>;
  assert.ok(validateSlots(PRICING_TABLE, rest).length > 0);
});

test('pricing-table reference goldens bind only bindable testids', () => {
  const { exact, prefixes } = PRICING_TABLE.bindableTestids(PRICING_TABLE.referenceSlots);
  const ok = (tid: string) => exact.includes(tid) || prefixes.some((p) => tid.startsWith(p));
  for (const g of PRICING_TABLE.referenceGoldens.goldens) {
    for (const e of g.expect) {
      if ('testid' in e) assert.ok(ok(e.testid), e.testid);
    }
  }
});

test('"highlight" is census-gated: present only when a plan is highlighted', () => {
  assert.ok(PRICING_TABLE.elementContract(PRICING_TABLE.referenceSlots).includes('highlight'));
  const noHighlight = {
    ...PRICING_TABLE.referenceSlots,
    plans: (PRICING_TABLE.referenceSlots.plans as Array<Record<string, unknown>>).map((p) => ({
      ...p,
      highlight: false,
    })),
  };
  assert.equal(PRICING_TABLE.elementContract(noHighlight).includes('highlight'), false);
  const html = PRICING_TABLE.render(noHighlight, refCtx())['/index.html'].content;
  assert.equal(html.includes('data-testid="highlight"'), false);
});

test('rejects plans with more than one highlight: true', () => {
  const slots = {
    ...PRICING_TABLE.referenceSlots,
    plans: (PRICING_TABLE.referenceSlots.plans as Array<Record<string, unknown>>).map((p) => ({
      ...p,
      highlight: true,
    })),
  };
  assert.ok(validateSlots(PRICING_TABLE, slots).length > 0);
});

test('rejects duplicate plan names (by normalized slug)', () => {
  const slots = {
    ...PRICING_TABLE.referenceSlots,
    plans: [
      {
        name: 'Pro',
        price: '$1',
        period: 'mo',
        ctaLabel: 'Go',
        ctaHref: 'https://x',
        highlight: false,
      },
      {
        name: 'pro',
        price: '$2',
        period: 'mo',
        ctaLabel: 'Go',
        ctaHref: 'https://x',
        highlight: false,
      },
    ],
  };
  assert.ok(validateSlots(PRICING_TABLE, slots).length > 0);
});

test('rejects a ctaHref that is not http(s)/mailto', () => {
  const slots = {
    ...PRICING_TABLE.referenceSlots,
    plans: [
      {
        name: 'Free',
        price: '$0',
        period: 'mo',
        ctaLabel: 'Go',
        ctaHref: 'ftp://x',
        highlight: false,
      },
    ],
  };
  assert.ok(validateSlots(PRICING_TABLE, slots).length > 0);
});

test('cross-slot validation rejects a feature row missing a cell for a declared plan', () => {
  const slots = {
    ...PRICING_TABLE.referenceSlots,
    featureMatrix: [{ feature: 'Seats', key: 'seats', cells: { Free: '1', Pro: '5' } }], // missing Team
  };
  assert.throws(() => PRICING_TABLE.render(slots, refCtx()));
});

test('rejects a duplicate or malformed featureMatrix key', () => {
  const dup = {
    ...PRICING_TABLE.referenceSlots,
    featureMatrix: [
      { feature: 'Seats', key: 'seats', cells: { Free: '1', Pro: '5', Team: 'Unlimited' } },
      { feature: 'Seats again', key: 'seats', cells: { Free: '1', Pro: '5', Team: 'Unlimited' } },
    ],
  };
  assert.ok(validateSlots(PRICING_TABLE, dup).length > 0);

  const badKey = {
    ...PRICING_TABLE.referenceSlots,
    featureMatrix: [
      { feature: 'Seats', key: 'Seats', cells: { Free: '1', Pro: '5', Team: 'Unlimited' } },
    ],
  };
  assert.ok(validateSlots(PRICING_TABLE, badKey).length > 0);
});

test('feature-<key>-<planSlug> testids use normalizeSlug on plan names', () => {
  const census = PRICING_TABLE.elementContract(PRICING_TABLE.referenceSlots);
  assert.ok(census.includes('feature-seats-free'));
  assert.ok(census.includes('feature-seats-pro'));
  assert.ok(census.includes('feature-seats-team'));
  assert.ok(census.includes('feature-support-pro'));
});

test('plan-price testid holds exactly the price string (no period suffix)', () => {
  const { html } = renderReference(PRICING_TABLE);
  assert.match(html, /<span class="amount" data-testid="plan-price">\$19<\/span>/);
});

test('rendered HTML carries no <script> tag — pricing-table is fully static', () => {
  const { files, html } = renderReference(PRICING_TABLE);
  assert.equal(files['/app.js'], undefined);
  assert.equal(html.includes('<script'), false);
});

test('featureMatrix of length 0 (no comparison rows) is allowed', () => {
  const slots = { ...PRICING_TABLE.referenceSlots, featureMatrix: [] };
  assert.deepEqual(validateSlots(PRICING_TABLE, slots), []);
  const files = PRICING_TABLE.render(slots, refCtx());
  assert.ok(files['/index.html'].content.length > 0);
});
