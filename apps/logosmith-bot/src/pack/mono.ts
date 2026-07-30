// Mono mark (FR-11). The colour winner is thresholded to bilevel and traced to
// a single-colour SVG — the "works on a stamp / one-colour print" deliverable.
//
// potrace is mono-only by construction: the PRD is explicit that it is NOT a
// fallback for full-colour vectorization (§13). Nothing here claims otherwise.
//
// Deviation from the brief (verified, not guessed): the brief's Step 3 has a
// static `import { potrace } from 'esm-potrace-wasm'` at module scope. That is
// the exact crash `./wasm.ts`'s header comment already documents — dist/
// index.js is Emscripten glue mislabelled as ESM, with a bare `require` at
// index.js:1:296 that throws `ReferenceError: require is not defined in ES
// module scope` the instant the module graph loads it, before any of our code
// (including nodeWasmSources()'s CJS-global shim) runs. Confirmed by running
// the brief's code verbatim: the whole test process crashed with exactly that
// ReferenceError at that file:line. `./wasm.ts` deliberately made potrace's
// import dynamic for this reason; `traceMonoSvg` below does the same, calling
// `import('esm-potrace-wasm')` lazily (after ensurePotraceReady has run and
// the Node shim is installed) instead of importing `potrace` up top.
import { sanitizeSvg } from '../gates/vector.js';
import type { Pixmap } from '../types.js';
import { ensurePotraceReady, type WasmSources } from './wasm.js';

const DEFAULT_CUTOFF = 128;

/**
 * Collapse a pixmap to pure black / pure white on a luminance cutoff. Pure and
 * wasm-free so the threshold behaviour is unit-testable on its own; alpha is
 * flattened onto white first so a transparent background becomes light, not
 * accidentally dark.
 */
export function thresholdToBilevel(pixmap: Pixmap, cutoff = DEFAULT_CUTOFF): Pixmap {
  const data = new Uint8Array(pixmap.data.length);
  for (let i = 0; i < pixmap.data.length; i += 4) {
    const alpha = (pixmap.data[i + 3] ?? 255) / 255;
    const r = (pixmap.data[i] ?? 0) * alpha + 255 * (1 - alpha);
    const g = (pixmap.data[i + 1] ?? 0) * alpha + 255 * (1 - alpha);
    const b = (pixmap.data[i + 2] ?? 0) * alpha + 255 * (1 - alpha);
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const v = luma < cutoff ? 0 : 255;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: pixmap.width, height: pixmap.height, data };
}

/** Threshold then trace to a mono SVG, sanitized and gate-ready. */
export async function traceMonoSvg(pixmap: Pixmap, sources: WasmSources): Promise<string> {
  await ensurePotraceReady(sources.potrace);
  // Lazy + dynamic on purpose — see the module header. By this point
  // ensurePotraceReady() has already imported (and initialized) the package
  // once, so this second `import()` just hits Node's module cache and returns
  // the same namespace object; it never re-runs the module body.
  const { potrace } = await import('esm-potrace-wasm');
  const bilevel = thresholdToBilevel(pixmap);
  // Deliberately a plain object, NOT `new ImageData(...)`: Node has no global
  // `ImageData` constructor at runtime (verified — `typeof ImageData` is
  // `"undefined"` under Node 22), so constructing one would throw. The
  // `ImageData` *type* below is only a compile-time shape (it resolves
  // because the ambient DOM lib is pulled in by default when tsconfig sets no
  // explicit "lib"); no runtime value named ImageData is ever touched.
  // potrace's compiled dispatcher (dist/index.js) branches on
  // `imageBitmapSource.constructor.name`, special-casing Blob/
  // HTMLImageElement/SVGImageElement/HTMLVideoElement/HTMLCanvasElement/
  // ImageBitmap (all of which need `document`/canvas, unavailable in Node or
  // a Worker); a plain object's constructor name is "Object", so it falls
  // through to the pass-through branch that reads `.data`/`.width`/`.height`
  // directly — exactly this shape, and exactly why no browser API is needed
  // here (see traceMonoSvg's Worker-viability note in the task report).
  const imageData = {
    data: new Uint8ClampedArray(bilevel.data),
    width: bilevel.width,
    height: bilevel.height,
  };
  const traced = await potrace(imageData as ImageData, {
    turdsize: 2,
    extractcolors: false,
  });
  // potrace's declared return type is `string | string[]`: the array branch
  // only fires when a `pathonly` option is set, returning bare path `d`
  // fragments with no `<svg>`/`<path>` wrapper at all (see dist/index.js —
  // `v.pathonly ? n.split("M")... : n`). We never pass `pathonly`, so this
  // should be unreachable; guard it explicitly rather than silently joining
  // fragments into something that isn't a valid SVG document.
  if (typeof traced !== 'string') {
    throw new Error('traceMonoSvg: potrace returned path fragments, not an SVG document');
  }
  return sanitizeSvg(ensureViewBox(traced, bilevel.width, bilevel.height));
}

/**
 * potrace emits width/height attributes; the true-vector gate requires a
 * viewBox, so add one derived from the traced raster when it is absent.
 */
function ensureViewBox(svg: string, width: number, height: number): string {
  if (/\sviewBox\s*=/i.test(svg)) return svg;
  return svg.replace(/<svg\b/i, `<svg viewBox="0 0 ${width} ${height}"`);
}
