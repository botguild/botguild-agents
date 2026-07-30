// ---------------------------------------------------------------------------
// Layout descriptor contract (PRD §5 FR-5/FR-7, §8, §9).
//
// A layout is a typed, serializable template: fixed target dimensions, a safe
// zone, a logo rect, declared swatch regions, a per-format minimum font floor,
// and a pure `render(brandKit, inputs)` that emits a Satori element tree (the
// object/hyperscript form — no JSX runtime) plus the metadata every §9 gate
// needs: the FINAL headline font size actually used (FR-6), where the logo
// landed, and the z-ordered draw list (logo z-order gate).
// ---------------------------------------------------------------------------

import type { BrandKit, JobInputs, Rect, SwatchRegion } from '../types.js';

/**
 * A Satori element node in object form: `{ type, props }`. This is exactly the
 * shape JSX compiles to, so Satori consumes it directly with no React runtime.
 * `SatoriNode` is JSON-serializable, which is what makes it the "editable
 * template" deliverable artifact (PRD §8, gate `template.ts`).
 */
export interface SatoriNode {
  type: string;
  props: {
    style?: Record<string, string | number>;
    children?: SatoriChildren;
    [key: string]: unknown;
  };
}

export type SatoriChildren = string | SatoriNode | Array<string | SatoriNode>;

/** One composited block, in paint order. Higher `z` paints later (on top). */
export interface DrawNode {
  id: string;
  rect: Rect;
  z: number;
}

/** What a layout's `render` returns: the element tree plus gate-facing metadata. */
export interface LayoutRenderResult {
  element: SatoriNode;
  /** The headline font size actually used, in px. Compared to `minFontPx` (FR-6). */
  headlineFontPx: number;
  /** False when the headline could not fit at or above the floor (FR-6 reject/renegotiate). */
  headlineFits: boolean;
  /** Where the logo was composited (equals `descriptor.logoRect`). */
  logoRect: Rect;
  /** Draw order for the logo z-order gate — the logo is always the top-most block. */
  drawOrder: DrawNode[];
}

/** A named, serializable layout template. */
export interface LayoutDescriptor {
  /** Distinct composition id (part of the A/B distinctness gate, PRD §9). */
  templateId: string;
  /** Gig family this composition serves. */
  format: 'og' | 'thumbnail' | 'socialFeed' | 'socialStory';
  width: number;
  height: number;
  /** The rect the headline must fit inside. */
  safeZone: Rect;
  /** Where the logo is composited. */
  logoRect: Rect;
  /** Solid regions the brand-color gate samples. */
  swatchRegions: SwatchRegion[];
  /** Minimum headline font px for this format (baseline 32 @ 1280x720, scaled by height). */
  minFontPx: number;
  render(brandKit: BrandKit, inputs: JobInputs): LayoutRenderResult;
}

/** Baseline min font size: 32px at 720px tall, scaled linearly per format (PRD §9). */
export function minFontForHeight(height: number): number {
  return Math.round((32 * height) / 720);
}
