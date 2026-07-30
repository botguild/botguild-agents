// buildPack (FR-11 + FR-13): winner SVG in, fully gated brand pack out.
//
// Order matters. The true-vector gate runs FIRST and throws — every later step
// renders *from* this SVG, so building a pack from a raster-wrapping "SVG"
// would produce artifacts that all individually pass while the deliverable is
// exactly the fraud §9 exists to prevent.

import { FAVICON_SIZES, ICO_SIZES, MASTER_SIZES } from '../config.js';
import {
  checkDimensions,
  checkIco,
  checkTrueVector,
  checkZipCompleteness,
  readPngDimensions,
  type DimensionsResult,
  type IcoGateResult,
  type VectorGateResult,
  type ZipGateResult,
} from '../gates/index.js';
import type { FontPairing } from './fonts.js';
import { assembleIco } from './ico.js';
import { traceMonoSvg } from './mono.js';
import { extractPalette, type Swatch } from './palette.js';
import { renderSvgToPixmap, renderSvgToPng } from './render.js';
import type { WasmSources } from './wasm.js';
import { buildHtmlSnippet, buildWebmanifest, zipFiles } from './zip.js';

export interface PackInput {
  svg: string;
  brandName: string;
  sources: WasmSources;
  fonts: FontPairing;
}

export interface BrandJson {
  brandName: string;
  colors: Swatch[];
  fonts: FontPairing;
  licenseNote: string;
}

export interface PackGateReport {
  vector: VectorGateResult;
  dimensions: Array<{ file: string } & DimensionsResult>;
  ico: IcoGateResult;
  zip: ZipGateResult;
  pass: boolean;
}

export interface PackResult {
  zip: Uint8Array;
  files: Record<string, Uint8Array>;
  brand: BrandJson;
  gates: PackGateReport;
}

const FAVICON_FILENAMES: Record<number, string> = {
  16: 'favicon-16.png',
  32: 'favicon-32.png',
  48: 'favicon-48.png',
  180: 'apple-touch-icon.png',
  192: 'icon-192.png',
  512: 'icon-512.png',
};

export async function buildPack(input: PackInput): Promise<PackResult> {
  const { svg, brandName, sources, fonts } = input;

  const vector = checkTrueVector(svg);
  if (!vector.pass) {
    throw new Error(
      `refusing to build a pack: true-vector gate failed — ${vector.violations.join('; ')}`,
    );
  }

  const files: Record<string, Uint8Array> = {};
  const dimensions: Array<{ file: string } & DimensionsResult> = [];
  const encoder = new TextEncoder();

  const record = (file: string, png: Uint8Array, size: number): void => {
    files[file] = png;
    const actual = readPngDimensions(png) ?? { width: -1, height: -1 };
    dimensions.push({ file, ...checkDimensions(actual, { width: size, height: size }) });
  };

  // Masters and favicons are each rendered from the vector at their exact
  // target size — never resized from a larger raster (FR-11).
  for (const size of MASTER_SIZES) {
    record(`logo-color-${size}.png`, await renderSvgToPng(svg, size, sources), size);
  }
  for (const size of FAVICON_SIZES) {
    record(FAVICON_FILENAMES[size]!, await renderSvgToPng(svg, size, sources), size);
  }

  // Mono mark: threshold + trace the 1024px pixmap, then render its own master.
  const masterPixmap = await renderSvgToPixmap(svg, 1024, sources);
  const monoSvg = await traceMonoSvg(masterPixmap, sources);
  files['logo-mono.svg'] = encoder.encode(monoSvg);
  record('logo-mono-1024.png', await renderSvgToPng(monoSvg, 1024, sources), 1024);

  // favicon.ico reuses the already-rendered 16/32/48 PNGs.
  const ico = assembleIco(
    ICO_SIZES.map((size) => ({ size, png: files[FAVICON_FILENAMES[size]!]! })),
  );
  files['favicon.ico'] = ico;

  const brand: BrandJson = {
    brandName,
    colors: extractPalette(masterPixmap),
    fonts,
    licenseNote:
      'Colour codes are extracted from the delivered mark. The font pairing is an advisory ' +
      'recommendation and is not a warranted property of this delivery.',
  };

  files['logo.svg'] = encoder.encode(svg);
  files['site.webmanifest'] = encoder.encode(buildWebmanifest(brandName));
  files['snippet.html'] = encoder.encode(buildHtmlSnippet());
  files['brand.json'] = encoder.encode(JSON.stringify(brand, null, 2));

  const zip = zipFiles(files);
  const gates: PackGateReport = {
    vector,
    dimensions,
    ico: checkIco(ico),
    zip: checkZipCompleteness(zip),
    pass: false,
  };
  gates.pass =
    gates.vector.pass && gates.dimensions.every((d) => d.pass) && gates.ico.pass && gates.zip.pass;

  return { zip, files, brand, gates };
}
