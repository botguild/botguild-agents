import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkColor, ciede2000, deltaE, hexToRgb, rgbToLab, sampleRegion, type Lab } from './color.js';
import { solidPixmap } from '../testSupport.js';

// Reference pairs from Sharma, Wu & Dalal (2005), "The CIEDE2000 Color-Difference
// Formula" — the canonical implementation test set (Table 1).
const REFERENCE: Array<[Lab, Lab, number]> = [
  [{ L: 50, a: 2.6772, b: -79.7751 }, { L: 50, a: 0, b: -82.7485 }, 2.0425],
  [{ L: 50, a: 3.1571, b: -77.2803 }, { L: 50, a: 0, b: -82.7485 }, 2.8615],
  [{ L: 50, a: 2.8361, b: -74.02 }, { L: 50, a: 0, b: -82.7485 }, 3.4412],
  [{ L: 50, a: -1.3802, b: -84.2814 }, { L: 50, a: 0, b: -82.7485 }, 1.0],
  [{ L: 50, a: 0, b: 0 }, { L: 50, a: -1, b: 2 }, 2.3669],
  [{ L: 50, a: 2.49, b: -0.001 }, { L: 50, a: -2.49, b: 0.0009 }, 7.1792],
  [{ L: 50, a: 2.5, b: 0 }, { L: 73, a: 25, b: -18 }, 27.1492],
];

test('CIEDE2000 matches the Sharma et al. reference pairs', () => {
  for (const [lab1, lab2, expected] of REFERENCE) {
    const got = ciede2000(lab1, lab2);
    assert.ok(
      Math.abs(got - expected) < 5e-3,
      `expected ΔE ${expected} for ${JSON.stringify(lab1)}/${JSON.stringify(lab2)}, got ${got}`,
    );
  }
});

test('identical colors have ΔE 0; the formula is symmetric', () => {
  const a = hexToRgb('#FF6B5E');
  const b = hexToRgb('#0F1E3C');
  assert.equal(deltaE(a, a), 0);
  assert.ok(Math.abs(deltaE(a, b) - deltaE(b, a)) < 1e-9);
});

test('rgbToLab places pure white near L=100, a=b=0', () => {
  const lab = rgbToLab({ r: 255, g: 255, b: 255 });
  assert.ok(Math.abs(lab.L - 100) < 1e-6);
  // a/b sit within rounding of the published sRGB→XYZ matrix constants.
  assert.ok(Math.abs(lab.a) < 0.5 && Math.abs(lab.b) < 0.5);
});

test('sampleRegion averages the rect; a solid swatch clears ΔE ≤ 4', () => {
  const hex = '#FF6B5E';
  const pixmap = solidPixmap(200, 200, hexToRgb(hex));
  const sampled = sampleRegion(pixmap, { x: 10, y: 10, width: 40, height: 40 });
  assert.ok(deltaE(sampled, hexToRgb(hex)) < 0.5);
});

test('checkColor passes matching swatches and fails an off-brand region', () => {
  const pixmap = solidPixmap(240, 120, hexToRgb('#0F1E3C'));
  // Paint a second swatch region a different brand color.
  const secondary = hexToRgb('#FF6B5E');
  for (let y = 0; y < 120; y++) {
    for (let x = 120; x < 240; x++) {
      const i = (y * 240 + x) * 4;
      pixmap.data[i] = secondary.r;
      pixmap.data[i + 1] = secondary.g;
      pixmap.data[i + 2] = secondary.b;
    }
  }
  const pass = checkColor(pixmap, [
    { role: 'primary', rect: { x: 0, y: 0, width: 120, height: 120 }, expectedHex: '#0F1E3C' },
    { role: 'secondary', rect: { x: 120, y: 0, width: 120, height: 120 }, expectedHex: '#FF6B5E' },
  ]);
  assert.equal(pass.pass, true);
  assert.ok(pass.maxDeltaE < 4);

  const fail = checkColor(pixmap, [
    { role: 'primary', rect: { x: 0, y: 0, width: 120, height: 120 }, expectedHex: '#FF6B5E' },
  ]);
  assert.equal(fail.pass, false);
  assert.ok(fail.regions[0]!.deltaE > 4);
});
