// YouTube A/B thumbnail — variant B (PRD §8, US-3) — exactly 1280x720.
// Composition B: a full-width secondary-color banner across the top half, the
// headline centered in the lower half, logo top-left, swatches top-right. A
// genuinely different composition from variant A (not a hue rotation), which is
// what the A/B distinctness gate requires (§9): distinct template id AND a large
// perceptual-hash distance.

import type { BrandKit } from '../types.js';
import { resolveSwatchHex, solidBox, type Layer } from './common.js';
import { createLayout } from './factory.js';

const BANNER = { x: 0, y: 0, width: 1280, height: 340 };

function banner(brandKit: BrandKit): Layer[] {
  return [
    { id: 'banner', rect: BANNER, node: solidBox(BANNER, resolveSwatchHex(brandKit, 'secondary')) },
  ];
}

export const thumbnailB = createLayout({
  templateId: 'tf-thumb-b-v1',
  format: 'thumbnail',
  width: 1280,
  height: 720,
  backgroundHex: '#101418',
  headlineColor: '#FFFFFF',
  headlineAlign: 'center',
  headlineJustify: 'center',
  maxFontPx: 96,
  safeZone: { x: 80, y: 430, width: 1120, height: 220 },
  logoRect: { x: 40, y: 40, width: 180, height: 64 },
  swatchRegions: [
    { role: 'primary', rect: { x: 1080, y: 40, width: 80, height: 80 } },
    { role: 'accent', rect: { x: 1170, y: 40, width: 80, height: 80 } },
  ],
  panels: banner,
});
