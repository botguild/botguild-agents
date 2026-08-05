import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkDimensions, readPngDimensions } from './dimensions.js';

/** A minimal valid PNG header: 8-byte signature + IHDR length/type/w/h. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR chunk length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe('readPngDimensions', () => {
  it('reads width and height from the IHDR chunk', () => {
    assert.deepEqual(readPngDimensions(pngHeader(1024, 1024)), { width: 1024, height: 1024 });
    assert.deepEqual(readPngDimensions(pngHeader(16, 48)), { width: 16, height: 48 });
  });

  it('returns null for a non-PNG buffer', () => {
    assert.equal(readPngDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
  });

  it('returns null for a truncated PNG', () => {
    assert.equal(readPngDimensions(pngHeader(16, 16).slice(0, 20)), null);
  });

  it('returns null when the IHDR chunk type is wrong', () => {
    const bytes = pngHeader(16, 16);
    bytes.set([0x49, 0x44, 0x41, 0x54], 12); // "IDAT"
    assert.equal(readPngDimensions(bytes), null);
  });
});

describe('checkDimensions', () => {
  it('passes on an exact match', () => {
    const result = checkDimensions({ width: 512, height: 512 }, { width: 512, height: 512 });
    assert.equal(result.pass, true);
  });

  it('fails on any mismatch and reports both sides', () => {
    const result = checkDimensions({ width: 511, height: 512 }, { width: 512, height: 512 });
    assert.equal(result.pass, false);
    assert.deepEqual(result.actual, { width: 511, height: 512 });
    assert.deepEqual(result.expected, { width: 512, height: 512 });
  });
});
