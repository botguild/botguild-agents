import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { createToolDeployer, DeployError, type DispatchLike } from './deploy.js';

const silentLogger = pino({ level: 'silent' });
const noSleep = async (): Promise<void> => {};

const ACCOUNT_ID = 'acct-123';
const NAMESPACE = 'jiffyapp-tools';
const API_TOKEN = 'test-token';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** Replays canned Response/throw results in order — one entry per expected fetchImpl call.
 *  `{ throw }` entries reject instead of resolving, exercising the network-failure path. */
function queueFetch(...items: Array<Response | { throw: Error }>): {
  fetchImpl: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const item = items[Math.min(i, items.length - 1)];
    i += 1;
    if (item && typeof item === 'object' && 'throw' in item) {
      throw (item as { throw: Error }).throw;
    }
    return item as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

function dispatchStub(fetchFn: (req: Request | string) => Promise<Response>): DispatchLike {
  return { get: () => ({ fetch: fetchFn }) };
}

// ---- putScript ----

test('putScript: PUT hits exact URL, Bearer header, multipart body with both parts', async () => {
  const { fetchImpl, calls } = queueFetch(textResponse('{}', 200));
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch: dispatchStub(async () => textResponse('', 200)),
    fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  await deployer.putScript('stg-abc', 'export default { fetch() {} };');

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/stg-abc`,
  );
  assert.equal(calls[0].init.method, 'PUT');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${API_TOKEN}`);

  const body = calls[0].init.body as FormData;
  const metadataPart = body.get('metadata') as Blob;
  assert.equal(metadataPart.type, 'application/json');
  const metadataJson = JSON.parse(await metadataPart.text()) as Record<string, unknown>;
  assert.equal(metadataJson.main_module, 'index.mjs');
  assert.equal(metadataJson.compatibility_date, '2026-06-01');

  const scriptPart = body.get('index.mjs') as File;
  assert.equal(scriptPart.name, 'index.mjs');
  assert.equal(scriptPart.type, 'application/javascript+module');
  assert.equal(await scriptPart.text(), 'export default { fetch() {} };');
});

test('putScript: 5xx then 2xx succeeds (2 calls)', async () => {
  const { fetchImpl, calls } = queueFetch(
    textResponse('server error', 500),
    textResponse('{}', 200),
  );
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch: dispatchStub(async () => textResponse('', 200)),
    fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  await deployer.putScript('stg-abc', 'script-body');

  assert.equal(calls.length, 2);
});

test('putScript: 5xx then 5xx throws DeployError with status + excerpt', async () => {
  const longBody = 'x'.repeat(300);
  const { fetchImpl, calls } = queueFetch(
    textResponse('server error', 500),
    textResponse(longBody, 500),
  );
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch: dispatchStub(async () => textResponse('', 200)),
    fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  await assert.rejects(
    () => deployer.putScript('stg-abc', 'script-body'),
    (err: unknown) => {
      assert.ok(err instanceof DeployError);
      assert.equal(err.status, 500);
      assert.equal(err.message.length, 200);
      assert.equal(err.message, longBody.slice(0, 200));
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test('putScript: 4xx throws immediately with no retry (1 call)', async () => {
  const { fetchImpl, calls } = queueFetch(textResponse('bad request', 400));
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch: dispatchStub(async () => textResponse('', 200)),
    fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  await assert.rejects(
    () => deployer.putScript('stg-abc', 'script-body'),
    (err: unknown) => {
      assert.ok(err instanceof DeployError);
      assert.equal(err.status, 400);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test('putScript: network throw then 2xx succeeds', async () => {
  const { fetchImpl, calls } = queueFetch(
    { throw: new Error('ECONNRESET') },
    textResponse('{}', 200),
  );
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch: dispatchStub(async () => textResponse('', 200)),
    fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  await deployer.putScript('stg-abc', 'script-body');
  assert.equal(calls.length, 2);
});

// ---- deleteScript ----

test('deleteScript: 404 tolerated (does not throw)', async () => {
  const { fetchImpl, calls } = queueFetch(textResponse('not found', 404));
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch: dispatchStub(async () => textResponse('', 200)),
    fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  await deployer.deleteScript('stg-abc');
  assert.equal(calls.length, 1);
});

test('deleteScript: 200 succeeds', async () => {
  const { fetchImpl } = queueFetch(textResponse('', 200));
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch: dispatchStub(async () => textResponse('', 200)),
    fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  await deployer.deleteScript('stg-abc');
});

test('deleteScript: 500 then 500 throws DeployError', async () => {
  const { fetchImpl, calls } = queueFetch(
    textResponse('server error', 500),
    textResponse('still broken', 500),
  );
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch: dispatchStub(async () => textResponse('', 200)),
    fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  await assert.rejects(
    () => deployer.deleteScript('stg-abc'),
    (err: unknown) => {
      assert.ok(err instanceof DeployError);
      assert.equal(err.status, 500);
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

// ---- checkServes ----

test('checkServes: 200 maps to ok true', async () => {
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch: dispatchStub(async () => textResponse('', 200)),
    fetchImpl: queueFetch(textResponse('{}', 200)).fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  const result = await deployer.checkServes('stg-abc');
  assert.deepEqual(result, { ok: true, status: 200 });
});

test('checkServes: 500 maps to { ok: false, status: 500 }', async () => {
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch: dispatchStub(async () => textResponse('', 500)),
    fetchImpl: queueFetch(textResponse('{}', 200)).fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  const result = await deployer.checkServes('stg-abc');
  assert.deepEqual(result, { ok: false, status: 500 });
});

test('checkServes: dispatch.get throwing (script absent) maps to { ok: false, status: 0 }', async () => {
  const dispatch: DispatchLike = {
    get: () => {
      throw new Error('Worker not found');
    },
  };
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch,
    fetchImpl: queueFetch(textResponse('{}', 200)).fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  const result = await deployer.checkServes('stg-abc');
  assert.deepEqual(result, { ok: false, status: 0 });
});

test('checkServes: fetch() throwing (script absent) maps to { ok: false, status: 0 }', async () => {
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch: dispatchStub(async () => {
      throw new Error('binding error: no such script');
    }),
    fetchImpl: queueFetch(textResponse('{}', 200)).fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  const result = await deployer.checkServes('stg-abc');
  assert.deepEqual(result, { ok: false, status: 0 });
});

// ---- slug URL-encoding ----

test('slug encoding: plain slug passes through unencoded', async () => {
  const { fetchImpl, calls } = queueFetch(textResponse('{}', 200));
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch: dispatchStub(async () => textResponse('', 200)),
    fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  await deployer.putScript('stg-abc', 'script-body');
  assert.ok(calls[0].url.endsWith('/scripts/stg-abc'));
});

test('slug encoding: hostile slug with a slash is percent-encoded', async () => {
  const { fetchImpl, calls } = queueFetch(textResponse('{}', 200));
  const deployer = createToolDeployer({
    accountId: ACCOUNT_ID,
    namespace: NAMESPACE,
    apiToken: API_TOKEN,
    dispatch: dispatchStub(async () => textResponse('', 200)),
    fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
  });

  await deployer.putScript('a/b', 'script-body');
  assert.ok(calls[0].url.endsWith('/scripts/a%2Fb'));
});
