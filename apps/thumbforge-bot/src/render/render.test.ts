// Golden render test (PRD Phase-2 calibration smoke test, §14): satori + resvg
// render the real og layout in Node and the §9 gates run against the actual
// output — exact 1200x630 dims, brand color at the swatch regions, logo present
// with clear z-order — plus the PNG/JPEG encode paths and the A/B pHash gate on
// real thumbnail renders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLayout, MAX_FILE_BYTES, type RenderOptions } from './index.js';
import { og, thumbnailA, thumbnailB } from '../layouts/index.js';
import { resolveSwatchHex, solidLogoRaster } from '../layouts/common.js';
import { loadFontsNode } from '../fonts/node.js';
import { nodeWasmSources } from './wasm.node.js';
import { checkDimensions } from '../gates/dimensions.js';
import { checkColor, type ColorRegionExpectation } from '../gates/color.js';
import { checkLogo } from '../gates/logo.js';
import { checkFileSize } from '../gates/filesize.js';
import { checkABDistinct } from '../gates/phash.js';
import type { BrandKit } from '../types.js';

const brandKit: BrandKit = {
  palette: ['#0F1E3C', '#FF6B5E', '#F5C518'],
  swatchRegions: [],
};
const job = { headline: 'Ship spec-locked images the instant you publish' };

// Fonts + wasm are shared across the render tests (isolate-singleton wasm init).
const options: RenderOptions = { fonts: await loadFontsNode(), wasm: nodeWasmSources() };

const swatchExpectations = (): ColorRegionExpectation[] =>
  og.swatchRegions.map((region) => ({
    role: region.role,
    rect: region.rect,
    expectedHex: resolveSwatchHex(brandKit, region.role),
  }));

test('golden: og renders to exactly 1200x630 and clears dimensions/color/logo gates', async () => {
  const out = await renderLayout(og, { brandKit, job }, options);

  assert.equal(out.pixmap.width, 1200);
  assert.equal(out.pixmap.height, 630);
  assert.equal(checkDimensions(out.pixmap, { width: og.width, height: og.height }).pass, true);

  const color = checkColor(out.pixmap, swatchExpectations());
  assert.equal(color.pass, true, `color gate failed: maxΔE=${color.maxDeltaE}`);

  const expectedLogo = solidLogoRaster(og.logoRect, resolveSwatchHex(brandKit, 'primary'));
  const logo = checkLogo(out.pixmap, out.logoRect, expectedLogo, out.drawOrder);
  assert.equal(
    logo.pass,
    true,
    `logo gate failed: similarity=${logo.similarity} zClear=${logo.zOrderClear}`,
  );

  assert.equal(out.headlineFits, true);
  assert.ok(out.headlineFontPx >= og.minFontPx);
});

test('og encodes as PNG under the 2MB ceiling by default', async () => {
  const out = await renderLayout(og, { brandKit, job }, options);
  const encoded = await out.encode();
  assert.equal(encoded.format, 'png');
  assert.ok(encoded.byteLength < MAX_FILE_BYTES);
  assert.equal(checkFileSize(encoded).pass, true);
});

test('a tiny ceiling drives the mozjpeg JPEG path and never drops below the quality floor', async () => {
  const out = await renderLayout(og, { brandKit, job }, options);
  const encoded = await out.encode({ maxBytes: 4096, jpegQualityFloor: 70 });
  assert.equal(encoded.format, 'jpeg');
  assert.ok((encoded.quality ?? 0) >= 70);
});

test('the A/B thumbnail variants clear the pHash + distinct-template gate on real renders', async () => {
  const headline = 'Ten ideas that actually worked';
  const a = await renderLayout(thumbnailA, { brandKit, job: { headline } }, options);
  const b = await renderLayout(thumbnailB, { brandKit, job: { headline } }, options);
  const result = checkABDistinct(a.pixmap, b.pixmap, a.templateId, b.templateId);
  assert.equal(result.pass, true, `A/B distinctness failed: distance=${result.distance}`);
});
