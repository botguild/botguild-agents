import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensurePotraceReady } from './wasm.js';

// Reproduces the Cloudflare Workers global surface that killed the vector
// stage live (contract 01KZBQE99RPWQ33Q9KK6JK2XHM, 2026-08-06): potrace's
// Emscripten glue probes its host at import time — seeing a WorkerGlobalScope
// and no `__filename`, it reads `self.location.href` for its script URL.
// Workers expose WorkerGlobalScope and `self` but no `location`, so the
// module body throws `TypeError: Cannot read properties of undefined
// (reading 'href')` before `init()` even exists, and the pack build
// dead-letters after its retry budget.
//
// This file must be the process's FIRST importer of esm-potrace-wasm (module
// bodies run once per process), so it deliberately does NOT import
// wasm.node.ts / testSupport.ts — their CJS-global shims (`__filename` etc.)
// would steer the glue down the Node branch and mask the Workers path. Each
// test FILE runs in its own process under `tsx --test`, so this isolation
// holds regardless of suite order.

interface MutableGlobals {
  WorkerGlobalScope?: unknown;
  self?: unknown;
  location?: unknown;
}
const g = globalThis as unknown as MutableGlobals & { process: { type?: string } };

// --- Simulate the Workers host, before anything touches potrace -------------
assert.equal(typeof (globalThis as { __filename?: string }).__filename, 'undefined');
g.WorkerGlobalScope = class WorkerGlobalScope {};
g.self = globalThis;
delete g.location;
// Keep the glue off its Node branch the same way the real Workers runtime
// does not take it: the branch is gated on `process.type != "renderer"`.
g.process.type = 'renderer';

after(() => {
  delete g.WorkerGlobalScope;
  delete g.self;
  delete g.process.type;
});

describe('ensurePotraceReady under the Workers global surface', () => {
  it('initializes despite the runtime having no `location`', async () => {
    await assert.doesNotReject(ensurePotraceReady());
  });

  it('does not leave a location shim behind', async () => {
    await ensurePotraceReady();
    assert.equal('location' in globalThis, false);
  });
});
