// ---------------------------------------------------------------------------
// Lazy, once-per-isolate wasm initialization for the pack stack (PRD §7).
//
// Adapted from apps/thumbforge-bot/src/render/wasm.ts. Both resvg and potrace
// expose a global "init this module" call that must run exactly once per
// isolate; we memoize the init promise at module scope so the first caller pays
// the cost and every later (and concurrent) caller awaits the same promise. The
// wasm bytes are injected as a source callback — Node reads them off disk
// (./wasm.node.ts), the Worker passes its bundled `.wasm` imports — so this
// module never references a runtime-specific API (no `node:*` imports here).
//
// Deviation from the plan (verified, not guessed): esm-potrace-wasm@0.5.0
// embeds its compiled wasm inside dist/index.js instead of shipping a separate
// `.wasm` file — `node_modules/esm-potrace-wasm/dist/` contains only
// `index.js` + `index.d.ts`, and the published `.d.ts` types `init` as
// `(): Promise<void>`, matching the README's `await init();` with no argument.
// There is nothing to compile or inject, so `ensurePotraceReady`'s `source`
// parameter is optional and unused — kept only so callers see the same shape
// as `ensureResvgReady` and `WasmSources` stays uniform between the two.
//
// The import below is dynamic, not static, and deliberately so: dist/index.js
// is Emscripten "MODULARIZE" glue mislabelled as an ESM build — its Node-
// detection branch unconditionally references bare `require`/`__dirname`/
// `__filename`/`module`, which don't exist in a real ES module. A *static*
// `import ... from 'esm-potrace-wasm'` at the top of this file throws
// `ReferenceError: require is not defined in ES module scope` the instant
// this module is loaded — which would break every resvg-only consumer
// (render.ts and its tests) too, since importing anything from this file
// forces the whole file to evaluate. Deferring to a dynamic import inside
// `ensurePotraceReady` means that reference is only ever touched by callers
// who actually need potrace. Making the reference itself succeed in Node is
// `wasm.node.ts`'s job (a Node-only CJS-global shim); see that module for the
// full story — this file stays runtime-agnostic on purpose.
// ---------------------------------------------------------------------------

import { initWasm, type InitInput } from '@resvg/resvg-wasm';

export type ResvgWasmSource = () => Promise<InitInput> | InitInput;
export type PotraceWasmSource = () => Promise<WebAssembly.Module> | WebAssembly.Module;

export interface WasmSources {
  resvg: ResvgWasmSource;
  potrace: PotraceWasmSource;
}

let resvgReady: Promise<void> | undefined;

/** Initialize resvg-wasm once per isolate; later calls await the same promise. */
export function ensureResvgReady(source: ResvgWasmSource): Promise<void> {
  resvgReady ??= Promise.resolve(source()).then((input) => initWasm(input));
  return resvgReady;
}

let potraceReady: Promise<void> | undefined;

/**
 * Initialize the potrace tracer wasm once per isolate.
 *
 * esm-potrace-wasm has no separate `.wasm` file to inject (see module header),
 * so `source` is accepted only for interface symmetry with `ensureResvgReady`
 * and is never called. The package itself is imported dynamically and lazily
 * — see module header — so this only touches potrace's module-scope code
 * when a caller actually asks for it.
 */
export function ensurePotraceReady(source?: PotraceWasmSource): Promise<void> {
  void source;
  potraceReady ??= importPotraceWithLocationShim().then((mod) => mod.init());
  return potraceReady;
}

/**
 * potrace's Emscripten glue probes its host at import time: seeing a
 * WorkerGlobalScope and no `__filename`, it reads `self.location.href` for
 * its own script URL — a value it only ever uses to locate a separate
 * `.wasm` file this build doesn't have (the wasm is inlined). Cloudflare
 * Workers expose WorkerGlobalScope but no `location`, so the module body
 * throws before `init()` exists — this dead-lettered a live vector stage
 * (contract 01KZBQE99RPWQ33Q9KK6JK2XHM, 2026-08-06). Lend the glue a
 * throwaway URL for the one import, and remove it after: `location` must not
 * leak into the isolate, where other libraries feature-detect browsers on it.
 */
async function importPotraceWithLocationShim(): Promise<typeof import('esm-potrace-wasm')> {
  const globals = globalThis as { location?: unknown };
  const needsShim = typeof globals.location === 'undefined';
  if (needsShim) globals.location = new URL('https://potrace-wasm.invalid/');
  try {
    return await import('esm-potrace-wasm');
  } finally {
    if (needsShim) delete globals.location;
  }
}
