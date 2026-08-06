import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ensurePotraceReady } from './wasm.js';

// Reproduces the Cloudflare Workers (nodejs_compat) global surface that
// killed the vector stage live — twice — on contract 01KZBQE99RPWQ33Q9KK6JK2XHM
// (2026-08-06). potrace's Emscripten glue probes its host at import time:
//
//   1. No `__filename` + a WorkerGlobalScope → it reads `self.location.href`.
//      Workers expose WorkerGlobalScope and `self` but no `location` →
//      `TypeError: Cannot read properties of undefined (reading 'href')`.
//   2. `process.versions.node` set and `process.type != "renderer"` → it takes
//      its NODE branch: `require("node:fs")` succeeds (nodejs_compat provides
//      a global require) but bare `__dirname` does not exist in the bundle →
//      `ReferenceError: __dirname is not defined`. The first version of this
//      test forced `process.type = 'renderer'` to keep the glue off that
//      branch — faithfully reproducing crash 1 while masking crash 2.
//
// So the simulation here matches the REAL runtime: WorkerGlobalScope + self,
// no location, no __dirname, a global `require`, and process left untouched
// (Node's own `process.versions.node` plays the part of nodejs_compat's).
//
// This file must be the process's FIRST importer of esm-potrace-wasm (module
// bodies run once per process), so it deliberately does NOT import
// wasm.node.ts / testSupport.ts — their CJS-global shims (`__filename` etc.)
// would steer the glue away from the Workers path. Each test FILE runs in its
// own process under `tsx --test`, so this isolation holds regardless of suite
// order.

interface MutableGlobals {
  WorkerGlobalScope?: unknown;
  self?: unknown;
  location?: unknown;
  require?: unknown;
  __dirname?: unknown;
}
const g = globalThis as unknown as MutableGlobals;

// --- Simulate the Workers host, before anything touches potrace -------------
assert.equal(typeof (globalThis as { __filename?: string }).__filename, 'undefined');
assert.equal(typeof g.__dirname, 'undefined');
g.WorkerGlobalScope = class WorkerGlobalScope {};
g.self = globalThis;
delete g.location;
g.require = createRequire(import.meta.url);

after(() => {
  delete g.WorkerGlobalScope;
  delete g.self;
  delete g.require;
});

describe('ensurePotraceReady under the Workers nodejs_compat global surface', () => {
  it('initializes despite the runtime having no `location` or `__dirname`', async () => {
    await assert.doesNotReject(ensurePotraceReady());
  });

  it('does not leave the shims behind', async () => {
    await ensurePotraceReady();
    assert.equal('location' in globalThis, false);
    assert.equal('__dirname' in globalThis, false);
  });
});
