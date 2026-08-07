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
// esm-potrace-wasm@0.5.0 embeds its compiled wasm inside dist/index.js as an
// inline byte string instead of shipping a separate `.wasm` file. Deployed
// Workers ban compiling wasm from bytes, so `src/pack/potrace.wasm` holds the
// extracted module (captured via an instantiate intercept in Node) and
// `ensurePotraceReady`'s `source` parameter — once a never-called
// shape-symmetry stub — now injects it through the hook added by
// patches/esm-potrace-wasm.patch. Node callers may still omit the source and
// use the package's inline bytes.
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
 * Initialize the potrace tracer wasm once per isolate. When a `source` is
 * provided (the Worker's bundled module; Node's compiled potrace.wasm), it is
 * injected through the patched glue's instantiation hook — required in
 * production, where compiling the package's inline bytes is banned. The
 * package is imported dynamically and lazily — see module header — so this
 * only touches potrace's module-scope code when a caller actually asks.
 */
export function ensurePotraceReady(source?: PotraceWasmSource): Promise<void> {
  potraceReady ??= initPotrace(source).catch((err: unknown) => {
    // A failed init must not poison the isolate forever — clear the memo so
    // the queue's retry (a later invocation, possibly after a deploy) can
    // try again instead of replaying a cached rejection.
    potraceReady = undefined;
    throw err;
  });
  return potraceReady;
}

/**
 * Initialize potrace, preferring a pre-compiled wasm module when a source is
 * provided. Deployed Workers PROHIBIT compiling wasm from bytes ("code
 * generation disallowed"), and the glue's inline-bytes compile is exactly
 * that — worse, its unpatched `init()` had no rejection path, so the failed
 * compile HUNG the vector stage until the 15-minute wall-time kill (observed
 * live, contract 01KZBQE99RPWQ33Q9KK6JK2XHM). patches/esm-potrace-wasm.patch
 * adds a `globalThis.__POTRACE_INSTANTIATE_WASM__` hook (honored before the
 * inline path) and an `onAbort` rejection; the Worker passes the bundled
 * `src/pack/potrace.wasm` module through `source`, while Node callers may
 * omit it and use the inline bytes as before.
 */
async function initPotrace(source?: PotraceWasmSource): Promise<void> {
  const globals = globalThis as { __POTRACE_INSTANTIATE_WASM__?: unknown };
  if (source) {
    const module = await source();
    globals.__POTRACE_INSTANTIATE_WASM__ = (
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance) => void,
    ): void => {
      // Instantiating a compiled module is the one wasm path Workers allow.
      // A rejection here surfaces via the init timeout below — the glue's
      // hook contract has no error callback.
      void WebAssembly.instantiate(module, imports).then(done);
    };
  }
  try {
    const mod = await importPotraceWithHostShims();
    // Belt and braces: the patched glue rejects on abort, but ANY future
    // silent-hang mode must still fail loudly rather than burn a 15-minute
    // wall-time kill with no log line.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        mod.init(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error('potrace init did not complete within 30s — treating as failed')),
            30_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    delete globals.__POTRACE_INSTANTIATE_WASM__;
  }
}

/**
 * potrace's Emscripten glue probes its host at import time, and Cloudflare
 * Workers (nodejs_compat) satisfy each probe just far enough to crash — this
 * dead-lettered a live vector stage twice (contract
 * 01KZBQE99RPWQ33Q9KK6JK2XHM, 2026-08-06):
 *
 *   1. No `__filename` + a WorkerGlobalScope → it reads `self.location.href`
 *      for its own script URL. Workers have no `location` → TypeError.
 *   2. `process.versions.node` present and `process.type != "renderer"` → it
 *      takes its Node branch, where `require("node:fs")` succeeds
 *      (nodejs_compat provides it) but bare `__dirname` doesn't exist in the
 *      bundle → ReferenceError.
 *
 * Both values are only ever used to locate a separate `.wasm` file this build
 * doesn't have (the wasm is inlined), so lend the glue throwaway stand-ins
 * for the one import and remove them after — neither `location` nor
 * `__dirname` may leak into the isolate, where other libraries feature-detect
 * their host on them.
 */
async function importPotraceWithHostShims(): Promise<typeof import('esm-potrace-wasm')> {
  const globals = globalThis as { location?: unknown; __dirname?: unknown };
  const needsLocation = typeof globals.location === 'undefined';
  const needsDirname = typeof globals.__dirname === 'undefined';
  if (needsLocation) globals.location = new URL('https://potrace-wasm.invalid/');
  if (needsDirname) globals.__dirname = '/';
  try {
    return await import('esm-potrace-wasm');
  } finally {
    if (needsLocation) delete globals.location;
    if (needsDirname) delete globals.__dirname;
  }
}
