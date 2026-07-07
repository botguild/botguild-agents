// ---------------------------------------------------------------------------
// Layout factory — turns a declarative config into a LayoutDescriptor.
//
// Shared render pipeline for every layout: fit the headline to the safe zone,
// paint optional decorative panels, paint the declared swatch regions in the
// brand palette, place the headline, and finally place the logo on top. The
// returned metadata (final headline px, fit flag, logo rect, draw order) is
// exactly what the §9 gates consume.
// ---------------------------------------------------------------------------

import type { BrandKit, JobInputs, Rect, SwatchRegion } from '../types.js';
import { fitHeadline } from './fit.js';
import { compose, resolveSwatchHex, solidBox, textBox, type Layer } from './common.js';
import { minFontForHeight, type LayoutDescriptor, type LayoutRenderResult } from './types.js';

export interface LayoutConfig {
  templateId: string;
  format: LayoutDescriptor['format'];
  width: number;
  height: number;
  safeZone: Rect;
  logoRect: Rect;
  swatchRegions: SwatchRegion[];
  backgroundHex: string;
  headlineColor: string;
  /** Logo fill. Defaults to the primary palette color (a self-consistent recolor reference). */
  logoHex?: string;
  headlineAlign?: 'left' | 'center' | 'right';
  headlineJustify?: 'flex-start' | 'center' | 'flex-end';
  /** Largest headline size to attempt before fitting down. */
  maxFontPx: number;
  /** Optional decorative solid panels, painted under the swatches/headline. */
  panels?: (brandKit: BrandKit) => Layer[];
}

/** Choose the headline text from the job inputs (headline wins, then title). */
export function pickHeadline(inputs: JobInputs): string {
  return (inputs.headline ?? inputs.title ?? '').trim();
}

export function createLayout(config: LayoutConfig): LayoutDescriptor {
  const minFontPx = minFontForHeight(config.height);

  function render(brandKit: BrandKit, inputs: JobInputs): LayoutRenderResult {
    const headline = pickHeadline(inputs);
    const fit = fitHeadline(headline, {
      safeZone: config.safeZone,
      maxPx: config.maxFontPx,
      minPx: minFontPx,
    });

    const panelLayers = config.panels ? config.panels(brandKit) : [];
    const swatchLayers: Layer[] = config.swatchRegions.map((region) => ({
      id: `swatch:${region.role}`,
      rect: region.rect,
      node: solidBox(region.rect, resolveSwatchHex(brandKit, region.role)),
    }));
    const headlineLayer: Layer = {
      id: 'headline',
      rect: config.safeZone,
      node: textBox(config.safeZone, headline, {
        fontPx: fit.fontPx,
        color: config.headlineColor,
        weight: 700,
        align: config.headlineAlign ?? 'left',
        justify: config.headlineJustify ?? 'center',
      }),
    };
    const logoHex = config.logoHex ?? resolveSwatchHex(brandKit, 'primary');
    const logoLayer: Layer = {
      id: 'logo',
      rect: config.logoRect,
      node: solidBox(config.logoRect, logoHex, { borderRadius: 6 }),
    };

    // Logo is last → top-most: the z-order invariant the logo gate asserts.
    const layers = [...panelLayers, ...swatchLayers, headlineLayer, logoLayer];
    const { element, drawOrder } = compose(config.width, config.height, config.backgroundHex, layers);

    return {
      element,
      headlineFontPx: fit.fontPx,
      headlineFits: fit.fits,
      logoRect: config.logoRect,
      drawOrder,
    };
  }

  return {
    templateId: config.templateId,
    format: config.format,
    width: config.width,
    height: config.height,
    safeZone: config.safeZone,
    logoRect: config.logoRect,
    swatchRegions: config.swatchRegions,
    minFontPx,
    render,
  };
}
