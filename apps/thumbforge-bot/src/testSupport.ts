// Synthetic pixmap builders for gate unit tests — no rendering, no live APIs.

import type { Pixmap, RGB, Rect } from './types.js';

/** A fully-opaque solid-color pixmap. */
export function solidPixmap(width: number, height: number, rgb: RGB): Pixmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb.r;
    data[i + 1] = rgb.g;
    data[i + 2] = rgb.b;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/** Paint a solid rect into an existing pixmap (clamped to bounds). */
export function fillRect(pixmap: Pixmap, rect: Rect, rgb: RGB): void {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(pixmap.width, Math.floor(rect.x + rect.width));
  const y1 = Math.min(pixmap.height, Math.floor(rect.y + rect.height));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * pixmap.width + x) * 4;
      pixmap.data[i] = rgb.r;
      pixmap.data[i + 1] = rgb.g;
      pixmap.data[i + 2] = rgb.b;
      pixmap.data[i + 3] = 255;
    }
  }
}
