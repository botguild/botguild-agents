// ---------------------------------------------------------------------------
// Logo gate (PRD §9, FR-10). Two independent assertions, both required:
//   1. Pixel similarity: sample the logo rect from the render and compare it to
//      the EXPECTED post-resize/post-recolor raster the layout composited (a
//      brand-color logomark compares against its own solid fill). Default ≥ 90%.
//      Interior-only sampling (inset) avoids anti-aliased edges / rounded corners.
//   2. Z-order: from the layout draw list, nothing is composited above the logo
//      rect — the logo is the top-most block over its own area.
// This is not a circular "we drew it" boolean: a blank or occluded logo fails.
// ---------------------------------------------------------------------------

import type { LogoRaster, Pixmap, Rect } from '../types.js';
import type { DrawNode } from '../layouts/types.js';

export const DEFAULT_MIN_SIMILARITY = 0.9;
/** Per-channel-sum RGB distance under which a sampled pixel matches the reference. */
export const DEFAULT_COLOR_TOLERANCE = 48;
/** Fraction of the rect trimmed on each side before sampling (skips AA + radii). */
export const DEFAULT_INSET_RATIO = 0.2;

export interface LogoOptions {
  minSimilarity?: number;
  colorTolerance?: number;
  insetRatio?: number;
  /** Draw-list id of the logo block. */
  logoId?: string;
}

export interface LogoResult {
  pass: boolean;
  similarity: number;
  zOrderClear: boolean;
  matchedPixels: number;
  sampledPixels: number;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** True when no block painted after the logo overlaps the logo rect. */
export function logoZOrderClear(drawOrder: DrawNode[], logoRect: Rect, logoId: string): boolean {
  const logo = drawOrder.find((node) => node.id === logoId);
  if (!logo) return false;
  return !drawOrder.some(
    (node) => node.id !== logoId && node.z > logo.z && rectsIntersect(node.rect, logoRect),
  );
}

/**
 * Sample the logo rect interior and score similarity against `expected`, then
 * combine with the z-order assertion. Passes only when both clear their bars.
 */
export function checkLogo(
  pixmap: Pixmap,
  logoRect: Rect,
  expected: LogoRaster,
  drawOrder: DrawNode[],
  options: LogoOptions = {},
): LogoResult {
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const tolerance = options.colorTolerance ?? DEFAULT_COLOR_TOLERANCE;
  const insetRatio = options.insetRatio ?? DEFAULT_INSET_RATIO;
  const logoId = options.logoId ?? 'logo';

  const insetX = Math.floor(logoRect.width * insetRatio);
  const insetY = Math.floor(logoRect.height * insetRatio);
  const x0 = Math.max(0, Math.floor(logoRect.x) + insetX);
  const y0 = Math.max(0, Math.floor(logoRect.y) + insetY);
  const x1 = Math.min(pixmap.width, Math.ceil(logoRect.x + logoRect.width) - insetX);
  const y1 = Math.min(pixmap.height, Math.ceil(logoRect.y + logoRect.height) - insetY);

  let matched = 0;
  let sampled = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      // Map the sampled pixel to the expected raster (same rect, possibly resized).
      const ex = Math.min(
        expected.width - 1,
        Math.floor(((x - logoRect.x) / logoRect.width) * expected.width),
      );
      const ey = Math.min(
        expected.height - 1,
        Math.floor(((y - logoRect.y) / logoRect.height) * expected.height),
      );
      const pi = (y * pixmap.width + x) * 4;
      const ei = (ey * expected.width + ex) * 4;
      const dr = Math.abs((pixmap.data[pi] ?? 0) - (expected.data[ei] ?? 0));
      const dg = Math.abs((pixmap.data[pi + 1] ?? 0) - (expected.data[ei + 1] ?? 0));
      const db = Math.abs((pixmap.data[pi + 2] ?? 0) - (expected.data[ei + 2] ?? 0));
      if (dr + dg + db <= tolerance) matched++;
      sampled++;
    }
  }

  const similarity = sampled === 0 ? 0 : matched / sampled;
  const zOrderClear = logoZOrderClear(drawOrder, logoRect, logoId);
  return {
    pass: similarity >= minSimilarity && zOrderClear,
    similarity,
    zOrderClear,
    matchedPixels: matched,
    sampledPixels: sampled,
  };
}
