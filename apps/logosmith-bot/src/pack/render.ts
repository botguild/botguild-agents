// resvg rendering (FR-11). Every favicon and master PNG is rendered from the
// vector at its exact target size — never produced by resizing a larger raster,
// which is what makes the 16px favicon legible instead of mush.

import { Resvg } from '@resvg/resvg-wasm';
import type { Pixmap } from '../types.js';
import { ensureResvgReady, type WasmSources } from './wasm.js';

/** Render an SVG to a decoded RGBA pixmap at `size`x`size`. */
export async function renderSvgToPixmap(
  svg: string,
  size: number,
  sources: WasmSources,
): Promise<Pixmap> {
  await ensureResvgReady(sources.resvg);
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const rendered = resvg.render();
  return {
    width: rendered.width,
    height: rendered.height,
    data: new Uint8Array(rendered.pixels),
  };
}

/** Render an SVG to encoded PNG bytes at `size`x`size`. */
export async function renderSvgToPng(
  svg: string,
  size: number,
  sources: WasmSources,
): Promise<Uint8Array> {
  await ensureResvgReady(sources.resvg);
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return new Uint8Array(resvg.render().asPng());
}
