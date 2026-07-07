// ---------------------------------------------------------------------------
// Shared value types for the ThumbForge render core (PRD §5–§9).
//
// Everything here is plain data — no Workers globals, no Node globals — so the
// gate math, layouts, and render orchestration all import from one place and
// stay unit-testable under `node:test`.
// ---------------------------------------------------------------------------

/** Axis-aligned rectangle in device pixels. Origin is the top-left of the canvas. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A decoded RGBA raster: `data` is row-major RGBA, length `width * height * 4`. */
export interface Pixmap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A logo raster the layout composites (post-resize, post-recolor) — same shape as a Pixmap. */
export type LogoRaster = Pixmap;

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** A declared solid-color region the brand-color gate samples (PRD §8 `swatch_regions`). */
export interface SwatchRegion {
  /** Semantic role, e.g. `primary` / `secondary`; maps to a palette entry. */
  role: string;
  rect: Rect;
}

/**
 * Brand kit resolved for a render (PRD §8). `palette[0]` is the primary color;
 * `swatchRegions[i].role` maps to a palette entry via {@link resolveSwatchHex}.
 * `logo` is an optional buyer-supplied raster; when absent, layouts paint a
 * deterministic solid-color logomark so the logo gate still has a real target.
 */
export interface BrandKit {
  palette: string[];
  swatchRegions: SwatchRegion[];
  logo?: LogoRaster;
}

/** Per-job creative inputs (PRD §8 input brief). All optional — layouts default missing fields. */
export interface JobInputs {
  headline?: string;
  title?: string;
  subtitle?: string;
  copy?: string;
  badge?: string;
}
