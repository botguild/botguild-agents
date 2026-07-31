import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-wasm';
import { FAVICON_SIZES, ICO_SIZES } from '../config.js';
import { parseIco, readPngDimensions } from '../gates/index.js';
import { buildFaviconPack, decodeRasterSize, type FaviconSource } from './faviconPack.js';
import { renderSvgToPng } from './render.js';
import { nodeWasmSources } from './wasm.node.js';
import { FAVICON_ZIP_ENTRIES, REQUIRED_ZIP_ENTRIES, unzipFiles } from './zip.js';

const sources = nodeWasmSources();

/** Paths-only and square — the shape a well-behaved buyer logo has. */
const SQUARE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
  '<path d="M10 10 H90 V90 H10 Z" fill="#0F3D3E"/>' +
  '<circle cx="50" cy="50" r="22" fill="#E8C39E"/></svg>';

/**
 * 2:1 — the commonest real logo shape there is (a wordmark). Every assertion
 * about letterboxing is written against this, because a builder that squeezed
 * rather than letterboxed would still produce exactly-square PNGs and pass a
 * dimensions-only test.
 */
const WIDE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">' +
  '<rect width="200" height="100" fill="#0F3D3E"/></svg>';

/**
 * Eight concentric rings. At 512 px each ring is 32 px wide and survives as its
 * own tone; at 16 px a ring is half a pixel and they cannot all be represented
 * at once. Used to show the two ends of the size range hold genuinely different
 * IMAGE CONTENT, not one image at two scales.
 */
const RINGS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">' +
  '<rect width="256" height="256" fill="#ffffff"/>' +
  Array.from({ length: 8 }, (_, i) => {
    const shade = 20 + i * 28;
    const hex = shade.toString(16).padStart(2, '0');
    return `<circle cx="128" cy="128" r="${128 - i * 16}" fill="#${hex}${hex}${hex}"/>`;
  }).join('') +
  '</svg>';

/** Rendered once for the whole file — resvg init is the expensive part. */
const raster: Record<string, Uint8Array> = {};

before(async () => {
  raster['square512'] = await renderSvgToPng(SQUARE_SVG, 512, sources);
  raster['wide512'] = await renderSvgToPng(WIDE_SVG, 512, sources); // 512x256
  raster['small256'] = await renderSvgToPng(SQUARE_SVG, 256, sources);
});

const rasterSource = (key: string): FaviconSource => {
  const bytes = raster[key]!;
  const size = readPngDimensions(bytes)!;
  return { kind: 'raster', bytes, width: size.width, height: size.height };
};

/** Distinct 8-bit red levels present in a decoded PNG — a proxy for how much
 *  tonal detail the image can physically carry. */
async function distinctLevels(png: Uint8Array): Promise<number> {
  const photon = await import('@cf-wasm/photon');
  const image = photon.PhotonImage.new_from_byteslice(png);
  try {
    const pixels = image.get_raw_pixels();
    const levels = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4) levels.add(pixels[i]!);
    return levels.size;
  } finally {
    image.free();
  }
}

/** Decoded RGBA of a PNG, for the letterbox assertions. */
async function decodeRgba(
  png: Uint8Array,
): Promise<{ width: number; height: number; data: Uint8Array }> {
  const photon = await import('@cf-wasm/photon');
  const image = photon.PhotonImage.new_from_byteslice(png);
  try {
    return {
      width: image.get_width(),
      height: image.get_height(),
      data: new Uint8Array(image.get_raw_pixels()),
    };
  } finally {
    image.free();
  }
}

describe('decodeRasterSize', () => {
  it('reads the true dimensions of a PNG', async () => {
    assert.deepEqual(await decodeRasterSize(raster['square512']!), { width: 512, height: 512 });
    assert.deepEqual(await decodeRasterSize(raster['wide512']!), { width: 512, height: 256 });
  });

  it('reads the true dimensions of a JPEG, which has no fixed-offset header', async () => {
    // The fixture is produced by re-encoding the 512x512 PNG, so its expected
    // size is known independently of the function under test. Asserted to be a
    // real JPEG first, so this cannot silently become a second PNG test.
    const photon = await import('@cf-wasm/photon');
    const image = photon.PhotonImage.new_from_byteslice(raster['square512']!);
    const jpeg = new Uint8Array(image.get_bytes_jpeg(90));
    image.free();
    assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'fixture must be a JPEG');
    assert.equal(readPngDimensions(jpeg), null, 'a JPEG has no PNG IHDR to read');

    assert.deepEqual(await decodeRasterSize(jpeg), { width: 512, height: 512 });
  });

  it('returns null rather than throwing for bytes that are not a decodable image', async () => {
    assert.equal(await decodeRasterSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
    assert.equal(await decodeRasterSize(new Uint8Array(0)), null);
  });
});

