import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkABDistinct, hammingDistance, pHash } from './phash.js';
import type { Pixmap } from '../types.js';

/** A 256x256 image split into a dark half and a bright half. */
function split(orientation: 'vertical' | 'horizontal'): Pixmap {
  const size = 256;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const bright = orientation === 'vertical' ? x >= size / 2 : y >= size / 2;
      const v = bright ? 235 : 20;
      const i = (y * size + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

test('hammingDistance counts differing bits', () => {
  assert.equal(hammingDistance(0b1011n, 0b1101n), 2);
  assert.equal(hammingDistance(0n, 0xffffffffffffffffn), 64);
  assert.equal(hammingDistance(42n, 42n), 0);
});

test('identical images hash identically (distance 0)', () => {
  const a = split('vertical');
  const b = split('vertical');
  assert.equal(pHash(a), pHash(b));
  assert.equal(hammingDistance(pHash(a), pHash(b)), 0);
});

test('orthogonal compositions are perceptually distant (>= 10)', () => {
  const distance = hammingDistance(pHash(split('vertical')), pHash(split('horizontal')));
  assert.ok(distance >= 10, `expected distance >= 10, got ${distance}`);
});

test('A/B gate needs BOTH distance and distinct template ids', () => {
  const a = split('vertical');
  const b = split('horizontal');

  // Distinct pixels + distinct ids → pass.
  assert.equal(checkABDistinct(a, b, 'tf-thumb-a-v1', 'tf-thumb-b-v1').pass, true);

  // Distinct pixels but same template id (a hue-rotation-style dupe) → fail.
  const sameId = checkABDistinct(a, b, 'tf-thumb-a-v1', 'tf-thumb-a-v1');
  assert.equal(sameId.pass, false);
  assert.equal(sameId.distinctTemplates, false);

  // Distinct ids but identical pixels (distance 0) → fail.
  const identical = checkABDistinct(a, a, 'tf-thumb-a-v1', 'tf-thumb-b-v1');
  assert.equal(identical.pass, false);
  assert.ok(identical.distance < 10);
});
