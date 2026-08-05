import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pixmap } from '../types.js';
import { extractPalette } from './palette.js';

function pixmapFrom(colors: Array<[number, number, number, number]>): Pixmap {
  const data = new Uint8Array(colors.length * 4);
  colors.forEach(([r, g, b, a], i) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  });
  return { width: colors.length, height: 1, data };
}

const teal: [number, number, number, number] = [0x0f, 0x3d, 0x3e, 255];
const sand: [number, number, number, number] = [0xe8, 0xc3, 0x9e, 255];
const white: [number, number, number, number] = [255, 255, 255, 255];

describe('extractPalette', () => {
  it('returns the dominant colours as hex, most-common first', () => {
    const swatches = extractPalette(pixmapFrom([teal, teal, teal, sand, sand, white]));
    assert.equal(swatches[0]!.hex, '#0f3d3e');
    assert.equal(swatches[1]!.hex, '#e8c39e');
  });

  it('excludes the near-white background (§FR-12)', () => {
    const swatches = extractPalette(pixmapFrom([white, white, white, white, teal]));
    assert.ok(!swatches.some((s) => s.hex === '#ffffff'));
    assert.equal(swatches[0]!.hex, '#0f3d3e');
  });

  it('excludes fully transparent pixels', () => {
    const swatches = extractPalette(pixmapFrom([[0, 0, 0, 0], [0, 0, 0, 0], teal]));
    assert.equal(swatches.length, 1);
    assert.equal(swatches[0]!.hex, '#0f3d3e');
  });

  it('reports each swatch share as a fraction of counted pixels', () => {
    const swatches = extractPalette(pixmapFrom([teal, teal, sand, sand]));
    assert.equal(swatches[0]!.share, 0.5);
    assert.equal(swatches[1]!.share, 0.5);
  });

  it('caps the number of swatches returned', () => {
    const many = Array.from(
      { length: 40 },
      (_, i) => [i * 6, 40, 40, 255] as [number, number, number, number],
    );
    assert.ok(extractPalette(pixmapFrom(many), 5).length <= 5);
  });

  it('returns an empty array when every pixel is excluded', () => {
    assert.deepEqual(extractPalette(pixmapFrom([white, white])), []);
  });
});
