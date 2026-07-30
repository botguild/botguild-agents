import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFontPairing } from './fonts.js';

const apiPayload = {
  items: [
    { family: 'Inter', category: 'sans-serif', variants: ['regular', '700'] },
    { family: 'Fraunces', category: 'serif', variants: ['regular'] },
    { family: 'Comic Relief', category: 'display', variants: ['regular'] },
  ],
};

const okFetch = async (): Promise<Response> =>
  new Response(JSON.stringify(apiPayload), { status: 200 });

describe('fetchFontPairing', () => {
  it('returns a heading and body family with a licence pointer, not a claim', async () => {
    const pairing = await fetchFontPairing({ fetchImpl: okFetch, apiKey: 'k' });
    assert.ok(pairing.heading.family.length > 0);
    assert.ok(pairing.body.family.length > 0);
    // The API carries no licence field (verified live), so a dynamically
    // selected family must NOT assert a specific licence — it points at the
    // specimen page. Asserting OFL here would re-introduce the false claim.
    assert.match(pairing.heading.license, /specimen page/i);
    assert.ok(!/SIL Open Font License/.test(pairing.heading.license));
    assert.match(pairing.heading.url, /fonts\.google\.com/);
  });

  it('states the verified licence on the pinned fallback pairing', async () => {
    const pairing = await fetchFontPairing({
      fetchImpl: async () => new Response('nope', { status: 500 }),
      apiKey: 'k',
    });
    // Inter and Source Serif 4 were licence-verified at Phase 0, so the
    // fallback may name the licence where the dynamic path may not.
    assert.match(pairing.heading.license, /SIL Open Font License/);
  });

  it('labels the pairing advisory (§9: not a warranted property)', async () => {
    const pairing = await fetchFontPairing({ fetchImpl: okFetch, apiKey: 'k' });
    assert.match(pairing.note, /advisory/i);
  });

  it('falls back to the pinned default pairing when the API errors', async () => {
    const pairing = await fetchFontPairing({
      fetchImpl: async () => new Response('nope', { status: 500 }),
      apiKey: 'k',
    });
    assert.equal(pairing.heading.family, 'Inter');
    assert.match(pairing.note, /advisory/i);
  });

  it('falls back when the API is unreachable', async () => {
    const pairing = await fetchFontPairing({
      fetchImpl: async () => {
        throw new Error('network down');
      },
      apiKey: 'k',
    });
    assert.ok(pairing.heading.family.length > 0);
  });
});
