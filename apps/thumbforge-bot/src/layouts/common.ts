// ---------------------------------------------------------------------------
// Shared layout composition helpers.
//
// Every layout paints a set of absolutely-positioned blocks over a background:
// solid swatch regions the brand-color gate samples, a headline in the safe
// zone, and — always last / top-most — the logo, so the logo z-order gate has
// a real invariant to assert. `compose` returns both the Satori element tree
// and the z-ordered draw list.
//
// When the brand kit supplies no logo raster, layouts paint a deterministic
// solid-color logomark and the logo gate compares against that exact fill (a
// "post-recolor" reference that compares against itself, per PRD §9).
// ---------------------------------------------------------------------------

import type { BrandKit, LogoRaster, RGB, Rect } from '../types.js';
import { FONT_FAMILY } from '../fonts/index.js';
import type { DrawNode, SatoriNode } from './types.js';

/** Parse `#RGB` / `#RRGGBB` into 0–255 components. */
export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = Number.parseInt(h, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Map a swatch role to a palette entry (primary→0, secondary→1, accent→2). */
export function resolveSwatchHex(brandKit: BrandKit, role: string): string {
  const index = role === 'secondary' ? 1 : role === 'accent' ? 2 : 0;
  return brandKit.palette[index] ?? brandKit.palette[0] ?? '#000000';
}

/** A solid-fill LogoRaster the logo gate compares against (post-resize/recolor reference). */
export function solidLogoRaster(rect: Rect, hex: string): LogoRaster {
  const { r, g, b } = hexToRgb(hex);
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/** An absolutely-positioned solid rectangle. */
export function solidBox(rect: Rect, hex: string, extraStyle: Record<string, string | number> = {}): SatoriNode {
  return {
    type: 'div',
    props: {
      style: {
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        backgroundColor: hex,
        display: 'flex',
        ...extraStyle,
      },
    },
  };
}

export interface TextBoxOptions {
  fontPx: number;
  color: string;
  weight: 400 | 700;
  align?: 'left' | 'center' | 'right';
  justify?: 'flex-start' | 'center' | 'flex-end';
}

/** A headline/copy block: an absolute flex box wrapping an inner text div (so text wraps to `rect.width`). */
export function textBox(rect: Rect, text: string, options: TextBoxOptions): SatoriNode {
  const align = options.align ?? 'left';
  const justify = options.justify ?? 'center';
  return {
    type: 'div',
    props: {
      style: {
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: justify,
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              width: rect.width,
              fontFamily: FONT_FAMILY,
              fontWeight: options.weight,
              fontSize: options.fontPx,
              lineHeight: 1.25,
              color: options.color,
              textAlign: align,
            },
            children: text,
          },
        },
      ],
    },
  };
}

/** One composited block: its id, its rect (for gates), and its Satori node. */
export interface Layer {
  id: string;
  rect: Rect;
  node: SatoriNode;
}

export interface ComposeResult {
  element: SatoriNode;
  drawOrder: DrawNode[];
}

/**
 * Build the root element from a background fill plus ordered layers. Paint
 * order is array order; `z` increases with it, so the last layer (the logo) is
 * top-most — the invariant the logo z-order gate checks.
 */
export function compose(
  width: number,
  height: number,
  backgroundHex: string,
  layers: Layer[],
): ComposeResult {
  const element: SatoriNode = {
    type: 'div',
    props: {
      style: {
        position: 'relative',
        display: 'flex',
        width,
        height,
        backgroundColor: backgroundHex,
      },
      children: layers.map((layer) => layer.node),
    },
  };
  const drawOrder: DrawNode[] = layers.map((layer, index) => ({
    id: layer.id,
    rect: layer.rect,
    z: index + 1,
  }));
  return { element, drawOrder };
}
