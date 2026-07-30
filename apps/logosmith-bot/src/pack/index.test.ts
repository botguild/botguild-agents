import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readPngDimensions } from '../gates/dimensions.js';
import { REQUIRED_ZIP_ENTRIES, unzipFiles } from './zip.js';
import { buildPack } from './index.js';
import { nodeWasmSources } from './wasm.node.js';

const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M20 20 H80 V80 H20 Z" fill="#0F3D3E"/>' +
  '<circle cx="50" cy="50" r="15" fill="#E8C39E"/></svg>';

const fonts = {
  heading: { family: 'Inter', category: 'sans-serif', license: 'OFL', url: 'https://x' },
  body: { family: 'Source Serif 4', category: 'serif', license: 'OFL', url: 'https://y' },
  note: 'advisory',
};

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
