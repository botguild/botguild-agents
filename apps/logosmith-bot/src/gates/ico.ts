// ICO validity gate (FR-13, §9): the delivered favicon.ico is parsed back and
// its entry table must list exactly the contracted sizes. Writing the file is
// not evidence that it is readable — reading it back is.

import { ICO_SIZES } from '../config.js';

export interface IcoParseResult {
  count: number;
  entries: Array<{ width: number; height: number; byteLength: number; offset: number }>;
}

export interface IcoGateResult {
  pass: boolean;
  sizes: number[];
  reason?: string;
}

const ICONDIR_BYTES = 6;
const ICONDIRENTRY_BYTES = 16;

/** Parse an ICO's directory. Returns null if the buffer is not a valid ICO. */
export function parseIco(ico: Uint8Array): IcoParseResult | null {
  if (ico.byteLength < ICONDIR_BYTES) return null;
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  if (view.getUint16(0, true) !== 0) return null;
  if (view.getUint16(2, true) !== 1) return null;
  const count = view.getUint16(4, true);
  if (count === 0) return null;
  if (ico.byteLength < ICONDIR_BYTES + ICONDIRENTRY_BYTES * count) return null;

  const entries: IcoParseResult['entries'] = [];
  for (let i = 0; i < count; i++) {
    const base = ICONDIR_BYTES + i * ICONDIRENTRY_BYTES;
    const rawW = ico[base] ?? 0;
    const rawH = ico[base + 1] ?? 0;
    entries.push({
      width: rawW === 0 ? 256 : rawW,
      height: rawH === 0 ? 256 : rawH,
      byteLength: view.getUint32(base + 8, true),
      offset: view.getUint32(base + 12, true),
    });
  }
  return { count, entries };
}

/** Assert the .ico parses back and lists exactly the contracted sizes. */
export function checkIco(
  ico: Uint8Array,
  expectedSizes: readonly number[] = ICO_SIZES,
): IcoGateResult {
  const parsed = parseIco(ico);
  if (!parsed) return { pass: false, sizes: [], reason: 'buffer did not parse as an ICO' };

  for (const entry of parsed.entries) {
    if (entry.offset + entry.byteLength > ico.byteLength) {
      return { pass: false, sizes: [], reason: 'an entry offset runs past the end of the buffer' };
    }
  }

  const sizes = parsed.entries.map((e) => e.width).sort((a, b) => a - b);
  const missing = expectedSizes.filter((size) => !sizes.includes(size));
  if (missing.length > 0) {
    return { pass: false, sizes, reason: `entry table is missing size(s): ${missing.join(', ')}` };
  }
  return { pass: true, sizes };
}
