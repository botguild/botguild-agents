// resvg rendering (FR-11). Every favicon and master PNG is rendered from the
// vector at its exact target size — never produced by resizing a larger raster,
// which is what makes the 16px favicon legible instead of mush.

import { Resvg } from '@resvg/resvg-wasm';
import type { Pixmap } from '../types.js';
import { ensureResvgReady, type WasmSources } from './wasm.js';

/**
 * Render an SVG to a decoded RGBA pixmap at `size`x`size`.
 *
 * §12 specifies pixmap work releasing buffers between artifacts as the thing
 * that keeps this under the 128 MB isolate ceiling — resvg-wasm is a
 * wasm-bindgen build, so both the `Resvg` parse/render handle and its
 * `RenderedImage` result own wasm linear memory until `.free()`d; nothing
 * reclaims it otherwise (WebAssembly.Memory only grows, so an unfreed
 * instance's high-water mark is permanent for the isolate's life, and even a
 * FinalizationRegistry-based safety net is not guaranteed to run promptly).
 * `.free()` runs in `finally` blocks — inner (RenderedImage) before outer
 * (Resvg) — so it fires even when render/extraction throws. The pixel bytes
 * are copied out via `new Uint8Array(rendered.pixels)` *before* freeing:
 * that constructor overload (source is a TypedArray, not an ArrayBuffer)
 * always allocates a fresh backing buffer and copies element values, so the
 * returned `Uint8Array` never aliases wasm memory and stays valid after
 * `rendered.free()` — verified in render.test.ts by freeing and rendering
 * again, then confirming the first result's bytes are unchanged.
 */
export async function renderSvgToPixmap(
  svg: string,
  size: number,
  sources: WasmSources,
): Promise<Pixmap> {
  await ensureResvgReady(sources.resvg);
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  try {
    const rendered = resvg.render();
    try {
      return {
        width: rendered.width,
        height: rendered.height,
        data: new Uint8Array(rendered.pixels),
      };
    } finally {
      rendered.free();
    }
  } finally {
    resvg.free();
  }
}

/**
 * Render an SVG to encoded PNG bytes at `size`x`size`. Same free-in-finally
 * discipline as `renderSvgToPixmap` above, and for the same reason: `asPng()`
 * returns a `Uint8Array`, and wrapping it in `new Uint8Array(...)` copies it
 * into a fresh buffer before `rendered`/`resvg` are freed, so the bytes we
 * return never alias memory that a later render call could reuse or grow
 * over.
 */
export async function renderSvgToPng(
  svg: string,
  size: number,
  sources: WasmSources,
): Promise<Uint8Array> {
  await ensureResvgReady(sources.resvg);
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  try {
    const rendered = resvg.render();
    try {
      return new Uint8Array(rendered.asPng());
    } finally {
      rendered.free();
    }
  } finally {
    resvg.free();
  }
}
