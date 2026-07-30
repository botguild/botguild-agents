// Dimensions gate (PRD §9): exact WxH read from the rendered pixmap.
// Not from layout intent — from the decoded raster, so a resvg surprise fails.

export interface Dimensions {
  width: number;
  height: number;
}

export interface DimensionsResult {
  pass: boolean;
  actual: Dimensions;
  expected: Dimensions;
}

/** Assert the pixmap's exact pixel dimensions match the layout target. */
export function checkDimensions(pixmap: Dimensions, expected: Dimensions): DimensionsResult {
  return {
    pass: pixmap.width === expected.width && pixmap.height === expected.height,
    actual: { width: pixmap.width, height: pixmap.height },
    expected: { width: expected.width, height: expected.height },
  };
}
