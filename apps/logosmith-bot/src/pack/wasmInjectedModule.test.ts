import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ensurePotraceReady } from './wasm.js';

// Deployed Cloudflare Workers PROHIBIT compiling WebAssembly from bytes
// ("Wasm code generation disallowed by embedder") — only statically bundled
// `WebAssembly.Module`s may be instantiated. esm-potrace-wasm compiles its
// INLINE byte-string at import time, and its `init()` promise has no
// rejection path (`onRuntimeInitialized` or nothing), so in production the
// vector stage neither completed nor failed: it hung until the 15-minute
// wall-time kill (`outcome=exceededWallTime`, observed live on contract
// 01KZBQE99RPWQ33Q9KK6JK2XHM, 2026-08-07). No log line, no tail event until
// the kill, no DLQ error — the worst possible failure shape.
//
// The fix has three parts, and this file proves them together end to end:
//   1. `patches/esm-potrace-wasm.patch` teaches the glue to use a
//      `globalThis.__POTRACE_INSTANTIATE_WASM__` hook (and to REJECT init()
//      via `onAbort` instead of hanging).
//   2. `src/pack/potrace.wasm` holds the extracted wasm (captured from the
//      package's own inline bytes via an instantiate intercept), bundled by
//      wrangler as a static CompiledWasm module.
//   3. `ensurePotraceReady(source)` finally USES its source parameter to
//      install the hook before importing the glue.
//
// The compile ban is simulated faithfully: WebAssembly.instantiate below
// throws for anything that isn't already a compiled WebAssembly.Module —
// so this test can only pass if potrace initializes through the injected
// module, never through its inline bytes.
//
// Like wasmWorkersEnv.test.ts, this file must be its process's first (and
// only) importer of esm-potrace-wasm, and simulates the Workers global
// surface itself rather than importing wasm.node.ts's Node shims.

interface MutableGlobals {
  WorkerGlobalScope?: unknown;
  self?: unknown;
  location?: unknown;
  require?: unknown;
}
const g = globalThis as unknown as MutableGlobals;

g.WorkerGlobalScope = class WorkerGlobalScope {};
g.self = globalThis;
delete g.location;
g.require = createRequire(import.meta.url);

const realInstantiate = WebAssembly.instantiate;
// Workers-faithful: instantiating a compiled module is allowed; compiling
// from bytes is not.
(WebAssembly as { instantiate: unknown }).instantiate = ((
  source: unknown,
  imports?: WebAssembly.Imports,
) => {
  if (source instanceof WebAssembly.Module) {
    return realInstantiate.call(WebAssembly, source, imports ?? {});
  }
  throw new CompileError('Wasm code generation disallowed by embedder (simulated)');
}) as typeof WebAssembly.instantiate;
const { CompileError } = WebAssembly;

after(() => {
  delete g.WorkerGlobalScope;
  delete g.self;
  delete g.require;
  (WebAssembly as { instantiate: unknown }).instantiate = realInstantiate;
});

const wasmPath = fileURLToPath(new URL('./potrace.wasm', import.meta.url));

describe('ensurePotraceReady with an injected wasm module under the compile ban', () => {
  it('initializes potrace through the bundled module', async () => {
    // Compile OUTSIDE the banned path, as wrangler's bundler does at build
    // time — the runtime only ever sees the finished Module.
    const module = await WebAssembly.compile(await readFile(wasmPath));
    await assert.doesNotReject(ensurePotraceReady(() => module));
  });

  it('leaves no injection hook behind', () => {
    assert.equal('__POTRACE_INSTANTIATE_WASM__' in globalThis, false);
  });
});