describe('buildFaviconPack — the US-2 entry contract', () => {
  it('produces every FAVICON_ZIP_ENTRIES entry and nothing more', async () => {
    const source = rasterSource('square512');
    // Precondition, asserted inline: this test is about a 512 px source. If the
    // fixture ever stops being one, it must fail here rather than pass against
    // whatever it became.
    assert.deepEqual(
      { w: (source as { width: number }).width, h: (source as { height: number }).height },
      { w: 512, h: 512 },
    );

    const pack = await buildFaviconPack({ source, siteName: 'harborandvine.com', sources });
    assert.equal(pack.gates.pass, true, JSON.stringify(pack.gates));

    const entries = Object.keys(unzipFiles(pack.zip)).sort();
    assert.deepEqual(entries, [...FAVICON_ZIP_ENTRIES].sort());
    // ...and specifically NOT the paid pack's contract. Named individually
    // because "nothing more" above would still pass if FAVICON_ZIP_ENTRIES
    // itself grew a logo.svg.
    assert.equal(entries.includes('logo.svg'), false);
    assert.equal(entries.includes('logo-mono.svg'), false);
    assert.equal(entries.includes('brand.json'), false);
    assert.equal(entries.includes('logo-color-2048.png'), false);
    const paidOnly = REQUIRED_ZIP_ENTRIES.filter((name) => !FAVICON_ZIP_ENTRIES.includes(name));
    assert.ok(paidOnly.length > 0, 'the paid contract must be the larger of the two');
    for (const name of paidOnly) assert.equal(entries.includes(name), false, name);
  });

  it('writes every PNG at its exact contracted size, read from the IHDR', async () => {
    const pack = await buildFaviconPack({
      source: rasterSource('square512'),
      siteName: 'harborandvine.com',
      sources,
    });
    const zipped = unzipFiles(pack.zip);
    const expected: Record<string, number> = {
      'favicon-16.png': 16,
      'favicon-32.png': 32,
      'favicon-48.png': 48,
      'apple-touch-icon.png': 180,
      'icon-192.png': 192,
      'icon-512.png': 512,
    };
    for (const [file, size] of Object.entries(expected)) {
      assert.deepEqual(readPngDimensions(zipped[file]!), { width: size, height: size }, file);
    }
    // Every size in the config contract is covered by the map above — so this
    // test cannot go quiet if FAVICON_SIZES gains an entry.
    assert.deepEqual(
      Object.values(expected).sort((a, b) => a - b),
      [...FAVICON_SIZES],
    );
    assert.deepEqual(
      pack.gates.dimensions.filter((entry) => !entry.pass),
      [],
    );
  });

  it('assembles a favicon.ico that parses back to exactly the contracted sizes', async () => {
    const pack = await buildFaviconPack({
      source: rasterSource('square512'),
      siteName: 'harborandvine.com',
      sources,
    });
    const ico = unzipFiles(pack.zip)['favicon.ico']!;
    const parsed = parseIco(ico);
    assert.notEqual(parsed, null);
    assert.deepEqual(
      parsed!.entries.map((entry) => entry.width).sort((a, b) => a - b),
      [...ICO_SIZES],
    );
    // Each declared entry must actually contain a PNG at that size — the ICO
    // gate's real claim, checked here against the delivered bytes.
    for (const entry of parsed!.entries) {
      const payload = ico.subarray(entry.offset, entry.offset + entry.byteLength);
      assert.deepEqual(readPngDimensions(payload), {
        width: entry.width,
        height: entry.height,
      });
    }
    assert.equal(pack.gates.ico.pass, true);
    assert.deepEqual(pack.gates.ico.sizes, [...ICO_SIZES]);
  });

  it('names the webmanifest for the site the logo came from', async () => {
    const pack = await buildFaviconPack({
      source: rasterSource('square512'),
      siteName: 'harborandvine.com',
      sources,
    });
    const manifest = JSON.parse(
      new TextDecoder().decode(unzipFiles(pack.zip)['site.webmanifest']!),
    ) as { name: string };
    assert.equal(manifest.name, 'harborandvine.com');
  });
});

