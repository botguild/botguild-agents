import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { type Env } from './index.js';

// --- Minimal fakes for the Worker's two bindings (DB, DISPATCH) ---------------
//
// The dispatch worker only ever calls `env.DB.prepare(sql).bind(slug).first()` and
// `env.DISPATCH.get(slug).fetch(request)`, so a hand-rolled pair of fakes exercises the
// full routing policy without pulling in miniflare.

function fakeDb(opts: { rows?: Record<string, { status: string }>; throwOnRead?: boolean }): {
  db: Env['DB'];
  reads: string[];
} {
  const reads: string[] = [];
  const db = {
    prepare(_sql: string) {
      return {
        bind(slug: string) {
          return {
            async first<T>(): Promise<T | null> {
              reads.push(slug);
              if (opts.throwOnRead) throw new Error('D1 read failed (simulated)');
              return ((opts.rows ?? {})[slug] ?? null) as T | null;
            },
          };
        },
      };
    },
  } as unknown as Env['DB'];
  return { db, reads };
}

function fakeDispatch(opts: { throwOnGet?: boolean } = {}): {
  dispatch: Env['DISPATCH'];
  fetched: string[];
} {
  const fetched: string[] = [];
  const dispatch = {
    get(slug: string) {
      return {
        async fetch(_request: Request): Promise<Response> {
          fetched.push(slug);
          if (opts.throwOnGet) throw new Error('script missing');
          return new Response(`served ${slug}`, { status: 200 });
        },
      };
    },
  } as unknown as Env['DISPATCH'];
  return { dispatch, fetched };
}

function req(host: string): Request {
  return new Request(`https://${host}/`);
}

const SUFFIX = 'jiffyapp.dev';

// --- Staging passthrough (no tools row) ---------------------------------------

test('stg- slug with NO tools row passes straight through, no-store + noindex', async () => {
  const { db } = fakeDb({ rows: {} });
  const { dispatch, fetched } = fakeDispatch();
  const res = await worker.fetch(req('stg-abc123.jiffyapp.dev'), {
    DB: db,
    DISPATCH: dispatch,
    TOOL_HOST_SUFFIX: SUFFIX,
  });

  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'served stg-abc123');
  assert.deepEqual(fetched, ['stg-abc123']);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('X-Robots-Tag'), 'noindex');
});

// --- Defense-in-depth: a stg- slug that DOES have a tools row is status-gated ---

test('stg- slug WITH a killed tools row is 410 (status gate, NOT passthrough)', async () => {
  const { db } = fakeDb({ rows: { 'stg-evil': { status: 'killed' } } });
  const { dispatch, fetched } = fakeDispatch();
  const res = await worker.fetch(req('stg-evil.jiffyapp.dev'), {
    DB: db,
    DISPATCH: dispatch,
    TOOL_HOST_SUFFIX: SUFFIX,
  });

  assert.equal(res.status, 410);
  // Never routed to the namespace — the kill switch held.
  assert.deepEqual(fetched, []);
});

test('stg- slug WITH a live tools row serves via the status gate', async () => {
  const { db } = fakeDb({ rows: { 'stg-live': { status: 'live' } } });
  const { dispatch, fetched } = fakeDispatch();
  const res = await worker.fetch(req('stg-live.jiffyapp.dev'), {
    DB: db,
    DISPATCH: dispatch,
    TOOL_HOST_SUFFIX: SUFFIX,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(fetched, ['stg-live']);
});

// --- Normal path still works --------------------------------------------------

test('a normal live slug serves', async () => {
  const { db } = fakeDb({ rows: { 'acme-rates': { status: 'live' } } });
  const { dispatch, fetched } = fakeDispatch();
  const res = await worker.fetch(req('acme-rates.jiffyapp.dev'), {
    DB: db,
    DISPATCH: dispatch,
    TOOL_HOST_SUFFIX: SUFFIX,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(fetched, ['acme-rates']);
});

test('a suspended slug is 410', async () => {
  const { db } = fakeDb({ rows: { 'acme-rates': { status: 'suspended' } } });
  const { dispatch, fetched } = fakeDispatch();
  const res = await worker.fetch(req('acme-rates.jiffyapp.dev'), {
    DB: db,
    DISPATCH: dispatch,
    TOOL_HOST_SUFFIX: SUFFIX,
  });

  assert.equal(res.status, 410);
  assert.deepEqual(fetched, []);
});

// --- F5: a D1 read blip serves an honest 404, never a 500 ---------------------

test('a D1 read failure serves 404, not a 500 (F5)', async () => {
  const { db } = fakeDb({ throwOnRead: true });
  const { dispatch, fetched } = fakeDispatch();
  const res = await worker.fetch(req('acme-rates.jiffyapp.dev'), {
    DB: db,
    DISPATCH: dispatch,
    TOOL_HOST_SUFFIX: SUFFIX,
  });

  assert.equal(res.status, 404);
  assert.deepEqual(fetched, []);
});
