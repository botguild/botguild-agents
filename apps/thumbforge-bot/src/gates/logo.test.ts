import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLogo, logoZOrderClear } from './logo.js';
import type { DrawNode } from '../layouts/types.js';
import type { Rect } from '../types.js';
import { fillRect, solidPixmap } from '../testSupport.js';
import { hexToRgb } from './color.js';

const LOGO_RECT: Rect = { x: 100, y: 40, width: 160, height: 56 };
const LOGO_RGB = hexToRgb('#0F1E3C');
const BG_RGB = hexToRgb('#0E1116');

/** A 1200x200 dark canvas with the logo painted into its rect. */
function canvasWithLogo(): ReturnType<typeof solidPixmap> {
  const pixmap = solidPixmap(1200, 200, BG_RGB);
  fillRect(pixmap, LOGO_RECT, LOGO_RGB);
  return pixmap;
}

const expected = solidPixmap(LOGO_RECT.width, LOGO_RECT.height, LOGO_RGB);

const drawOrderLogoTop: DrawNode[] = [
  { id: 'headline', rect: { x: 60, y: 100, width: 800, height: 80 }, z: 1 },
  { id: 'logo', rect: LOGO_RECT, z: 2 },
];

test('a correctly composited logo passes (>=90% similar) with clear z-order', () => {
  const result = checkLogo(canvasWithLogo(), LOGO_RECT, expected, drawOrderLogoTop);
  assert.equal(result.pass, true);
  assert.ok(result.similarity >= 0.9);
  assert.equal(result.zOrderClear, true);
});

test('a missing logo (rect is background) fails on similarity', () => {
  const blank = solidPixmap(1200, 200, BG_RGB);
  const result = checkLogo(blank, LOGO_RECT, expected, drawOrderLogoTop);
  assert.equal(result.pass, false);
  assert.ok(result.similarity < 0.9);
});

test('z-order fails when something is composited above the logo rect', () => {
  const occluded: DrawNode[] = [
    { id: 'logo', rect: LOGO_RECT, z: 2 },
    { id: 'overlay', rect: { x: 120, y: 50, width: 60, height: 30 }, z: 3 },
  ];
  assert.equal(logoZOrderClear(occluded, LOGO_RECT, 'logo'), false);
  const result = checkLogo(canvasWithLogo(), LOGO_RECT, expected, occluded);
  assert.equal(result.pass, false, 'pixel-similar but occluded → still fails');
});

test('z-order clear when overlapping blocks are painted below the logo', () => {
  const below: DrawNode[] = [
    { id: 'panel', rect: { x: 0, y: 0, width: 1200, height: 200 }, z: 1 },
    { id: 'logo', rect: LOGO_RECT, z: 2 },
  ];
  assert.equal(logoZOrderClear(below, LOGO_RECT, 'logo'), true);
});

test('z-order fails when the logo id is absent from the draw list', () => {
  assert.equal(logoZOrderClear(drawOrderLogoTop, LOGO_RECT, 'nonexistent'), false);
});
