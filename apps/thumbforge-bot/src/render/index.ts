// ---------------------------------------------------------------------------
// Render orchestration (PRD §5 FR-5, §7): layout element tree → Satori SVG →
// resvg RGBA pixmap + PNG, with a lazy `encode` that honors the 2MB ceiling and
// JPEG quality floor.
//
// `renderLayout` is the single call the wiring phase and the golden test use.
// It is Worker-safe: the wasm bytes and fonts are injected via `options`, so
// this module imports no Node or Workers globals.
// ---------------------------------------------------------------------------

import satori from 'satori';
import { Resvg } from '@resvg/resvg-wasm';
import type { FontSet } from '../fonts/index.js';
import type { DrawNode, LayoutDescriptor } from '../layouts/types.js';
import type { BrandKit, JobInputs, Pixmap, Rect } from '../types.js';
import { encodeJpeg } from './jpeg.js';
import { ensureResvgReady, type WasmSources } from './wasm.js';
import {
  DEFAULT_JPEG_QUALITY_FLOOR,
  MAX_FILE_BYTES,
  type EncodeOptions,
  type EncodeResult,
} from './encodeTypes.js';

export * from './encodeTypes.js';
export { ensureResvgReady, ensureJpegReady, type WasmSources } from './wasm.js';
export { encodeJpeg, encodeJpegPure } from './jpeg.js';

export interface RenderInputs {
  brandKit: BrandKit;
  job: JobInputs;
}

export interface RenderOptions {
  fonts: FontSet;
  wasm: WasmSources;
}

export interface RenderOutput {
  templateId: string;
  /** Decoded RGBA pixmap — the input to every pixel-sampling gate. */
  pixmap: Pixmap;
  /** Lossless PNG of the render (the preferred delivery format). */
  png: Uint8Array;
  /** The intermediate SVG (useful for debugging / golden diffing). */
  svg: string;
  /** Final headline font size actually used (FR-6 gate input). */
  headlineFontPx: number;
  /** False when the headline could not fit at or above the floor (FR-6). */
  headlineFits: boolean;
  logoRect: Rect;
  drawOrder: DrawNode[];
  /** Encode to the smallest compliant buffer: PNG if ≤ ceiling, else JPEG ≥ floor. */
  encode(options?: EncodeOptions): Promise<EncodeResult>;
}

/** JPEG qualities to try (descending); the floor is always the last attempt. */
function jpegQualityLadder(floor: number): number[] {
  const ladder = [92, 86, 80, 74].filter((q) => q > floor);
  ladder.push(floor);
  return ladder;
}

async function encodeBest(
  pixmap: Pixmap,
  png: Uint8Array,
  jpegWasm: WasmSources['jpeg'],
  options?: EncodeOptions,
): Promise<EncodeResult> {
  const maxBytes = options?.maxBytes ?? MAX_FILE_BYTES;
  const floor = options?.jpegQualityFloor ?? DEFAULT_JPEG_QUALITY_FLOOR;

  // PNG is lossless and preferred; its only size knob is re-compose (§9).
  if (png.length <= maxBytes) {
    return { bytes: png, format: 'png', byteLength: png.length };
  }

  // JPEG: highest quality (down to the floor) that fits. Never below the floor —
  // if even the floor overflows, return it and let the file-size gate signal a
  // re-compose rather than degrading further.
  let last: EncodeResult | undefined;
  for (const quality of jpegQualityLadder(floor)) {
    const bytes = await encodeJpeg(pixmap, quality, jpegWasm);
    last = { bytes, format: 'jpeg', quality, byteLength: bytes.length };
    if (bytes.length <= maxBytes) return last;
  }
  return last as EncodeResult;
}

/**
 * Render a layout to a pixmap + PNG. Fonts and wasm sources are injected so the
 * call works unchanged in Node (tests) and the Worker.
 */
export async function renderLayout(
  layout: LayoutDescriptor,
  inputs: RenderInputs,
  options: RenderOptions,
): Promise<RenderOutput> {
  const composed = layout.render(inputs.brandKit, inputs.job);

  await ensureResvgReady(options.wasm.resvg);

  const svg = await satori(composed.element as unknown as Parameters<typeof satori>[0], {
    width: layout.width,
    height: layout.height,
    fonts: options.fonts as unknown as Parameters<typeof satori>[1]['fonts'],
  });

  const rendered = new Resvg(svg, { fitTo: { mode: 'original' } }).render();
  const pixmap: Pixmap = {
    width: rendered.width,
    height: rendered.height,
    data: new Uint8ClampedArray(rendered.pixels),
  };
  const png = rendered.asPng();

  return {
    templateId: layout.templateId,
    pixmap,
    png,
    svg,
    headlineFontPx: composed.headlineFontPx,
    headlineFits: composed.headlineFits,
    logoRect: composed.logoRect,
    drawOrder: composed.drawOrder,
    encode: (encodeOptions) => encodeBest(pixmap, png, options.wasm.jpeg, encodeOptions),
  };
}