describe('buildFaviconPack — an SVG source renders from the vector', () => {
  it('runs one independent vector render per contracted size, and frees every handle', async () => {
    // The claim "each size is rendered from the vector" cannot be read off the
    // output bytes — a builder that rendered once and downscaled five times
    // would produce plausible PNGs at every size. It CAN be read off the
    // renderer: one Resvg render per size, and nothing else.
    await renderSvgToPng(SQUARE_SVG, 8, sources); // ensure resvg is initialized
    const probe = new Resvg(SQUARE_SVG, { fitTo: { mode: 'width', value: 8 } });
    const probeImage = probe.render();
    const renderedImageProto = Object.getPrototypeOf(probeImage) as { free(): void };
    probeImage.free();
    probe.free();

    const render = mock.method(Resvg.prototype, 'render');
    const resvgFree = mock.method(Resvg.prototype, 'free');
    const imageFree = mock.method(renderedImageProto, 'free');
    try {
      const pack = await buildFaviconPack({
        source: { kind: 'svg', svg: SQUARE_SVG },
        siteName: 'example.com',
        sources,
      });
      assert.equal(pack.gates.pass, true, JSON.stringify(pack.gates));
      assert.equal(render.mock.callCount(), FAVICON_SIZES.length);
      assert.equal(resvgFree.mock.callCount(), render.mock.callCount());
      assert.equal(imageFree.mock.callCount(), render.mock.callCount());
    } finally {
      render.mock.restore();
      resvgFree.mock.restore();
      imageFree.mock.restore();
    }
  });

  it('produces genuinely different image content at 16 px and 512 px', async () => {
    const pack = await buildFaviconPack({
      source: { kind: 'svg', svg: RINGS_SVG },
      siteName: 'example.com',
      sources,
    });
    const zipped = unzipFiles(pack.zip);
    const small = zipped['favicon-16.png']!;
    const large = zipped['icon-512.png']!;

    assert.notDeepEqual(small, large);
    assert.ok(large.byteLength > small.byteLength);

    // The eight declared ring tones survive at 512 px and cannot all survive at
    // 16 px, where a ring is half a pixel wide. So the two outputs are not one
    // image at two scales: the small one physically cannot carry the large
    // one's content.
    const largeLevels = await distinctLevels(large);
    const smallLevels = await distinctLevels(small);
    assert.ok(largeLevels >= 8, `512 px should carry every ring tone, saw ${largeLevels}`);
    assert.ok(
      smallLevels < largeLevels,
      `16 px cannot carry them all: ${smallLevels} vs ${largeLevels}`,
    );
  });
});

describe('buildFaviconPack — non-square sources are letterboxed, never squeezed', () => {
  for (const [label, makeSource] of [
    ['raster', (): FaviconSource => rasterSource('wide512')],
    ['svg', (): FaviconSource => ({ kind: 'svg', svg: WIDE_SVG })],
  ] as const) {
    it(`fits a 2:1 ${label} source inside the square and centres it on transparency`, async () => {
      const source = makeSource();
      if (source.kind === 'raster') {
        assert.deepEqual({ w: source.width, h: source.height }, { w: 512, h: 256 });
      }
      const pack = await buildFaviconPack({ source, siteName: 'example.com', sources });
      assert.equal(pack.gates.pass, true, JSON.stringify(pack.gates));

      const icon = await decodeRgba(unzipFiles(pack.zip)['icon-192.png']!);
      assert.deepEqual({ w: icon.width, h: icon.height }, { w: 192, h: 192 });

      const alphaAt = (x: number, y: number): number => icon.data[(y * icon.width + x) * 4 + 3]!;
      // Centre band: the mark. Top and bottom eighths: the letterbox.
      assert.equal(alphaAt(96, 96), 255, 'the mark must fill the centre');
      assert.equal(alphaAt(96, 4), 0, 'the top band must be transparent, not white');
      assert.equal(alphaAt(96, 187), 0, 'the bottom band must be transparent, not white');
      // A squeezed 2:1 source would have filled the full height instead.
      let opaqueRows = 0;
      for (let y = 0; y < icon.height; y++) if (alphaAt(96, y) > 0) opaqueRows += 1;
      assert.ok(
        opaqueRows > 80 && opaqueRows < 110,
        `a 2:1 mark should occupy about half the height, saw ${opaqueRows}/192`,
      );
    });
  }
});

