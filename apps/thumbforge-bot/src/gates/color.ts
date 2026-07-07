// ---------------------------------------------------------------------------
// Brand-color gate (PRD §9, FR-10): ΔE (CIEDE2000) at declared solid swatch
// regions vs the kit hex, default ΔE ≤ 4. Strict hex equality is not promised
// (JPEG would false-fail). The CIEDE2000 implementation follows Sharma, Wu &
// Dalal (2005) and is unit-tested against their published reference pairs.
// ---------------------------------------------------------------------------

import type { Pixmap, RGB, Rect } from '../types.js';

export const DEFAULT_MAX_DELTA_E = 4;

export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** Parse `#RGB` / `#RRGGBB` into 0–255 components. */
export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = Number.parseInt(h, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB (0–255) → CIE Lab under the D65 reference white. */
export function rgbToLab({ r, g, b }: RGB): Lab {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);

  // Linear sRGB → XYZ (D65), scaled to 0–100.
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) * 100;
  const y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) * 100;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) * 100;

  // D65 reference white.
  const xn = 95.047;
  const yn = 100.0;
  const zn = 108.883;
  const delta = 6 / 29;
  const f = (t: number): number => (t > delta ** 3 ? Math.cbrt(t) : t / (3 * delta * delta) + 4 / 29);

  const fx = f(x / xn);
  const fy = f(y / yn);
  const fz = f(z / zn);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** CIEDE2000 color difference between two Lab colors. */
export function ciede2000(lab1: Lab, lab2: Lab): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const cBar = (C1 + C2) / 2;
  const cBar7 = cBar ** 7;
  const G = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const hp = (b: number, ap: number): number => {
    if (b === 0 && ap === 0) return 0;
    const h = (Math.atan2(b, ap) * 180) / Math.PI;
    return h >= 0 ? h : h + 360;
  };
  const h1p = hp(b1, a1p);
  const h2p = hp(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp: number;
  if (C1p * C2p === 0) {
    dhp = 0;
  } else {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2);

  const lBarp = (L1 + L2) / 2;
  const cBarp = (C1p + C2p) / 2;

  let hBarp: number;
  if (C1p * C2p === 0) {
    hBarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) > 180) {
    hBarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  } else {
    hBarp = (h1p + h2p) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos(rad(hBarp - 30)) +
    0.24 * Math.cos(rad(2 * hBarp)) +
    0.32 * Math.cos(rad(3 * hBarp + 6)) -
    0.2 * Math.cos(rad(4 * hBarp - 63));

  const dTheta = 30 * Math.exp(-(((hBarp - 275) / 25) ** 2));
  const cBarp7 = cBarp ** 7;
  const Rc = 2 * Math.sqrt(cBarp7 / (cBarp7 + 25 ** 7));
  const Sl = 1 + (0.015 * (lBarp - 50) ** 2) / Math.sqrt(20 + (lBarp - 50) ** 2);
  const Sc = 1 + 0.045 * cBarp;
  const Sh = 1 + 0.015 * cBarp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;

  return Math.sqrt(
    (dLp / Sl) ** 2 +
      (dCp / Sc) ** 2 +
      (dHp / Sh) ** 2 +
      Rt * (dCp / Sc) * (dHp / Sh),
  );
}

/** ΔE between two sRGB hex/RGB colors. */
export function deltaE(a: RGB, b: RGB): number {
  return ciede2000(rgbToLab(a), rgbToLab(b));
}

/** Average RGB over a rect (clamped to the pixmap bounds). Alpha is ignored. */
export function sampleRegion(pixmap: Pixmap, rect: Rect): RGB {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(pixmap.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(pixmap.height, Math.ceil(rect.y + rect.height));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * pixmap.width + x) * 4;
      r += pixmap.data[i] ?? 0;
      g += pixmap.data[i + 1] ?? 0;
      b += pixmap.data[i + 2] ?? 0;
      count++;
    }
  }
  if (count === 0) return { r: 0, g: 0, b: 0 };
  return { r: r / count, g: g / count, b: b / count };
}

export interface ColorRegionExpectation {
  role: string;
  rect: Rect;
  expectedHex: string;
}

export interface ColorRegionResult {
  role: string;
  deltaE: number;
  sampled: RGB;
  expected: RGB;
  pass: boolean;
}

export interface ColorResult {
  pass: boolean;
  maxDeltaE: number;
  threshold: number;
  regions: ColorRegionResult[];
}

/** Sample every declared swatch region and assert ΔE ≤ threshold against the kit hex. */
export function checkColor(
  pixmap: Pixmap,
  expectations: ColorRegionExpectation[],
  options: { maxDeltaE?: number } = {},
): ColorResult {
  const threshold = options.maxDeltaE ?? DEFAULT_MAX_DELTA_E;
  const regions: ColorRegionResult[] = expectations.map((expectation) => {
    const sampled = sampleRegion(pixmap, expectation.rect);
    const expected = hexToRgb(expectation.expectedHex);
    const dE = deltaE(sampled, expected);
    return { role: expectation.role, deltaE: dE, sampled, expected, pass: dE <= threshold };
  });
  const maxDeltaE = regions.reduce((m, r) => Math.max(m, r.deltaE), 0);
  return { pass: regions.every((r) => r.pass), maxDeltaE, threshold, regions };
}
