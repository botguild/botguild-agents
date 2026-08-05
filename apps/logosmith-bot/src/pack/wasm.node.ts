// Node-only wasm sources for tests + local dev: read the resvg `.wasm` bytes
// from node_modules and compile them. NEVER import this from Worker code —
// the Worker passes its own bundled `.wasm` imports as sources.
//
// esm-potrace-wasm has no separate `.wasm` file to resolve (verified: its
// `dist/` directory ships only `index.js` + `index.d.ts` — the wasm is
// embedded in the JS bundle, and `init()` takes no argument). The `potrace`
// source below is therefore a documented stub: `ensurePotraceReady` (in
// ./wasm.ts) never calls it, so it exists only to satisfy the `WasmSources`
// shape and fails loudly if that ever changes.

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
    potrace: () => {
      throw new Error(
        'esm-potrace-wasm embeds its wasm bytes — there is no potrace.wasm file to ' +
          'compile, and ensurePotraceReady() never calls this source.',
      );
    },
  };
}
