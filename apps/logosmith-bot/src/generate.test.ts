import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGenerator } from './generate.js';
import { IMAGE_COST_USD } from './config.js';
import type { StyleAxis } from './types.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const ideogramAxis: StyleAxis = { id: 'wordmark', label: 'w', prompt: 'p', vendor: 'ideogram' };
const recraftAxis: StyleAxis = { id: 'emblem', label: 'e', prompt: 'p', vendor: 'recraft' };
const fluxAxis: StyleAxis = { id: 'taster', label: 't', prompt: 'p', vendor: 'flux' };

const imageResponse = async (): Promise<Response> =>
  new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });

function fetchStub(handlers: Record<string, () => Promise<Response>>) {
  return async (url: string): Promise<Response> => {
    for (const [fragment, handler] of Object.entries(handlers)) {
      if (url.includes(fragment)) return handler();
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const noAi = { run: async () => ({}) };

describe('generate', () => {
  it('returns PNG bytes and the vendor request id for Ideogram', async () => {
    const generator = createGenerator({
      fetchImpl: fetchStub({
        // `created` is an ISO timestamp per the verified-live shape, NOT the
        // request id — the id only ever comes from the `x-request-id` response
        // header. Both are set here, to distinct values, so the assertion below
        // can only pass by reading the header.
        'ideogram.ai': async () =>
          new Response(
            JSON.stringify({
              created: '2026-07-30T12:00:00Z',
              data: [{ url: 'https://cdn/x.png' }],
            }),
            { status: 200, headers: { 'x-request-id': 'req-9' } },
          ),
        cdn: imageResponse,
      }),
      ai: noAi,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(ideogramAxis, 'a mark for Acme');
    assert.ok(result.ok);
    assert.equal(result.concept.vendor, 'ideogram');
    assert.equal(result.concept.vendorRequestId, 'req-9');
    assert.deepEqual([...result.concept.png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.ok(result.costUsd > 0);
  });

  // Recraft's response shape below is NOT verified against a live API — no key
  // was obtainable this session (its Generate button is gated behind a prepaid
  // API-units balance). Every Recraft test in this file asserts only that OUR
  // adapter handles the documented shape correctly; a green run here proves
  // our branch logic is self-consistent, NOT that Recraft actually returns
  // this shape. Do not read passing tests as vendor confirmation.
  it('captures Recraft native SVG when the vendor returns one', async () => {
    const generator = createGenerator({
      fetchImpl: fetchStub({
        'recraft.ai': async () =>
          new Response(
            JSON.stringify({ id: 'rc-1', data: [{ url: 'https://cdn/x.svg', image_id: 'rc-1' }] }),
            { status: 200 },
          ),
        'cdn/x.svg': async () =>
          new Response('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>', {
            status: 200,
            headers: { 'Content-Type': 'image/svg+xml' },
          }),
      }),
      ai: noAi,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(recraftAxis, 'an emblem for Acme');
    assert.ok(result.ok);
    assert.match(result.concept.nativeSvg ?? '', /<svg/);
    // Task 18 rasterizes the sanitized SVG at 1024px for the OCR/pHash gates —
    // it decides to do that by checking for exactly this empty-png signal.
    assert.equal(result.concept.png.length, 0);
  });

  it('returns a plain PNG when Recraft returns a raster instead of SVG', async () => {
    const generator = createGenerator({
      fetchImpl: fetchStub({
        'recraft.ai': async () =>
          new Response(
            JSON.stringify({ id: 'rc-2', data: [{ url: 'https://cdn/x.png', image_id: 'rc-2' }] }),
            { status: 200 },
          ),
        cdn: imageResponse,
      }),
      ai: noAi,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(recraftAxis, 'an emblem for Acme');
    assert.ok(result.ok);
    assert.equal(result.concept.nativeSvg, undefined);
    assert.deepEqual([...result.concept.png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(result.concept.vendorRequestId, 'rc-2');
    assert.equal(result.costUsd, IMAGE_COST_USD.recraft);
  });

  it('rejects Recraft bytes that are neither PNG nor SVG', async () => {
    const generator = createGenerator({
      fetchImpl: fetchStub({
        'recraft.ai': async () =>
          new Response(
            JSON.stringify({ id: 'rc-3', data: [{ url: 'https://cdn/x.bin', image_id: 'rc-3' }] }),
            { status: 200 },
          ),
        cdn: async () => new Response('not an image', { status: 200 }),
      }),
      ai: noAi,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(recraftAxis, 'an emblem for Acme');
    assert.ok(!result.ok && result.retryable);
  });

  it('marks a Recraft 429/5xx as retryable and a 400 as not', async () => {
    const make = (status: number) =>
      createGenerator({
        fetchImpl: fetchStub({ 'recraft.ai': async () => new Response('no', { status }) }),
        ai: noAi,
        ideogramApiKey: 'i',
        recraftApiKey: 'r',
      });
    const rateLimited = await make(429).generate(recraftAxis, 'p');
    const serverError = await make(500).generate(recraftAxis, 'p');
    const badRequest = await make(400).generate(recraftAxis, 'p');
    assert.ok(!rateLimited.ok && rateLimited.retryable);
    assert.ok(!serverError.ok && serverError.retryable);
    assert.ok(!badRequest.ok && !badRequest.retryable);
  });

  it('routes the flux axis through the Workers AI binding, not fetch', async () => {
    let called = false;
    const generator = createGenerator({
      fetchImpl: async () => {
        throw new Error('fetch must not be used for flux');
      },
      ai: {
        run: async () => {
          called = true;
          return { image: Buffer.from(PNG).toString('base64') };
        },
      },
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(fluxAxis, 'a taster for Acme');
    assert.ok(result.ok);
    assert.ok(called);
    assert.equal(result.concept.vendor, 'flux');
  });

  it('marks a 429 as retryable and a 400 as not', async () => {
    const make = (status: number) =>
      createGenerator({
        fetchImpl: fetchStub({ 'ideogram.ai': async () => new Response('no', { status }) }),
        ai: noAi,
        ideogramApiKey: 'i',
        recraftApiKey: 'r',
      });
    const rateLimited = await make(429).generate(ideogramAxis, 'p');
    const badRequest = await make(400).generate(ideogramAxis, 'p');
    assert.ok(!rateLimited.ok && rateLimited.retryable);
    assert.ok(!badRequest.ok && !badRequest.retryable);
  });

  it('reports a network throw as a retryable failure, never a throw', async () => {
    const generator = createGenerator({
      fetchImpl: async () => {
        throw new Error('socket hang up');
      },
      ai: noAi,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(ideogramAxis, 'p');
    assert.ok(!result.ok && result.retryable);
  });

  it('rejects a response whose bytes are not a PNG', async () => {
    const generator = createGenerator({
      fetchImpl: fetchStub({
        'ideogram.ai': async () =>
          new Response(JSON.stringify({ created: 'r', data: [{ url: 'https://cdn/x' }] }), {
            status: 200,
          }),
        cdn: async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
      }),
      ai: noAi,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(ideogramAxis, 'p');
    assert.ok(!result.ok);
  });

  it('returns ok:false when Workers AI returns no image field', async () => {
    const generator = createGenerator({
      fetchImpl: async () => {
        throw new Error('fetch must not be used for flux');
      },
      ai: { run: async () => ({}) },
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(fluxAxis, 'a taster for Acme');
    assert.ok(!result.ok && result.retryable);
  });

  it('returns ok:false when the Workers AI image is not a valid PNG', async () => {
    const generator = createGenerator({
      fetchImpl: async () => {
        throw new Error('fetch must not be used for flux');
      },
      ai: { run: async () => ({ image: Buffer.from([1, 2, 3, 4]).toString('base64') }) },
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(fluxAxis, 'a taster for Acme');
    assert.ok(!result.ok && result.retryable);
  });

  it('reports an ai.run throw as a retryable failure, never a throw', async () => {
    const generator = createGenerator({
      fetchImpl: async () => {
        throw new Error('fetch must not be used for flux');
      },
      ai: {
        run: async () => {
          throw new Error('workers ai unavailable');
        },
      },
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(fluxAxis, 'a taster for Acme');
    assert.ok(!result.ok && result.retryable);
  });
});
