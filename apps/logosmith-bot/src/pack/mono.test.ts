import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkTrueVector } from '../gates/vector.js';
import type { Pixmap } from '../types.js';
import { thresholdToBilevel, traceMonoSvg } from './mono.js';
import { nodeWasmSources } from './wasm.node.js';

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

// A dark disc on a light field — a stand-in for a solid mark.
const disc = makePixmap(128, (x, y) => {
  const dx = x - 64;
  const dy = y - 64;
  return dx * dx + dy * dy < 40 * 40 ? 20 : 240;
});

describe('thresholdToBilevel', () => {
  it('collapses every pixel to pure black or pure white', () => {
    const out = thresholdToBilevel(disc);
    for (let i = 0; i < out.data.length; i += 4) {
      const v = out.data[i]!;
      assert.ok(v === 0 || v === 255, `unexpected value ${v}`);
      assert.equal(out.data[i + 1], v);
      assert.equal(out.data[i + 2], v);
      assert.equal(out.data[i + 3], 255);
    }
  });

  it('puts the dark mark on the black side of the cutoff', () => {
    const out = thresholdToBilevel(disc);
    const centre = (64 * 128 + 64) * 4;
    const corner = 0;
    assert.equal(out.data[centre], 0);
    assert.equal(out.data[corner], 255);
  });

  it('honours an explicit cutoff', () => {
    const flat = makePixmap(8, () => 100);
    assert.equal(thresholdToBilevel(flat, 50).data[0], 255);
    assert.equal(thresholdToBilevel(flat, 150).data[0], 0);
  });

  it('preserves dimensions', () => {
    const out = thresholdToBilevel(disc);
    assert.equal(out.width, 128);
    assert.equal(out.height, 128);
  });
});

describe('traceMonoSvg', () => {
  it('produces an SVG that passes the true-vector gate', async () => {
    const svg = await traceMonoSvg(disc, nodeWasmSources());
    const result = checkTrueVector(svg);
    assert.equal(result.pass, true, result.violations.join('; '));
    assert.ok(result.census.path > 0, 'expected at least one traced path');
  });

  it('carries no <image> and no <text>', async () => {
    const svg = await traceMonoSvg(disc, nodeWasmSources());
    assert.ok(!/<image/i.test(svg));
    assert.ok(!/<text/i.test(svg));
  });
});
