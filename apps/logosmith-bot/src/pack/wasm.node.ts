// Node-only wasm sources for tests + local dev: read the resvg `.wasm` bytes
// from node_modules and compile them. NEVER import this from Worker code —
// the Worker passes its own bundled `.wasm` imports as sources.
//
// esm-potrace-wasm ships no separate `.wasm` file (its wasm is embedded in
// dist/index.js as inline bytes) — but deployed Workers ban compiling wasm
// from bytes, so `src/pack/potrace.wasm` holds the extracted module and
// `ensurePotraceReady(source)` injects it via the patched glue's hook (see
// ./wasm.ts and patches/esm-potrace-wasm.patch). The `potrace` source below
// compiles that same file so Node runs the identical injected-module path.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { WasmSources } from './wasm.js';

const require = createRequire(import.meta.url);

async function compile(specifier: string): Promise<WebAssembly.Module> {
  return WebAssembly.compile(await readFile(require.resolve(specifier)));
}

// ---------------------------------------------------------------------------
// esm-potrace-wasm@0.5.0's dist/index.js is Emscripten "MODULARIZE" glue
// mislabelled as an ESM build: its Node-detection branch unconditionally
// reads bare `require`, `__dirname`, `__filename`, and `module` — real Node
// CJS globals that a genuine ES module does not have. Confirmed by direct
// experiment (see task-3 report): a plain `import('esm-potrace-wasm')` under
// Node throws `ReferenceError: require is not defined in ES module scope`
// before any of our code runs; after shimming `require` the same import then
// throws `ReferenceError: __dirname is not defined`. Since an unqualified
// identifier falls back to a `globalThis` property lookup, installing all
// four names on `globalThis` — pointed at the package's real dist/index.js,
// exactly as Node's own CJS loader would — lets that branch run to
// completion; confirmed end-to-end that `init()` then resolves.
//
// This is a workaround for an upstream packaging bug in esm-potrace-wasm, not
// a design choice — delete it if a future release ships a real ESM build.
// It lives here (not in ./wasm.ts) because it is inherently Node-only:
// `wasm.ts` must stay runtime-agnostic for the Worker, which never imports
// this file. Whether the Workers bundler needs an equivalent shim is
// unverified and out of scope here — nodeWasmSources() (this function) is
// never called from Worker code, only from Node tests / local dev.
// ---------------------------------------------------------------------------
function shimPotraceCommonJsGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  const entryPoint = require.resolve('esm-potrace-wasm');
  g.require ??= require;
  g.__filename ??= entryPoint;
  g.__dirname ??= dirname(entryPoint);
  g.module ??= { exports: {} };
}

/** Wasm sources that resolve the pack engine's `.wasm` files from node_modules. */
export function nodeWasmSources(): WasmSources {
  // Run eagerly (not lazily inside ensurePotraceReady, which never calls this
  // source — see ./wasm.ts) so any Node caller who later calls
  // ensurePotraceReady() already has the globals it needs, without having to
  // remember an extra setup step of their own.
  shimPotraceCommonJsGlobals();
  return {
    resvg: () => compile('@resvg/resvg-wasm/index_bg.wasm'),
    // The wasm extracted from the package's inline bytes (deployed Workers
    // ban compile-from-bytes, so production injects this file as a bundled
    // module — see ensurePotraceReady). Compiling the same file here means
    // Node tests exercise the identical injected-module path.
    potrace: async () =>
      WebAssembly.compile(await readFile(new URL('./potrace.wasm', import.meta.url))),
  };
}
