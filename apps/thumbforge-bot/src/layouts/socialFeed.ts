// Social pack — feed format (PRD §8, US-1) — exactly 1080x1080.
// Centered headline, logo top-center, swatch row bottom-center.

import { createLayout } from './factory.js';

export const socialFeed = createLayout({
  templateId: 'tf-social-feed-v1',
  format: 'socialFeed',
  width: 1080,
  height: 1080,
  backgroundHex: '#0E1116',
  headlineColor: '#FFFFFF',
  headlineAlign: 'center',
  headlineJustify: 'center',
  maxFontPx: 120,
  safeZone: { x: 90, y: 320, width: 900, height: 440 },
  logoRect: { x: 460, y: 90, width: 160, height: 56 },
  swatchRegions: [
    { role: 'primary', rect: { x: 440, y: 930, width: 90, height: 90 } },
    { role: 'secondary', rect: { x: 550, y: 930, width: 90, height: 90 } },
  ],
});
