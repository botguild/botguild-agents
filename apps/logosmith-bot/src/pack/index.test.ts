import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FAVICON_SIZES } from '../config.js';
import { readPngDimensions } from '../gates/dimensions.js';
import type { OcrGate, OcrOutcome } from '../gates/ocr.js';
import { SCOUT_MODEL_ID } from '../config.js';
import { INK_PROBE_PX } from './faviconPack.js';
import { renderSvgToPixmap } from './render.js';
import { REQUIRED_ZIP_ENTRIES, unzipFiles } from './zip.js';
import { buildPack } from './index.js';
import { nodeWasmSources } from './wasm.node.js';

const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M20 20 H80 V80 H20 Z" fill="#0F3D3E"/>' +
  '<circle cx="50" cy="50" r="15" fill="#E8C39E"/></svg>';

/**
 * The shape that produced the bug: a WIDE LOCKUP — a wordmark with a distinct
 * mark above its left end — sitting on an opaque field inside a square canvas.
 * That is exactly the JiffyApp delivery's anatomy, square viewBox included
 * (the masters must stay square or the dimensions gate fails for an unrelated
 * reason and proves nothing about favicons).
 *
 * `#47bcba` is the mark and `#ffffff` the lettering, so a delivered favicon
 * can be proven to hold one and not the other by counting pixels.
 */
const LETTERS = [0, 1, 2, 3, 4]
  .map((i) => `<rect x="${30 + i * 30}" y="210" width="18" height="60" fill="#ffffff"/>`)
  .join('');

const WIDE_LOCKUP =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
  '<rect width="400" height="400" fill="#0f2027"/>' +
  '<circle cx="60" cy="155" r="30" fill="#47bcba"/>' +
  LETTERS +
  '</svg>';

/** The same lockup with the mark deleted: nothing here but lettering. */
const WORDMARK_ONLY =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
  '<rect width="400" height="400" fill="#0f2027"/>' +
  LETTERS +
  '</svg>';

const fonts = {
  heading: { family: 'Inter', category: 'sans-serif', license: 'OFL', url: 'https://x' },
  body: { family: 'Source Serif 4', category: 'serif', license: 'OFL', url: 'https://y' },
  note: 'advisory',
};

/** A readback that reports exactly what it is told to, and no image ever moves. */
const stubOcr = (outcome: OcrOutcome): OcrGate => ({ check: async () => outcome });

const readback = (transcription: string): OcrOutcome => ({
  status: 'ok',
  verdict: {
    model: SCOUT_MODEL_ID,
    transcription,
    score: 0,
    unsafe: false,
    pass: true,
    checkedAt: '2026-08-04T00:00:00.000Z',
  },
});

/** A vision model that saw nothing — must not be able to refute a crop. */
const OCR_DOWN: OcrOutcome = { status: 'unavailable', error: 'workers ai 503' };

/**
 * Decode a delivered PNG by handing it back to resvg inside a data URI — the
 * same trick the pipeline's pHash path uses, so the test needs no second
 * image decoder.
 */
async function decodePng(
  png: Uint8Array,
  size: number,
  sources: ReturnType<typeof nodeWasmSources>,
): Promise<{ mark: number; lettering: number }> {
  const base64 = Buffer.from(png).toString('base64');
  const pixmap = await renderSvgToPixmap(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
      `viewBox="0 0 ${size} ${size}"><image width="${size}" height="${size}" ` +
      `href="data:image/png;base64,${base64}"/></svg>`,
    size,
    sources,
  );
  let mark = 0;
  let lettering = 0;
  for (let i = 0; i < pixmap.data.length; i += 4) {
    const r = pixmap.data[i]!;
    const g = pixmap.data[i + 1]!;
    const b = pixmap.data[i + 2]!;
    if (r < 120 && g > 150 && b > 150) mark++;
    if (r > 220 && g > 220 && b > 220) lettering++;
  }
  return { mark, lettering };
}

