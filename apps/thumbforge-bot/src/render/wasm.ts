// ---------------------------------------------------------------------------
// Lazy, once-per-isolate wasm initialization for the render stack (PRD §7).
//
// Both resvg and mozjpeg expose a global "init this module" call that must run
// exactly once per isolate. We memoize the init promise at module scope so the
// first render pays the cost and every later render (and concurrent callers)
// awaits the same promise. The actual wasm bytes are injected as a source
// callback — Node reads them off disk (./wasm.node.ts), the Worker passes its
// bundled `.wasm` imports — so this module stays runtime-agnostic.
// ---------------------------------------------------------------------------

import { initWasm, type InitInput } from '@resvg/resvg-wasm';
import { init as initJpegWasmRaw } from '@jsquash/jpeg/encode.js';

// The published @jsquash types omit the WebAssembly.Module overload the runtime
// accepts (see @jsquash/jpeg/encode.js). Re-type it to the real signature.
const initJpegWasm = initJpegWasmRaw as unknown as (module: WebAssembly.Module) => Promise<void>;

export type ResvgWasmSource = () => Promise<InitInput> | InitInput;
export type JpegWasmSource = () => Promise<WebAssembly.Module> | WebAssembly.Module;

export interface WasmSources {
  resvg: ResvgWasmSource;
  jpeg: JpegWasmSource;
}

let resvgReady: Promise<void> | undefined;

/** Initialize resvg-wasm once per isolate; later calls await the same promise. */
export function ensureResvgReady(source: ResvgWasmSource): Promise<void> {
  resvgReady ??= Promise.resolve(source()).then((input) => initWasm(input));
  return resvgReady;
}

let jpegReady: Promise<void> | undefined;

/** Initialize the mozjpeg encoder wasm once per isolate. */
export function ensureJpegReady(source: JpegWasmSource): Promise<void> {
  jpegReady ??= Promise.resolve(source()).then((module) => initJpegWasm(module));
  return jpegReady;
}
