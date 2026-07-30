// ---------------------------------------------------------------------------
// Concept distinctness gate (FR-6, §9). Adapted from
// apps/thumbforge-bot/src/gates/phash.ts — the same 64-bit 8x8 DCT perceptual
// hash, because the PRD pins LogoSmith's threshold "consistent with ThumbForge".
//
// Two concepts are distinct only when BOTH hold: Hamming distance >= the
// declared threshold AND the two concepts carry distinct declared style axis
// ids. Axis labels alone never satisfy the gate — three prompts that all
// produced the same lockup are not three concepts.
//
// pHash pipeline: luminance-downsample to 32x32, 2D DCT-II, keep the top-left
// 8x8 low-frequency block, set each bit against the block median.
// ---------------------------------------------------------------------------

import { MIN_PHASH_HAMMING } from '../config.js';
import type { Pixmap } from '../types.js';

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
      grid[gy * size + gx] = count > 0 ? sum / count : 0;
    }
  }
  return grid;
}

/** Precomputed DCT cosine basis for the top-left HASH_SIZE frequencies over DCT_SIZE samples. */
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
function dct2dTopLeft(grid: number[]): number[] {
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

/** 64-bit 8x8 DCT perceptual hash of a pixmap. */
export function perceptualHash(pixmap: Pixmap): bigint {
  const grid = downsampleGray(pixmap, DCT_SIZE);
  const coeffs = dct2dTopLeft(grid);
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** 16-hex-character string form, for the D1 `concepts.phash` column. */
export function toHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}

export function fromHex(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

export function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

export interface DistinctEntry {
  slot: number;
  phash: string;
  axisId: string;
}

export interface PairResult {
  a: number;
  b: number;
  distance: number;
  sameAxis: boolean;
  pass: boolean;
}

export interface DistinctnessResult {
  pass: boolean;
  pairs: PairResult[];
  failing: PairResult[];
}

/**
 * Pairwise distinctness over the delivered concept set. Every pair must clear
 * the Hamming threshold AND carry different axis ids.
 */
export function checkDistinctness(
  entries: DistinctEntry[],
  minHamming: number = MIN_PHASH_HAMMING,
): DistinctnessResult {
  const pairs: PairResult[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      const distance = hammingDistance(fromHex(a.phash), fromHex(b.phash));
      const sameAxis = a.axisId === b.axisId;
      pairs.push({
        a: a.slot,
        b: b.slot,
        distance,
        sameAxis,
        pass: distance >= minHamming && !sameAxis,
      });
    }
  }
  const failing = pairs.filter((p) => !p.pass);
  return { pass: failing.length === 0, pairs, failing };
}
