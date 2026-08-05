// Brand hex extraction (FR-12) in plain TypeScript — replaces node-vibrant,
// which does not run on Workers. Frequency-quantized top swatches read off the
// 1024px pixmap, with the background excluded so "#ffffff" is never sold back
// to the buyer as a brand colour.

import type { Pixmap } from '../types.js';

export interface Swatch {
  hex: string;
  share: number;
}

/** Quantize each channel to 4 bits so near-identical AA pixels collapse together. */
const quantize = (value: number): number => value & 0xf0;

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Near-white and near-black are background/ink, not brand colour. */
function isBackground(r: number, g: number, b: number): boolean {
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma > 233 || luma < 12;
}

/** Top brand swatches by pixel frequency, most-common first. */
export function extractPalette(pixmap: Pixmap, max = 5): Swatch[] {
  const counts = new Map<string, { r: number; g: number; b: number; n: number }>();
  let counted = 0;

  for (let i = 0; i < pixmap.data.length; i += 4) {
    const a = pixmap.data[i + 3] ?? 0;
    if (a < 8) continue; // fully transparent
    const r = pixmap.data[i] ?? 0;
    const g = pixmap.data[i + 1] ?? 0;
    const b = pixmap.data[i + 2] ?? 0;
    if (isBackground(r, g, b)) continue;

    const key = `${quantize(r)},${quantize(g)},${quantize(b)}`;
    const bucket = counts.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.n += 1;
    } else {
      counts.set(key, { r, g, b, n: 1 });
    }
    counted++;
  }

  if (counted === 0) return [];

  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map((bucket) => ({
      // Average the bucket back to a representative colour rather than
      // reporting the quantized corner, which would shift every hex.
      hex: toHex(
        Math.round(bucket.r / bucket.n),
        Math.round(bucket.g / bucket.n),
        Math.round(bucket.b / bucket.n),
      ),
      share: bucket.n / counted,
    }));
}
