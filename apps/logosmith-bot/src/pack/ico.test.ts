import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIco, parseIco } from '../gates/ico.js';
import { assembleIco } from './ico.js';

/** A minimal valid PNG header (24 bytes) padded to a plausible payload size. */
function fakePng(size: number, padTo = 64): Uint8Array {
  const bytes = new Uint8Array(padTo);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, size);
  view.setUint32(20, size);
  return bytes;
}

const entries = [16, 32, 48].map((size) => ({ size, png: fakePng(size) }));

describe('assembleIco', () => {
  it('writes an ICONDIR header declaring the entry count', () => {
    const ico = assembleIco(entries);
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    assert.equal(view.getUint16(0, true), 0); // reserved
    assert.equal(view.getUint16(2, true), 1); // type 1 = icon
    assert.equal(view.getUint16(4, true), 3); // count
  });

  it('lays payloads out after the directory with correct offsets', () => {
    const ico = assembleIco(entries);
    const parsed = parseIco(ico);
    assert.ok(parsed);
    assert.equal(parsed.count, 3);
    const headerBytes = 6 + 16 * 3;
    assert.equal(parsed.entries[0]!.offset, headerBytes);
    assert.equal(parsed.entries[1]!.offset, headerBytes + 64);
    assert.equal(parsed.entries[2]!.offset, headerBytes + 128);
  });

  it('round-trips the declared sizes', () => {
    const parsed = parseIco(assembleIco(entries));
    assert.deepEqual(
      parsed!.entries.map((e) => e.width),
      [16, 32, 48],
    );
  });

  it('encodes 256 as 0 per the ICO format', () => {
    const parsed = parseIco(assembleIco([{ size: 256, png: fakePng(256) }]));
    assert.equal(parsed!.entries[0]!.width, 256);
  });

  it('preserves the payload bytes verbatim', () => {
    const ico = assembleIco(entries);
    const parsed = parseIco(ico)!;
    const first = parsed.entries[0]!;
    const slice = ico.slice(first.offset, first.offset + first.byteLength);
    assert.deepEqual([...slice.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});

describe('checkIco', () => {
  it('passes when the entry table lists exactly 16/32/48', () => {
    const result = checkIco(assembleIco(entries));
    assert.equal(result.pass, true);
    assert.deepEqual(result.sizes, [16, 32, 48]);
  });

  it('fails when a required size is missing', () => {
    const result = checkIco(assembleIco(entries.slice(0, 2)));
    assert.equal(result.pass, false);
    assert.match(result.reason ?? '', /48/);
  });

  it('fails on a buffer that is not an ICO at all', () => {
    const result = checkIco(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    assert.equal(result.pass, false);
  });

  it('fails when an entry offset runs past the buffer', () => {
    const ico = assembleIco(entries);
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    view.setUint32(6 + 12, 0xfffffff0, true); // corrupt entry 0's offset
    assert.equal(checkIco(ico).pass, false);
  });

  it('fails when the entry table lists extra sizes', () => {
    const extraEntries = [16, 32, 48, 64].map((size) => ({ size, png: fakePng(size) }));
    const result = checkIco(assembleIco(extraEntries));
    assert.equal(result.pass, false);
    assert.match(result.reason ?? '', /64/);
  });

  it('fails when a payload dimension does not match its declared size', () => {
    // Entry declared as 16 but PNG actually encodes 32x32.
    const mismatchedEntries = [
      { size: 16, png: fakePng(32) }, // declared 16, actual 32
      { size: 32, png: fakePng(32) },
      { size: 48, png: fakePng(48) },
    ];
    const result = checkIco(assembleIco(mismatchedEntries));
    assert.equal(result.pass, false);
    assert.match(result.reason ?? '', /32/); // should mention the actual dimension
  });

  it('fails when a payload is not a valid PNG', () => {
    const ico = assembleIco(entries);
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    // Corrupt the first PNG by overwriting its magic bytes.
    const firstOffset = view.getUint32(6 + 12, true);
    ico[firstOffset] = 0xff;
    ico[firstOffset + 1] = 0xff;
    const result = checkIco(ico);
    assert.equal(result.pass, false);
    assert.match(result.reason ?? '', /PNG/);
  });

  it('fails when an entry offset points into the directory table', () => {
    const ico = assembleIco(entries);
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    view.setUint32(6 + 12, 0, true); // corrupt entry 0's offset to 0 (into header)
    const result = checkIco(ico);
    assert.equal(result.pass, false);
    assert.match(result.reason ?? '', /directory/);
  });

  it('still passes a well-formed 16/32/48 ICO with payloads that genuinely encode those sizes', () => {
    // This guards against over-rejection in the dimension check.
    const result = checkIco(assembleIco(entries));
    assert.equal(result.pass, true);
    assert.deepEqual(result.sizes, [16, 32, 48]);
  });
});
