// Dimensions gate (FR-13, §9): every PNG's size is read from the encoded IHDR
// bytes, never from render intent — so a resvg surprise fails the gate instead
// of shipping a wrongly-sized favicon.

export interface Dimensions {
  width: number;
  height: number;
}

export interface DimensionsResult {
  pass: boolean;
  actual: Dimensions;
  expected: Dimensions;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Read WxH out of a PNG's IHDR chunk. Returns null if this is not a PNG. */
export function readPngDimensions(png: Uint8Array): Dimensions | null {
  if (png.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (png[i] !== PNG_SIGNATURE[i]) return null;
  }
  // Bytes 12-15 must spell "IHDR" — the first chunk of every valid PNG.
  if (png[12] !== 0x49 || png[13] !== 0x48 || png[14] !== 0x44 || png[15] !== 0x52) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Assert exact pixel dimensions against the contracted target. */
export function checkDimensions(actual: Dimensions, expected: Dimensions): DimensionsResult {
  return {
    pass: actual.width === expected.width && actual.height === expected.height,
    actual: { width: actual.width, height: actual.height },
    expected: { width: expected.width, height: expected.height },
  };
}
