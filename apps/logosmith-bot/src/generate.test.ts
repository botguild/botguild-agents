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
              data: [{ url: 'https://cdn/x.png', seed: 42 }],
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
    // Central stamping (generate.ts) and the vendor's own reproducibility field
    // — both load-bearing for every downstream consumer of Concept.
    assert.equal(result.concept.axisId, ideogramAxis.id);
    assert.equal(result.concept.seed, 42);
  });

  it('leaves concept.seed undefined when Ideogram omits it, without breaking anything else', async () => {
    const generator = createGenerator({
      fetchImpl: fetchStub({
        'ideogram.ai': async () =>
          new Response(
            JSON.stringify({
              created: '2026-07-30T12:05:00Z',
              data: [{ url: 'https://cdn/x.png' }],
            }),
            { status: 200, headers: { 'x-request-id': 'req-10' } },
          ),
        cdn: imageResponse,
      }),
      ai: noAi,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(ideogramAxis, 'a mark for Acme');
    assert.ok(result.ok);
    assert.equal(result.concept.seed, undefined);
    // A missing seed must not take anything else down with it.
    assert.equal(result.concept.vendor, 'ideogram');
    assert.equal(result.concept.vendorRequestId, 'req-10');
    assert.deepEqual([...result.concept.png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
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
    assert.equal(result.concept.axisId, recraftAxis.id);
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
    assert.equal(result.concept.axisId, fluxAxis.id);
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

// ---------------------------------------------------------------------------
// A FAILURE IS NOT AUTOMATICALLY A FREE FAILURE.
//
// Every branch below sits AFTER the vendor returned 200, i.e. after it ran the
// generation and billed for it. Because a retryable failure deliberately
// consumes no FR-5 attempt (Task 18 Ruling 1), `spendUsd` is the ONLY thing
// that can bound the park → unpark → regenerate → park loop these failures
// feed — and it can only bound spend it is told about. A missing `costUsd`
// here is 25 billed images reported to the buyer as $0.00.
//
// The pre-200 branches are asserted alongside, because `costUsd: 0` and
// `costUsd: undefined` mean different things and the difference is the point.
// ---------------------------------------------------------------------------
describe('generate — paid failures are visible to the spend ledger', () => {
  const ideogramOk = (url: string) => async () =>
    new Response(JSON.stringify({ created: 'ts', data: [{ url }] }), {
      status: 200,
      headers: { 'x-request-id': 'req-paid' },
    });
  const recraftOk = (url: string) => async () =>
    new Response(JSON.stringify({ id: 'rc-paid', data: [{ url }] }), { status: 200 });

  const make = (handlers: Record<string, () => Promise<Response>>, ai = noAi) =>
    createGenerator({
      fetchImpl: fetchStub(handlers),
      ai,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });

  it('bills an Ideogram response that carries no image url', async () => {
    const generator = createGenerator({
      fetchImpl: fetchStub({
        'ideogram.ai': async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      }),
      ai: noAi,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const result = await generator.generate(ideogramAxis, 'p');
    assert.ok(!result.ok);
    assert.equal(result.costUsd, IMAGE_COST_USD.ideogram);
  });

  it('bills an Ideogram generation whose asset link is dead', async () => {
    // The realistic shape: Ideogram's `data[0].url` is signed with a 24 h
    // expiry, so a slow queue, a DLQ replay or a CDN blip lands exactly here —
    // with the image already generated and paid for.
    const result = await make({
      'ideogram.ai': ideogramOk('https://cdn/x.png'),
      cdn: async () => new Response('gone', { status: 404 }),
    }).generate(ideogramAxis, 'p');
    assert.ok(!result.ok && result.retryable);
    assert.equal(result.costUsd, IMAGE_COST_USD.ideogram);
  });

  it('bills an Ideogram asset that is not a PNG', async () => {
    const result = await make({
      'ideogram.ai': ideogramOk('https://cdn/x.png'),
      cdn: async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    }).generate(ideogramAxis, 'p');
    assert.ok(!result.ok);
    assert.equal(result.costUsd, IMAGE_COST_USD.ideogram);
  });

  it('bills a Recraft response with no image url, a dead link, and an unusable asset', async () => {
    const noUrl = await make({
      'recraft.ai': async () => new Response(JSON.stringify({ id: 'rc' }), { status: 200 }),
    }).generate(recraftAxis, 'p');
    const deadLink = await make({
      'recraft.ai': recraftOk('https://cdn/x.png'),
      cdn: async () => new Response('gone', { status: 410 }),
    }).generate(recraftAxis, 'p');
    const notAnImage = await make({
      'recraft.ai': recraftOk('https://cdn/x.bin'),
      cdn: async () => new Response('not an image', { status: 200 }),
    }).generate(recraftAxis, 'p');

    for (const result of [noUrl, deadLink, notAnImage]) {
      assert.ok(!result.ok);
      assert.equal(result.costUsd, IMAGE_COST_USD.recraft);
    }
  });

  it('bills a Workers AI run that came back without a usable image', async () => {
    const noImage = await make({}, { run: async () => ({}) as Record<string, unknown> }).generate(
      fluxAxis,
      'p',
    );
    const notBase64 = await make({}, { run: async () => ({ image: '!!!not base64!!!' }) }).generate(
      fluxAxis,
      'p',
    );
    const notPng = await make(
      {
        // no fetch handlers: flux never touches fetch
      },
      { run: async () => ({ image: Buffer.from([1, 2, 3, 4]).toString('base64') }) },
    ).generate(fluxAxis, 'p');

    for (const result of [noImage, notBase64, notPng]) {
      assert.ok(!result.ok);
      assert.equal(result.costUsd, IMAGE_COST_USD.flux);
    }
  });

  it('leaves costUsd ABSENT when the vendor was never billed', async () => {
    // A non-200 status and a transport throw both mean the generation never
    // ran. `undefined` rather than 0, so the caller can tell "free failure"
    // from "billed $0.00" — they are different facts.
    const rejected = await make({
      'ideogram.ai': async () => new Response('no', { status: 400 }),
    }).generate(ideogramAxis, 'p');
    assert.ok(!rejected.ok);
    assert.equal(rejected.costUsd, undefined);

    const generator = createGenerator({
      fetchImpl: async () => {
        throw new Error('socket hang up');
      },
      ai: noAi,
      ideogramApiKey: 'i',
      recraftApiKey: 'r',
    });
    const dropped = await generator.generate(ideogramAxis, 'p');
    assert.ok(!dropped.ok);
    assert.equal(dropped.costUsd, undefined);
  });
});