describe('buildFaviconPack — photon memory discipline', () => {
  it('frees every PhotonImage the raster path creates', async () => {
    // Same class of regression guard as render.test.ts's resvg check: the
    // output bytes are copied out of wasm memory, so a build that dropped every
    // `.free()` would still return correct PNGs — and silently keep the isolate
    // at its high-water mark for good (Task 10: 129.5 MB against 128 MB).
    const photon = await import('@cf-wasm/photon');
    const free = mock.method(photon.PhotonImage.prototype, 'free');
    try {
      await buildFaviconPack({
        source: rasterSource('square512'),
        siteName: 'example.com',
        sources,
      });
      // One decode of the source, plus one resize per contracted size. The
      // source is square, so no size needs a letterbox canvas.
      assert.equal(free.mock.callCount(), 1 + FAVICON_SIZES.length);

      free.mock.resetCalls();
      await buildFaviconPack({
        source: rasterSource('wide512'),
        siteName: 'example.com',
        sources,
      });
      // Same, plus one letterbox canvas per size for the 2:1 source.
      assert.equal(free.mock.callCount(), 1 + 2 * FAVICON_SIZES.length);
    } finally {
      free.mock.restore();
    }
  });
});

describe('buildFaviconPack — never upscales', () => {
  it('renders the 512 px icon 1:1 from a 512 px source rather than inventing pixels', async () => {
    // The admission rule (fetchSourceLogo) exists to make this true: the
    // largest contracted icon is exactly MIN_SOURCE_PX, so a source at the
    // minimum is copied at scale 1 and nothing above it is ever synthesised.
    const source = rasterSource('square512');
    const pack = await buildFaviconPack({ source, siteName: 'example.com', sources });
    const icon = await decodeRgba(unzipFiles(pack.zip)['icon-512.png']!);
    const original = await decodeRgba(raster['square512']!);
    assert.deepEqual({ w: icon.width, h: icon.height }, { w: 512, h: 512 });

    // A Lanczos resize at scale 1 is not bit-identical to a copy, but it cannot
    // move an edge: sample the same interior and corner points in both.
    for (const [x, y] of [
      [256, 256],
      [64, 64],
      [448, 448],
      [2, 2],
    ] as const) {
      const i = (y * 512 + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        assert.ok(
          Math.abs(icon.data[i + channel]! - original.data[i + channel]!) <= 2,
          `channel ${channel} at ${x},${y} moved: ${icon.data[i + channel]} vs ${original.data[i + channel]}`,
        );
      }
    }
  });

  it('still refuses to grow a source below the minimum — the guard is the fetch, not the builder', async () => {
    // Documents where the never-upscale guarantee actually lives. Handed a
    // 256 px source directly (which fetchSourceLogo would have refused), the
    // builder letterboxes rather than upscales: the 512 px icon carries a
    // 256 px mark on transparency, so no pixel is invented here either.
    const source = rasterSource('small256');
    assert.deepEqual(
      { w: (source as { width: number }).width, h: (source as { height: number }).height },
      { w: 256, h: 256 },
    );
    const pack = await buildFaviconPack({ source, siteName: 'example.com', sources });
    const icon = await decodeRgba(unzipFiles(pack.zip)['icon-512.png']!);
    assert.deepEqual({ w: icon.width, h: icon.height }, { w: 512, h: 512 });
    const alphaAt = (x: number, y: number): number => icon.data[(y * 512 + x) * 4 + 3]!;
    assert.equal(alphaAt(256, 4), 0, 'the surround must be transparent letterbox, not upscale');
    assert.equal(alphaAt(256, 256), 255, 'the mark itself must still be there');
  });
});
