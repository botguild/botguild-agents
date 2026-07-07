// YouTube A/B thumbnail — variant A (PRD §8, US-3) — exactly 1280x720.
// Composition A: large top-left headline on a dark field, logo bottom-right,
// swatches bottom-left. Deliberately distinct from variant B (pHash + layout
// distinctness gate, §9).

import { createLayout } from './factory.js';

export const thumbnailA = createLayout({
  templateId: 'tf-thumb-a-v1',
  format: 'thumbnail',
  width: 1280,
  height: 720,
  backgroundHex: '#0E1116',
  headlineColor: '#FFFFFF',
  headlineAlign: 'left',
  headlineJustify: 'flex-start',
  maxFontPx: 110,
  safeZone: { x: 64, y: 80, width: 900, height: 360 },
  logoRect: { x: 1060, y: 600, width: 180, height: 64 },
  swatchRegions: [
    { role: 'primary', rect: { x: 64, y: 600, width: 90, height: 90 } },
    { role: 'secondary', rect: { x: 170, y: 600, width: 90, height: 90 } },
  ],
});
