import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pixmap } from '../types.js';
import { MIN_PHASH_HAMMING } from '../config.js';
import { checkDistinctness, fromHex, hammingDistance, perceptualHash, toHex } from './phash.js';

/** Build a pixmap by evaluating `shade(x, y)` into every RGBA pixel. */
function makePixmap(size: number, shade: (x: number, y: number) => number): Pixmap {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = shade(x, y);
      const i = (y * size + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

// pHash bit-vs-median is only stable on broadband images. Flat/ramp synthetics are DCT-sparse
// (median in a zero cluster; one pixel measured 29-30 bit flips) — real vendor images are
// broadband, and the Phase-2 calibration validates the threshold on real batches. Minimal
// flat-color marks are the caveat; the axis-id rule is the second lock.
const rings = makePixmap(64, (x, y) => ((x - 32) ** 2 + (y - 32) ** 2) % 256);
const ringsNoisy = makePixmap(64, (x, y) =>
  x === 0 && y === 0 ? 128 : ((x - 32) ** 2 + (y - 32) ** 2) % 256,
);
const ringsRenderNoise = makePixmap(64, (x, y) =>
  Math.min(255, (((x - 32) ** 2 + (y - 32) ** 2) % 256) + ((x * 31 + y * 17) % 20 === 0 ? 6 : 0)),
);

// Different composition for contrast testing.
const ringsRotated = makePixmap(64, (x, y) => ((x - 20) ** 2 + (y - 44) ** 2) % 256);

describe('perceptualHash', () => {
  it('is deterministic for the same input', () => {
    assert.equal(perceptualHash(rings), perceptualHash(rings));
  });

  it('a one-pixel perturbation stays below the distinctness threshold', () => {
    const distance = hammingDistance(perceptualHash(rings), perceptualHash(ringsNoisy));
    assert.ok(distance < MIN_PHASH_HAMMING, `expected < ${MIN_PHASH_HAMMING}, got ${distance}`);
  });

  it('distributed render noise stays below the distinctness threshold', () => {
    const distance = hammingDistance(perceptualHash(rings), perceptualHash(ringsRenderNoise));
    assert.ok(distance < MIN_PHASH_HAMMING, `expected < ${MIN_PHASH_HAMMING}, got ${distance}`);
  });

  it('differs substantially for a different composition', () => {
    const distance = hammingDistance(perceptualHash(rings), perceptualHash(ringsRotated));
    assert.ok(distance >= 10, `expected >= 10, got ${distance}`);
  });
});

describe('hex round-trip', () => {
  it('survives toHex → fromHex', () => {
    const hash = perceptualHash(ringsRotated);
    assert.equal(fromHex(toHex(hash)), hash);
    assert.equal(toHex(hash).length, 16);
  });
});

describe('hammingDistance', () => {
  it('is zero for identical hashes and 64 for inverted ones', () => {
    assert.equal(hammingDistance(0n, 0n), 0);
    assert.equal(hammingDistance(0n, (1n << 64n) - 1n), 64);
    assert.equal(hammingDistance(0b1011n, 0b1001n), 1);
  });
});

describe('checkDistinctness', () => {
  const distinct = [
    { slot: 1, phash: '0000000000000000', axisId: 'wordmark' },
    { slot: 2, phash: 'ffffffffffffffff', axisId: 'lockup' },
    { slot: 3, phash: '0f0f0f0f0f0f0f0f', axisId: 'emblem' },
  ];

  it('passes when every pair clears the threshold and axes differ', () => {
    const result = checkDistinctness(distinct);
    assert.equal(result.pass, true);
    assert.equal(result.pairs.length, 3); // 3 choose 2
    assert.equal(result.failing.length, 0);
  });

  it('fails a pair below the Hamming threshold', () => {
    const result = checkDistinctness([
      { slot: 1, phash: '0000000000000000', axisId: 'wordmark' },
      { slot: 2, phash: '0000000000000001', axisId: 'lockup' },
      { slot: 3, phash: 'ffffffffffffffff', axisId: 'emblem' },
    ]);
    assert.equal(result.pass, false);
    assert.equal(result.failing.length, 1);
    assert.deepEqual([result.failing[0]!.a, result.failing[0]!.b], [1, 2]);
  });

  it('fails a pair that shares an axis even when pixels differ (§9)', () => {
    const result = checkDistinctness([
      { slot: 1, phash: '0000000000000000', axisId: 'wordmark' },
      { slot: 2, phash: 'ffffffffffffffff', axisId: 'wordmark' },
      { slot: 3, phash: '0f0f0f0f0f0f0f0f', axisId: 'emblem' },
    ]);
    assert.equal(result.pass, false);
    assert.ok(result.failing.some((p) => p.sameAxis));
  });

  it('honours an overridden threshold', () => {
    const entries = [
      { slot: 1, phash: '0000000000000000', axisId: 'a' },
      { slot: 2, phash: '000000000000000f', axisId: 'b' },
    ];
    assert.equal(checkDistinctness(entries, 4).pass, true);
    assert.equal(checkDistinctness(entries, 5).pass, false);
  });
});
