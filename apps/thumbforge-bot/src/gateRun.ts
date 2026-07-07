// ---------------------------------------------------------------------------
// Pre-delivery gate orchestration (§9 blocking gates), PURE over the render
// output + the encoded buffer. No Workers globals and no I/O — the R2 read-back
// byte-equality leg and the URL-probe leg live in the Worker (index.ts); this
// runs the in-process pixel/metadata gates in the §9 order:
//   dimensions → file-size/quality-floor → brand color (ΔE) → logo (+ z-order)
//   → headline min-font (FR-6).
// ---------------------------------------------------------------------------

import {
  JPEG_QUALITY_FLOOR,
  LOGO_MIN_SIMILARITY,
  MAX_DELTA_E,
  MAX_FILE_BYTES,
} from './config.js';
import { checkDimensions, type DimensionsResult } from './gates/dimensions.js';
import { checkFileSize, type FileSizeDecision } from './gates/filesize.js';
import { checkColor, type ColorRegionExpectation, type ColorResult } from './gates/color.js';
import { checkLogo, type LogoResult } from './gates/logo.js';
import { decideHeadline, type HeadlineDecision } from './headline.js';
import { resolveSwatchHex, solidLogoRaster } from './layouts/common.js';
import type { LayoutDescriptor } from './layouts/types.js';
import type { RenderOutput } from './render/index.js';
import type { EncodeResult } from './render/encodeTypes.js';
import type { BrandKit } from './types.js';

export interface GateReport {
  pass: boolean;
  dimensions: DimensionsResult;
  fileSize: FileSizeDecision;
  color: ColorResult;
  logo: LogoResult;
  headline: HeadlineDecision;
}

/** Map a layout's declared swatch regions to ΔE expectations against the kit. */
export function swatchExpectations(
  layout: LayoutDescriptor,
  brandKit: BrandKit,
): ColorRegionExpectation[] {
  return layout.swatchRegions.map((region) => ({
    role: region.role,
    rect: region.rect,
    expectedHex: resolveSwatchHex(brandKit, region.role),
  }));
}

/**
 * Run every in-process blocking gate against one rendered graphic. `encoded` is
 * the buffer `RenderOutput.encode` produced (PNG, or JPEG at/above the floor).
 */
export function runGates(
  layout: LayoutDescriptor,
  brandKit: BrandKit,
  out: RenderOutput,
  encoded: EncodeResult,
): GateReport {
  const dimensions = checkDimensions(out.pixmap, { width: layout.width, height: layout.height });
  const fileSize = checkFileSize(encoded, {
    maxBytes: MAX_FILE_BYTES,
    jpegQualityFloor: JPEG_QUALITY_FLOOR,
  });
  const color = checkColor(out.pixmap, swatchExpectations(layout, brandKit), { maxDeltaE: MAX_DELTA_E });

  // Compare against the exact raster the layout composited (§9 post-recolor
  // reference): the buyer's logo when supplied, else the solid brand-color
  // logomark the layout painted.
  const expectedLogo =
    brandKit.logo ?? solidLogoRaster(out.logoRect, resolveSwatchHex(brandKit, 'primary'));
  const logo = checkLogo(out.pixmap, out.logoRect, expectedLogo, out.drawOrder, {
    minSimilarity: LOGO_MIN_SIMILARITY,
  });

  const headline = decideHeadline(out.headlineFits, out.headlineFontPx, layout.minFontPx);

  return {
    pass:
      dimensions.pass && fileSize.pass && color.pass && logo.pass && headline.accept,
    dimensions,
    fileSize,
    color,
    logo,
    headline,
  };
}
