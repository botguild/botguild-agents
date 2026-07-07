// Open Graph / share image (PRD §8) — exactly 1200x630.
// Left-aligned headline band, brand swatches bottom-left, logo top-right.

import { createLayout } from './factory.js';

export const og = createLayout({
  templateId: 'tf-og-v1',
  format: 'og',
  width: 1200,
  height: 630,
  backgroundHex: '#0E1116',
  headlineColor: '#FFFFFF',
  headlineAlign: 'left',
  headlineJustify: 'flex-start',
  maxFontPx: 84,
  safeZone: { x: 60, y: 110, width: 820, height: 320 },
  logoRect: { x: 1000, y: 40, width: 160, height: 56 },
  swatchRegions: [
    { role: 'primary', rect: { x: 60, y: 500, width: 90, height: 90 } },
    { role: 'secondary', rect: { x: 170, y: 500, width: 90, height: 90 } },
  ],
});
