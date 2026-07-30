// favicon.ico assembly in plain TypeScript (FR-11). Windows and every current
// browser accept PNG-compressed ICO entries, which keeps this to a header
// write with no encoder. §13 names BMP-entry encoding as the pure-TS fallback
// if the browser/OS matrix in Phase 3 turns up a consumer that rejects PNG
// entries — do not switch pre-emptively.
//
// Layout: ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per image + the
// PNG payloads concatenated in entry order. All multi-byte fields little-endian.

export interface IcoEntry {
  size: number;
  png: Uint8Array;
}

const ICONDIR_BYTES = 6;
const ICONDIRENTRY_BYTES = 16;

/** Build a multi-size .ico from pre-rendered PNGs. */
export function assembleIco(entries: IcoEntry[]): Uint8Array {
  const headerBytes = ICONDIR_BYTES + ICONDIRENTRY_BYTES * entries.length;
  const total = entries.reduce((sum, entry) => sum + entry.png.byteLength, headerBytes);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint16(0, 0, true); // reserved, always 0
  view.setUint16(2, 1, true); // resource type: 1 = icon
  view.setUint16(4, entries.length, true);

  let offset = headerBytes;
  entries.forEach((entry, index) => {
    const base = ICONDIR_BYTES + index * ICONDIRENTRY_BYTES;
    // 256 is encoded as 0 — the field is a single byte.
    const dim = entry.size >= 256 ? 0 : entry.size;
    out[base] = dim; // width
    out[base + 1] = dim; // height
    out[base + 2] = 0; // palette colour count (0 = truecolour)
    out[base + 3] = 0; // reserved
    view.setUint16(base + 4, 1, true); // colour planes
    view.setUint16(base + 6, 32, true); // bits per pixel
    view.setUint32(base + 8, entry.png.byteLength, true);
    view.setUint32(base + 12, offset, true);
    out.set(entry.png, offset);
    offset += entry.png.byteLength;
  });

  return out;
}