describe('buildPack', () => {
  it('produces every §8 entry and passes every gate', async () => {
    const result = await buildPack({
      svg: MARK_SVG,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
    });
    assert.equal(result.gates.pass, true, JSON.stringify(result.gates, null, 2));
    const files = unzipFiles(result.zip);
    for (const name of REQUIRED_ZIP_ENTRIES) {
      assert.ok(name in files, `missing pack entry: ${name}`);
    }
  });

  it('renders every favicon at its exact contracted size', async () => {
    const result = await buildPack({
      svg: MARK_SVG,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
    });
    const expected: Array<[string, number]> = [
      ['favicon-16.png', 16],
      ['favicon-32.png', 32],
      ['favicon-48.png', 48],
      ['apple-touch-icon.png', 180],
      ['icon-192.png', 192],
      ['icon-512.png', 512],
      ['logo-color-1024.png', 1024],
      ['logo-color-2048.png', 2048],
    ];
    for (const [file, size] of expected) {
      assert.deepEqual(readPngDimensions(result.files[file]!), { width: size, height: size }, file);
    }
  });

  it('writes brand.json with extracted hex codes and the font pairing', async () => {
    const result = await buildPack({
      svg: MARK_SVG,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
    });
    assert.ok(result.brand.colors.length > 0);
    assert.match(result.brand.colors[0]!.hex, /^#[0-9a-f]{6}$/);
    assert.equal(result.brand.fonts.heading.family, 'Inter');
    assert.match(result.brand.licenseNote, /advisory|not.*warrant/i);
  });

  it('refuses to build a pack from an SVG that fails the vector gate', async () => {
    await assert.rejects(
      () =>
        buildPack({
          svg: '<svg viewBox="0 0 10 10"><image href="data:image/png;base64,x"/></svg>',
          brandName: 'Nope',
          sources: nodeWasmSources(),
          fonts,
        }),
      /true-vector/i,
    );
  });
});

// ---------------------------------------------------------------------------
// The favicon set, which is a DIFFERENT IMAGE from the logo (Task 30).
//
// Downscaling the whole logo passed every gate the pack had — the dimensions
// were exact, the ICO parsed back, the ZIP was complete — because none of them
// asked whether the result was legible. These do.
// ---------------------------------------------------------------------------
describe('buildPack — the favicon is a mark, not a shrunken logo', () => {
  it('renders the favicons from the mark, and the masters from the whole logo', async () => {
    const sources = nodeWasmSources();
    const result = await buildPack({
      svg: WIDE_LOCKUP,
      brandName: 'Harbor & Vine',
      sources,
      fonts,
      ocr: stubOcr(readback('')),
    });
    assert.equal(result.gates.favicon.source, 'mark-crop');
    assert.equal(result.gates.favicon.reason, null);
    assert.equal(result.gates.pass, true, JSON.stringify(result.gates.favicon, null, 2));

    // THE ASSERTION THAT MATTERS IS ON THE PIXELS, not on the metadata: a
    // favicon "derived from the mark" that still shows the wordmark is the
    // original bug wearing a new field name.
    const icon = await decodePng(result.files['favicon-32.png']!, 32, sources);
    assert.ok(icon.mark > 200, `the mark should fill the icon: ${icon.mark}/1024 px`);
    assert.equal(icon.lettering, 0, `no lettering may survive: ${icon.lettering} px`);

    // The colour master is still the whole lockup — only the favicons crop.
    const master = await decodePng(result.files['logo-color-1024.png']!, 1024, sources);
    assert.ok(master.lettering > 0, 'the master must still carry the wordmark');
  });

  it('records the crop it took and the ink it measured', async () => {
    const result = await buildPack({
      svg: WIDE_LOCKUP,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
      ocr: stubOcr(readback('')),
    });
    const favicon = result.gates.favicon;
    assert.ok(favicon.crop, 'the crop must be recorded, not just its outcome');
    assert.equal(favicon.textComponents, 5);
    assert.equal(favicon.markComponents, 1);
    assert.ok(favicon.coverage > 0.4, `coverage ${favicon.coverage}`);
    assert.equal(favicon.ink.file, `icon-${INK_PROBE_PX}.png`);
    assert.ok((favicon.ink.opaquePixels ?? 0) > 0);
    assert.equal(favicon.text.status, 'ok');
    assert.equal(favicon.text.letteringChars, 0);
  });

  it('falls back to the whole logo — and still ships a pack — when there is no mark', async () => {
    const result = await buildPack({
      svg: WORDMARK_ONLY,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
      ocr: stubOcr(readback('Harbor & Vine')),
    });
    assert.equal(result.gates.favicon.source, 'whole-logo');
    assert.equal(result.gates.favicon.crop, null);
    assert.match(result.gates.favicon.reason ?? '', /lettering/i);
    // NEVER WORSE THAN TODAY: a missing mark costs the buyer the old favicon,
    // never the pack.
    assert.equal(result.gates.pass, true, JSON.stringify(result.gates, null, 2));
    const files = unzipFiles(result.zip);
    for (const name of REQUIRED_ZIP_ENTRIES) assert.ok(name in files, `missing entry: ${name}`);
    assert.deepEqual(readPngDimensions(result.files['favicon-16.png']!), { width: 16, height: 16 });
  });

  it('refuses a crop the vision model can still read the brand name off', async () => {
    // The one check that would have caught the original defect: a favicon that
    // reads back as the brand name IS the shrunken lockup.
    const result = await buildPack({
      svg: WIDE_LOCKUP,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
      ocr: stubOcr(readback('Harbor & Vine')),
    });
    assert.equal(result.gates.favicon.source, 'whole-logo');
    assert.match(result.gates.favicon.reason ?? '', /read back as lettering/i);
    assert.equal(result.gates.favicon.text.pass, false);
    assert.equal(result.gates.favicon.text.brandSimilarity, 1);
    assert.equal(result.gates.pass, true, 'a refuted crop must not cost the pack');
  });

  it('refuses a crop that reads back as a whole word, brand name or not', async () => {
    const result = await buildPack({
      svg: WIDE_LOCKUP,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
      ocr: stubOcr(readback('LOREM')),
    });
    assert.equal(result.gates.favicon.source, 'whole-logo');
    assert.equal(result.gates.favicon.text.letteringChars, 5);
  });

  it('keeps a crop the model reported one stray character on', async () => {
    // Two normalized characters cannot be a wordmark, and a nondeterministic
    // model misreading abstract geometry as a glyph must not cost the mark.
    const result = await buildPack({
      svg: WIDE_LOCKUP,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
      ocr: stubOcr(readback('O')),
    });
    assert.equal(result.gates.favicon.source, 'mark-crop');
    assert.equal(result.gates.favicon.text.letteringChars, 1);
  });

  it('keeps the mark when the vision model is down, and says the check did not run', async () => {
    // An outage is an absence of evidence, never a refutation — but it is also
    // never silently reported as a pass.
    const result = await buildPack({
      svg: WIDE_LOCKUP,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
      ocr: stubOcr(OCR_DOWN),
    });
    assert.equal(result.gates.favicon.source, 'mark-crop');
    assert.equal(result.gates.favicon.text.status, 'unavailable');
    assert.equal(result.gates.favicon.text.transcription, null);
  });

  it('says the readback did not run at all when no gate is supplied', async () => {
    const result = await buildPack({
      svg: WIDE_LOCKUP,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
    });
    assert.equal(result.gates.favicon.source, 'mark-crop');
    assert.equal(result.gates.favicon.text.status, 'not-run');
  });

  it('assembles favicon.ico from the MARK icons, not the logo ones', async () => {
    const sources = nodeWasmSources();
    const result = await buildPack({
      svg: WIDE_LOCKUP,
      brandName: 'Harbor & Vine',
      sources,
      fonts,
      ocr: stubOcr(readback('')),
    });
    // The ICO is built from files[16|32|48]; proving those are the mark proves
    // the ICO is, since assembleIco copies their bytes verbatim.
    for (const size of [16, 32, 48]) {
      const icon = await decodePng(result.files[`favicon-${size}.png`]!, size, sources);
      assert.equal(icon.lettering, 0, `favicon-${size}.png still carries lettering`);
    }
    assert.equal(result.gates.ico.pass, true);
  });

  it('fails the pack when the favicons render blank, rather than shipping them', async () => {
    // A `fill="none"` path is a real path — the true-vector gate passes it,
    // the dimensions are exact, the ICO parses and the ZIP is complete. Every
    // gate the pack had before this one is satisfied by six empty images.
    const blank =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<path d="M10 10 H90 V90 H10 Z" fill="none"/></svg>';
    const result = await buildPack({
      svg: blank,
      brandName: 'Harbor & Vine',
      sources: nodeWasmSources(),
      fonts,
      ocr: stubOcr(readback('')),
    });
    assert.equal(result.gates.vector.pass, true, 'a true vector by every earlier gate');
    assert.ok(
      result.gates.dimensions.every((d) => d.pass),
      'and exactly the contracted sizes',
    );
    assert.equal(result.gates.favicon.ink.opaquePixels, 0);
    assert.equal(result.gates.favicon.pass, false);
    assert.equal(result.gates.pass, false, 'blank icons must not be deliverable');
  });

  it('verifies the icon at the largest contracted size', () => {
    // The verification render is reused as `icon-512.png`, and the ink number
    // is comparable with the free funnel's, only while these agree.
    assert.ok(
      (FAVICON_SIZES as readonly number[]).includes(INK_PROBE_PX),
      'INK_PROBE_PX must be a contracted favicon size',
    );
    assert.equal(
      FAVICON_SIZES.reduce((a, b) => (a > b ? a : b)),
      INK_PROBE_PX,
      'the ink probe must be the LARGEST icon — small icons lose hairline marks',
    );
  });
});
