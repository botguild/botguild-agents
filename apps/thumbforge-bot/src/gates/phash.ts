// ---------------------------------------------------------------------------
// A/B distinctness gate (PRD §9): a 64-bit 8x8 DCT perceptual hash and Hamming
// distance. Two variants are "distinct" only when BOTH hold: Hamming distance ≥
// the declared threshold (default 10) AND the two layouts carry distinct
// template ids — a hue rotation alone (same composition) never qualifies.
//
// pHash pipeline: luminance-downsample to 32x32, 2D DCT-II, keep the top-left
// 8x8 low-frequency block, set each bit vs the block median.
// ---------------------------------------------------------------------------

import type { Pixmap } from '../types.js';

export const DEFAULT_MIN_HAMMING = 10;

const DCT_SIZE = 32;
const HASH_SIZE = 8;

/** Luminance-downsample a pixmap to a `size`x`size` grayscale grid (box average). */
export function downsampleGray(pixmap: Pixmap, size = DCT_SIZE): number[] {
  const grid = new Array<number>(size * size).fill(0);
  const cellW = pixmap.width / size;
  const cellH = pixmap.height / size;
  for (let gy = 0; gy < size; gy++) {
    for (let gx = 0; gx < size; gx++) {
      const x0 = Math.floor(gx * cellW);
      const y0 = Math.floor(gy * cellH);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cellW));
      const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * cellH));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * pixmap.width + x) * 4;
          const r = pixmap.data[i] ?? 0;
          const g = pixmap.data[i + 1] ?? 0;
          const b = pixmap.data[i + 2] ?? 0;
          sum += 0.299 * r + 0.587 * g + 0.114 * b;
          count++;
        }
      }
      grid[gy * size + gx] = count === 0 ? 0 : sum / count;
    }
  }
  return grid;
}

// Precomputed DCT cosine basis for the top-left HASH_SIZE frequencies over DCT_SIZE samples.
const COS = (() => {
  const table: number[][] = [];
  for (let u = 0; u < HASH_SIZE; u++) {
    const row = new Array<number>(DCT_SIZE);
    for (let x = 0; x < DCT_SIZE; x++) {
      row[x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_SIZE));
    }
    table.push(row);
  }
  return table;
})();

/** Top-left HASH_SIZE x HASH_SIZE 2D DCT-II coefficients of a DCT_SIZE grid. */
function dct8x8(grid: number[]): number[] {
  const coeffs = new Array<number>(HASH_SIZE * HASH_SIZE).fill(0);
  for (let u = 0; u < HASH_SIZE; u++) {
    for (let v = 0; v < HASH_SIZE; v++) {
      let sum = 0;
      for (let y = 0; y < DCT_SIZE; y++) {
        const cosY = COS[v]![y]!;
        for (let x = 0; x < DCT_SIZE; x++) {
          sum += grid[y * DCT_SIZE + x]! * COS[u]![x]! * cosY;
        }
      }
      coeffs[u * HASH_SIZE + v] = sum;
    }
  }
  return coeffs;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** 64-bit DCT perceptual hash of a pixmap. */
export function pHash(pixmap: Pixmap): bigint {
  const coeffs = dct8x8(downsampleGray(pixmap));
  // Exclude the DC term (coeffs[0]) from the median — the standard pHash choice,
  // as the DC coefficient dwarfs the AC terms.
  const med = median(coeffs.slice(1));
  let hash = 0n;
  for (let i = 0; i < coeffs.length; i++) {
    hash <<= 1n;
    if (coeffs[i]! > med) hash |= 1n;
  }
  return hash;
}

/** Number of differing bits between two 64-bit hashes. */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export interface ABDistinctResult {
  pass: boolean;
  distance: number;
  minDistance: number;
  distinctTemplates: boolean;
  hashA: bigint;
  hashB: bigint;
}

/** A/B distinctness: distance ≥ threshold AND distinct template ids (§9). */
export function checkABDistinct(
  pixmapA: Pixmap,
  pixmapB: Pixmap,
  templateIdA: string,
  templateIdB: string,
  options: { minDistance?: number } = {},
): ABDistinctResult {
  const minDistance = options.minDistance ?? DEFAULT_MIN_HAMMING;
  const hashA = pHash(pixmapA);
  const hashB = pHash(pixmapB);
  const distance = hammingDistance(hashA, hashB);
  const distinctTemplates = templateIdA !== templateIdB;
  return { pass: distance >= minDistance && distinctTemplates, distance, minDistance, distinctTemplates, hashA, hashB };
}
