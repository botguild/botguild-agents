import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cropSvg, deriveFaviconMark, MARK_PROBE_PX } from './mark.js';
import { renderSvgToPixmap } from './render.js';
import { nodeWasmSources } from './wasm.node.js';

const sources = nodeWasmSources();

const svg = (viewBox: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;

/** Five same-height bars in a row: a wordmark, as far as the geometry cares. */
const glyphs = (x0: number, y: number, height: number, fill: string): string =>
  [0, 1, 2, 3, 4]
    .map((i) => `<rect x="${x0 + i * 30}" y="${y}" width="18" height="${height}" fill="${fill}"/>`)
    .join('');

/**
 * A WIDE LOCKUP: a wordmark with a mark stacked above its left end, which is
 * the shape the JiffyApp delivery has and the shape that produced the bug.
 */
const STACKED_LOCKUP = svg(
  '0 0 400 200',
  '<rect width="400" height="200" fill="#0f2027"/>' +
    '<circle cx="60" cy="55" r="30" fill="#47bcba"/>' +
    glyphs(30, 110, 60, '#ffffff'),
);

/**
 * A SIDE-BY-SIDE LOCKUP: the commonest arrangement there is — the mark sits
 * inside the wordmark's vertical band, so only the word-gap split can find it.
 */
const BESIDE_LOCKUP = svg(
  '0 0 400 120',
  '<rect width="400" height="120" fill="#0f2027"/>' +
    '<circle cx="50" cy="60" r="34" fill="#47bcba"/>' +
    glyphs(140, 35, 50, '#ffffff'),
);

/** No mark at all: five glyphs and nothing else. */
const PURE_WORDMARK = svg(
  '0 0 400 120',
  '<rect width="400" height="120" fill="#0f2027"/>' + glyphs(120, 35, 50, '#ffffff'),
);

/**
 * A TIGHT lockup: the mark sits just above and beside an ascender, near enough
 * that squaring its bounding box CENTRED on it clips the ascender into the
 * frame. Only sliding the window inside the freedom the padding buys gets it
 * clean — this is the synthetic form of the JiffyApp rocket, which sits over
 * the "i" between the "J" and the first "f".
 */
const TIGHT_LOCKUP = svg(
  '0 0 400 400',
  '<rect width="400" height="400" fill="#0f2027"/>' +
    '<rect x="118" y="150" width="16" height="50" rx="4" fill="#47bcba"/>' +
    [0, 1, 2, 3, 4]
      .map((i) => {
        const y = i === 2 ? 170 : 210;
        return `<rect x="${30 + i * 30}" y="${y}" width="18" height="${270 - y}" fill="#ffffff"/>`;
      })
      .join(''),
);

/**
 * THREE mark candidates, and the biggest one is not the right one.
 *
 * A solid disc (2537 px of ink), a large thin ring (more ink, spread over four
 * times the area) and a 7px speck. This is the JiffyApp lockup's own shape:
 * there the rocket carried 393 px against the bolt-and-sparkles cluster's 644,
 * and picking by total ink would have delivered the airy one.
 */
const MULTI_MARK = svg(
  '0 0 400 400',
  '<rect width="400" height="400" fill="#0f2027"/>' +
    '<circle cx="60" cy="120" r="22" fill="#47bcba"/>' +
    '<circle cx="250" cy="125" r="61" fill="none" stroke="#47bcba" stroke-width="8"/>' +
    '<rect x="360" y="40" width="7" height="7" fill="#47bcba"/>' +
    [0, 1, 2, 3, 4]
      .map((i) => `<rect x="${30 + i * 30}" y="300" width="18" height="60" fill="#ffffff"/>`)
      .join(''),
);

/**
 * TWO competing bands, and the busier row is on the wrong one.
 *
 * Three ascenders and three fragments cross a row near the top (6 components);
 * the wordmark's own rows are crossed by 5. Anchoring on the busiest row —
 * which is what this did until a live re-run refuted it on a fresh
 * Vectorizer.ai trace of JiffyApp — hands the band to the three fragments,
 * makes the WORDMARK the mark candidate, and derives a favicon of a letter.
 * The band that explains the most components is the wordmark's.
 */
const TWO_BANDS = svg(
  '0 0 400 400',
  '<rect width="400" height="400" fill="#0f2027"/>' +
    [330, 346, 362]
      .map((x) => `<rect x="${x}" y="205" width="14" height="14" fill="#47bcba"/>`)
      .join('') +
    [0, 1, 2, 3, 4]
      .map((i) => {
        const y = i % 2 === 0 ? 200 : 250;
        return `<rect x="${30 + i * 60}" y="${y}" width="40" height="${320 - y}" fill="#ffffff"/>`;
      })
      .join(''),
);

/** No lettering at all: one emblem, floating in a lot of margin. */
const EMBLEM_ONLY = svg(
  '0 0 400 400',
  '<rect width="400" height="400" fill="#0f2027"/>' +
    '<circle cx="200" cy="200" r="60" fill="#47bcba"/>',
);

describe('deriveFaviconMark — finding the mark in a lockup', () => {
  it('crops the mark, not the whole logo, out of a stacked lockup', async () => {
    const mark = await deriveFaviconMark(STACKED_LOCKUP, sources);
    assert.equal(mark.reason, null);
    assert.ok(mark.crop, 'expected a crop');
    assert.equal(mark.textComponents, 5, 'the five glyph bars are lettering');
    assert.equal(mark.markComponents, 1, 'the disc is the only mark candidate');
    // The disc lives in the top-left eighth of a 512x256 render; a crop of the
    // whole logo would be the full 512-wide frame.
    assert.ok(mark.crop.size < 120, `crop ${mark.crop.size} should be tight on the disc`);
    assert.ok(mark.crop.y < 100, 'the crop sits on the mark, above the wordmark band');
    // A disc is pi/4 of its own bounding square, and PAD_LADDER's widest rung
    // adds 16% on each side: 0.785 / 1.32^2 = 0.45. Measured 0.442.
    assert.ok(mark.coverage > 0.4, `a disc fills its own square: ${mark.coverage}`);
  });

  it('splits a mark set BESIDE the wordmark off by its word gap', async () => {
    const mark = await deriveFaviconMark(BESIDE_LOCKUP, sources);
    assert.equal(mark.reason, null);
    assert.ok(mark.crop, 'expected a crop');
    // Every component here — the disc included — sits in the wordmark's
    // vertical band, so the band test alone would call the disc a letter.
    assert.equal(mark.textComponents, 5);
    assert.equal(mark.markComponents, 1);
    assert.ok(mark.crop.x < 120, `crop should be at the left, on the disc: x=${mark.crop.x}`);
    assert.ok(mark.crop.size < 140, `crop ${mark.crop.size} should be tight on the disc`);
  });

  it('reports no mark when the logo is nothing but lettering', async () => {
    const mark = await deriveFaviconMark(PURE_WORDMARK, sources);
    assert.equal(mark.crop, null);
    assert.equal(mark.textComponents, 5);
    assert.equal(mark.markComponents, 0);
    assert.match(mark.reason ?? '', /lettering/i);
  });

  it('trims the margin off a logo that is already just an emblem', async () => {
    const mark = await deriveFaviconMark(EMBLEM_ONLY, sources);
    assert.ok(mark.crop, 'expected a crop');
    assert.equal(mark.textComponents, 0, 'one component is never a text band');
    // The emblem is 120/400 of the artwork; the crop must be far tighter than
    // the 512px frame or the favicon is mostly empty field.
    assert.ok(mark.crop.size < 260, `crop ${mark.crop.size} should trim the margin`);
    assert.ok(mark.coverage > 0.4, `coverage ${mark.coverage}`);
  });

  it('excludes only ink it can see: the crop never leaves the pixmap', async () => {
    for (const source of [STACKED_LOCKUP, BESIDE_LOCKUP, EMBLEM_ONLY]) {
      const mark = await deriveFaviconMark(source, sources);
      assert.ok(mark.crop);
      const { x, y, size, probeWidth, probeHeight } = mark.crop;
      assert.ok(x >= 0 && y >= 0, `crop origin ${x},${y}`);
      assert.ok(x + size <= probeWidth, `crop right edge ${x + size} > ${probeWidth}`);
      assert.ok(y + size <= probeHeight, `crop bottom edge ${y + size} > ${probeHeight}`);
    }
  });

  it('slides the crop off neighbouring ink rather than clipping it in', async () => {
    // A square window CENTRED on this mark clips the ascender beside it; the
    // slid window does not. Measured: 0 foreign pixels here against 210 for
    // the centred position at the same padding.
    const mark = await deriveFaviconMark(TIGHT_LOCKUP, sources);
    assert.ok(mark.crop);
    assert.equal(mark.markComponents, 1, 'the mark must be separated before it can be slid');
    assert.equal(mark.foreignPixels, 0, 'no lettering may survive inside the crop');
    // The window really did move off centre — a centred one would sit at the
    // mark's own midpoint. This is what fails if the search stops scoring
    // foreign ink and simply centres.
    const centre = mark.crop.x + mark.crop.size / 2;
    assert.ok(
      Math.abs(centre - 161) > 8,
      `the window should have slid off the mark's centre, sat at ${centre}`,
    );
  });

  it('picks the band that explains the most, not the one under the busiest row', async () => {
    // Measured on this fixture: the correct band yields 5 lettering components
    // and 3 mark candidates; anchoring on the busiest row instead yields 3 and
    // 5, and crops a favicon out of a LETTER (154px wide, 907 foreign pixels).
    const mark = await deriveFaviconMark(TWO_BANDS, sources);
    assert.ok(mark.crop);
    assert.equal(mark.textComponents, 5, 'the wordmark is the lettering, not the fragments');
    assert.equal(mark.markComponents, 3, 'the three fragments are the mark candidates');
    assert.ok(
      mark.crop.x > 300,
      `the crop should be on the fragments, not a glyph: ${mark.crop.x}`,
    );
    assert.equal(mark.foreignPixels, 0);
  });

  it('picks the DENSEST mark, not the one with the most ink', async () => {
    // A favicon lives or dies on how much of its 16 px is ink, so the ring —
    // which carries more ink than the disc but spreads it over four times the
    // area — is the wrong answer even though it is the bigger drawing.
    const mark = await deriveFaviconMark(MULTI_MARK, sources);
    assert.ok(mark.crop);
    assert.equal(mark.markComponents, 3, 'disc, ring and speck are all candidates');
    assert.ok(
      mark.crop.x < 90 && mark.crop.y < 160,
      `crop ${mark.crop.x},${mark.crop.y} is not the disc`,
    );
    assert.ok(mark.crop.size < 110, `crop ${mark.crop.size} is the ring, not the disc`);
    assert.ok(mark.coverage > 0.4, `coverage ${mark.coverage} — the ring measures ~0.11`);
  });

  it('will not crop to a speck, however solidly the speck fills its own box', async () => {
    // A 7px square is 100% ink inside its own bounding box, which makes it the
    // densest thing in the logo by a distance. It is also not the mark.
    const mark = await deriveFaviconMark(MULTI_MARK, sources);
    assert.ok(mark.crop);
    assert.ok(
      mark.crop.size > 30,
      `a speck-sized crop escaped the ink-share floor: ${mark.crop.size}`,
    );
    assert.ok(mark.markPixels > 1000, `markPixels ${mark.markPixels} is a speck, not a mark`);
  });

  it('renders the slid crop with no lettering in it at all', async () => {
    const mark = await deriveFaviconMark(TIGHT_LOCKUP, sources);
    assert.ok(mark.crop);
    const pixmap = await renderSvgToPixmap(cropSvg(TIGHT_LOCKUP, mark.crop), 128, sources);
    let white = 0;
    for (let i = 0; i < pixmap.data.length; i += 4) {
      if (pixmap.data[i]! > 220 && pixmap.data[i + 1]! > 220 && pixmap.data[i + 2]! > 220) white++;
    }
    assert.equal(white, 0, `a slid crop must clip no lettering: ${white} white px`);
  });
});

describe('deriveFaviconMark — refusing rather than guessing', () => {
  it('reports a reason instead of throwing when the logo will not render', async () => {
    const mark = await deriveFaviconMark('<svg><not-closed', sources);
    assert.equal(mark.crop, null);
    assert.match(mark.reason ?? '', /could not be rendered/i);
  });

  it('reports a reason for a logo that renders nothing at all', async () => {
    const mark = await deriveFaviconMark(svg('0 0 100 100', ''), sources);
    assert.equal(mark.crop, null);
    assert.match(mark.reason ?? '', /no artwork/i);
  });

  it('treats a uniform opaque field as background, not as the mark', async () => {
    // Without the border-ring background rule the whole 400x400 navy rectangle
    // is one component, and the "mark" is the entire logo — the very defect
    // this module exists to remove.
    const mark = await deriveFaviconMark(EMBLEM_ONLY, sources);
    assert.ok(mark.crop);
    assert.ok(
      mark.crop.size < mark.crop.probeWidth,
      'the background field must not be mistaken for artwork',
    );
  });
});

describe('cropSvg', () => {
  it('renders the cropped window square at any size, from the vector', async () => {
    const mark = await deriveFaviconMark(STACKED_LOCKUP, sources);
    assert.ok(mark.crop);
    const cropped = cropSvg(STACKED_LOCKUP, mark.crop);
    for (const size of [16, 32, 512]) {
      const pixmap = await renderSvgToPixmap(cropped, size, sources);
      assert.deepEqual(
        { width: pixmap.width, height: pixmap.height },
        { width: size, height: size },
      );
    }
  });

  it('shows the mark and none of the wordmark', async () => {
    const mark = await deriveFaviconMark(STACKED_LOCKUP, sources);
    assert.ok(mark.crop);
    const pixmap = await renderSvgToPixmap(cropSvg(STACKED_LOCKUP, mark.crop), 64, sources);
    let teal = 0;
    let white = 0;
    for (let i = 0; i < pixmap.data.length; i += 4) {
      const [r, g, b] = [pixmap.data[i]!, pixmap.data[i + 1]!, pixmap.data[i + 2]!];
      if (r < 120 && g > 150 && b > 150) teal++;
      if (r > 220 && g > 220 && b > 220) white++;
    }
    assert.ok(teal > 200, `expected the teal disc to dominate: ${teal}px`);
    assert.equal(white, 0, `expected no white glyph pixels in the crop: ${white}px`);
  });

  it('survives a brand name outside Latin-1 (btoa would throw on the raw string)', async () => {
    const withTitle = svg(
      '0 0 400 200',
      '<title>日本ブランド</title><rect width="400" height="200" fill="#0f2027"/>' +
        '<circle cx="60" cy="55" r="30" fill="#47bcba"/>' +
        glyphs(30, 110, 60, '#ffffff'),
    );
    const mark = await deriveFaviconMark(withTitle, sources);
    assert.ok(mark.crop);
    const pixmap = await renderSvgToPixmap(cropSvg(withTitle, mark.crop), 32, sources);
    assert.equal(pixmap.width, 32);
  });
});

describe('MARK_PROBE_PX', () => {
  it('measures large, not small — a hairline mark renders to nothing at 16px', () => {
    // Task 23 measured a hairline monogram at 0 opaque pixels at 16px and 1568
    // at 512. Component labelling at favicon resolution would find no mark on
    // exactly the artwork that most needs one.
    assert.ok(MARK_PROBE_PX >= 512, `probe edge ${MARK_PROBE_PX} is too small to label a mark`);
  });
});
