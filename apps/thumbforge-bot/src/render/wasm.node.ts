// Node-only wasm sources for tests + local dev: read the resvg and mozjpeg
// `.wasm` bytes from node_modules and compile them. NEVER import this from
// Worker code — the Worker passes its own bundled `.wasm` imports as sources.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { WasmSources } from './wasm.js';

const require = createRequire(import.meta.url);

async function compile(specifier: string): Promise<WebAssembly.Module> {
  return WebAssembly.compile(await readFile(require.resolve(specifier)));
}

/** Wasm sources that resolve the render engine's `.wasm` files from node_modules. */
export function nodeWasmSources(): WasmSources {
  return {
    resvg: () => compile('@resvg/resvg-wasm/index_bg.wasm'),
    jpeg: () => compile('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'),
  };
}
