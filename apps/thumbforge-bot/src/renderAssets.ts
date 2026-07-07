// ---------------------------------------------------------------------------
// Worker-only render assets: the Inter TTFs bundled as bytes and the resvg +
// mozjpeg wasm bundled as WebAssembly.Modules (§7). NEVER import this from
// test-imported modules — the `.ttf`/`.wasm` imports resolve only under
// wrangler/esbuild; Node tests use fonts/node.ts + render/wasm.node.ts instead.
//
// The wasm is compiled once per isolate by the render core's memoized
// ensureResvgReady/ensureJpegReady — here we just hand it the bundled Modules.
// ---------------------------------------------------------------------------

import interRegular from './fonts/Inter-Regular.ttf';
import interBold from './fonts/Inter-Bold.ttf';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import mozjpegWasm from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm';
import { createFontSet, type FontSet } from './fonts/index.js';
import type { WasmSources } from './render/wasm.js';

/** The bundled Inter Regular + Bold font set (no runtime font egress, FR-1). */
export function workerFonts(): FontSet {
  return createFontSet(interRegular, interBold);
}

/** Bundled resvg + mozjpeg wasm modules as injectable render sources. */
export function workerWasmSources(): WasmSources {
  return {
    resvg: () => resvgWasm,
    jpeg: () => mozjpegWasm,
  };
}
