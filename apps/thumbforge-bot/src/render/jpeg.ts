// ---------------------------------------------------------------------------
// JPEG encoding from a resvg RGBA pixmap (PRD §7, FR-8).
//
// resvg outputs PNG only, so JPEG is a named, separate stack member. The
// primary encoder is `@jsquash/jpeg` (mozjpeg wasm) — best compression, and the
// encoder the Worker uses. `jpeg-js` (pure TypeScript) is the documented
// fallback: it runs identically in Node and the Worker with no wasm init, so it
// keeps the size gate exercisable when the mozjpeg wasm is unavailable or
// misbehaves. Both take the RGBA pixmap directly.
// ---------------------------------------------------------------------------

import encodeJpegWasm from '@jsquash/jpeg/encode.js';
import jpegJs from 'jpeg-js';
import type { Pixmap } from '../types.js';
import { ensureJpegReady, type JpegWasmSource } from './wasm.js';

/** Encode an RGBA pixmap to JPEG at the given quality (0–100) with the pure-TS encoder. */
export function encodeJpegPure(pixmap: Pixmap, quality: number): Uint8Array {
  const encoded = jpegJs.encode(
    { data: pixmap.data, width: pixmap.width, height: pixmap.height },
    quality,
  );
  return encoded.data;
}

/**
 * Encode an RGBA pixmap to JPEG. Uses mozjpeg wasm when a `jpegWasm` source is
 * given (initializing it once per isolate); falls back to the pure-TS encoder
 * if no source is provided or the wasm path throws.
 */
export async function encodeJpeg(
  pixmap: Pixmap,
  quality: number,
  jpegWasm?: JpegWasmSource,
): Promise<Uint8Array> {
  if (jpegWasm) {
    try {
      await ensureJpegReady(jpegWasm);
      const image = {
        data: pixmap.data,
        width: pixmap.width,
        height: pixmap.height,
        colorSpace: 'srgb',
      } as unknown as ImageData;
      const buffer = await encodeJpegWasm(image, { quality });
      return new Uint8Array(buffer);
    } catch {
      // Fall through to the pure-TS encoder — the size gate must stay exercisable.
    }
  }
  return encodeJpegPure(pixmap, quality);
}
