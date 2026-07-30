import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, THUMBNAIL_VARIANTS, minFontForHeight, og } from './index.js';
import { fitHeadline } from './fit.js';
import type { BrandKit, Rect } from '../types.js';
import type { LayoutDescriptor } from './types.js';

const brandKit: BrandKit = {
  palette: ['#0F1E3C', '#FF6B5E', '#F5C518'],
  swatchRegions: [],
};

const contains = (outer: { width: number; height: number }, rect: Rect): boolean =>
  rect.x >= 0 &&
  rect.y >= 0 &&
  rect.x + rect.width <= outer.width &&
  rect.y + rect.height <= outer.height;

test('min font floor scales from the 32px @ 720 baseline', () => {
  assert.equal(minFontForHeight(720), 32);
  assert.equal(minFontForHeight(630), 28);
  assert.equal(minFontForHeight(1080), 48);
  assert.equal(minFontForHeight(1920), 85);
});

test('every layout keeps its safe zone, logo, and swatch rects on-canvas', () => {
  for (const layout of Object.values(LAYOUTS)) {
    assert.ok(contains(layout, layout.safeZone), `${layout.templateId} safe zone off-canvas`);
    assert.ok(contains(layout, layout.logoRect), `${layout.templateId} logo off-canvas`);
    for (const region of layout.swatchRegions) {
      assert.ok(
        contains(layout, region.rect),
        `${layout.templateId} swatch ${region.role} off-canvas`,
      );
    }
    assert.equal(layout.minFontPx, minFontForHeight(layout.height));
  }
});

test('layout template ids are unique and match the expected target dimensions', () => {
  const ids = Object.values(LAYOUTS).map((l) => l.templateId);
  assert.equal(new Set(ids).size, ids.length);
  const dims = (l: LayoutDescriptor) => `${l.width}x${l.height}`;
  assert.equal(dims(LAYOUTS['tf-og-v1']!), '1200x630');
  assert.equal(dims(LAYOUTS['tf-thumb-a-v1']!), '1280x720');
  assert.equal(dims(LAYOUTS['tf-thumb-b-v1']!), '1280x720');
  assert.equal(dims(LAYOUTS['tf-social-feed-v1']!), '1080x1080');
  assert.equal(dims(LAYOUTS['tf-social-story-v1']!), '1080x1920');
});

test('the A/B thumbnail variants are distinct templates', () => {
  const [a, b] = THUMBNAIL_VARIANTS;
  assert.notEqual(a.templateId, b.templateId);
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
});

test('fitHeadline picks the largest size that fits and clears the floor', () => {
  const safeZone: Rect = { x: 0, y: 0, width: 820, height: 320 };
  const fit = fitHeadline('Ship on-brand images', { safeZone, maxPx: 84, minPx: 28 });
  assert.ok(fit.fits);
  assert.ok(fit.fontPx >= 28 && fit.fontPx <= 84);
});

test('an over-long headline falls below the floor and is flagged for reject (FR-6)', () => {
  const longHeadline =
    'This headline is far too long to ever fit inside a single OG safe zone at a legible size no matter how much it wraps because it simply contains too many words'.repeat(
      6,
    );
  const rendered = og.render(brandKit, { headline: longHeadline });
  assert.equal(rendered.headlineFits, false);
  assert.ok(rendered.headlineFontPx < og.minFontPx);
});

test('a normal headline renders at or above the floor and reports the size used', () => {
  const rendered = og.render(brandKit, { headline: 'On-brand in one publish' });
  assert.equal(rendered.headlineFits, true);
  assert.ok(rendered.headlineFontPx >= og.minFontPx);
  assert.equal(rendered.logoRect.width, og.logoRect.width);
  // Logo is the top-most block in the draw order.
  const topZ = Math.max(...rendered.drawOrder.map((d) => d.z));
  assert.equal(rendered.drawOrder.find((d) => d.id === 'logo')?.z, topZ);
});
