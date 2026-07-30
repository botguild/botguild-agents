// Social pack — story format (PRD §8, US-1) — exactly 1080x1920.
// Headline in the lower third, logo top-center, swatch row above the fold bottom.

import { createLayout } from './factory.js';

export const socialStory = createLayout({
  templateId: 'tf-social-story-v1',
  format: 'socialStory',
  width: 1080,
  height: 1920,
  backgroundHex: '#0E1116',
  headlineColor: '#FFFFFF',
  headlineAlign: 'center',
  headlineJustify: 'center',
  maxFontPx: 140,
  safeZone: { x: 90, y: 1180, width: 900, height: 560 },
  logoRect: { x: 460, y: 140, width: 160, height: 56 },
  swatchRegions: [
    { role: 'primary', rect: { x: 440, y: 1760, width: 90, height: 90 } },
    { role: 'secondary', rect: { x: 550, y: 1760, width: 90, height: 90 } },
  ],
});
