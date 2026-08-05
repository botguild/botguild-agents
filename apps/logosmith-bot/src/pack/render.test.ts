import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-wasm';
import { readPngDimensions } from '../gates/dimensions.js';
import { renderSvgToPixmap, renderSvgToPng } from './render.js';
import { ensureResvgReady, type WasmSources } from './wasm.js';
import { nodeWasmSources } from './wasm.node.js';

// Paths-only, no <text>, no external fonts — exactly the shape the true-vector
// gate guarantees, so resvg never needs to load a font.
const SQUARE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M10 10 H90 V90 H10 Z" fill="#0F3D3E"/></svg>';

describe('renderSvgToPng', () => {
  it('renders at the exact requested size', async () => {
    const sources = nodeWasmSources();
    for (const size of [16, 48, 512]) {
      const png = await renderSvgToPng(SQUARE_SVG, size, sources);
      assert.deepEqual(readPngDimensions(png), { width: size, height: size });
    }
  });

  it('renders each size from the vector, not by resizing a raster', async () => {
    // A 16px render and a 512px render are produced independently; the small
    // one must not simply be the large one's header.
    const sources = nodeWasmSources();
    const small = await renderSvgToPng(SQUARE_SVG, 16, sources);
    const large = await renderSvgToPng(SQUARE_SVG, 512, sources);
    assert.notEqual(small.length, large.length);
    assert.ok(large.length > small.length);
  });

  it('returns bytes that stay correct after the underlying wasm resources are freed and reused', async () => {
    // render.ts frees the Resvg/RenderedImage handles in `finally` once the
    // PNG bytes are extracted (§12 memory discipline). If the returned
    // Uint8Array were a live view into that wasm memory instead of a copy, a
    // later, larger render reusing/growing the same wasm memory would
    // corrupt it.
    const sources = nodeWasmSources();
    const first = await renderSvgToPng(SQUARE_SVG, 64, sources);
    const snapshot = Uint8Array.from(first);
    await renderSvgToPng(SQUARE_SVG, 16, sources);
    await renderSvgToPng(SQUARE_SVG, 2048, sources);
    assert.deepEqual(first, snapshot);
  });
});

describe('renderSvgToPixmap', () => {
  it('returns RGBA bytes matching the requested dimensions', async () => {
    const pixmap = await renderSvgToPixmap(SQUARE_SVG, 64, nodeWasmSources());
    assert.equal(pixmap.width, 64);
    assert.equal(pixmap.height, 64);
    assert.equal(pixmap.data.length, 64 * 64 * 4);
  });

  it('renders the declared fill colour into the centre pixel', async () => {
    const pixmap = await renderSvgToPixmap(SQUARE_SVG, 64, nodeWasmSources());
    const centre = (32 * 64 + 32) * 4;
    assert.equal(pixmap.data[centre], 0x0f);
    assert.equal(pixmap.data[centre + 1], 0x3d);
    assert.equal(pixmap.data[centre + 2], 0x3e);
    assert.equal(pixmap.data[centre + 3], 255);
  });

  it('returns pixel data that stays correct after the underlying wasm resources are freed and reused', async () => {
    const sources = nodeWasmSources();
    const first = await renderSvgToPixmap(SQUARE_SVG, 64, sources);
    const snapshot = Uint8Array.from(first.data);
    await renderSvgToPixmap(SQUARE_SVG, 16, sources);
    await renderSvgToPixmap(SQUARE_SVG, 2048, sources);
    assert.deepEqual(first.data, snapshot);
  });
});

// Regression guard for the Task 10 memory fix: render.ts frees the Resvg
// parse/render handle and its RenderedImage result in `finally` blocks
// (dropping peak memory from 129.5MB to 99.7MB — see task-10-report.md). The
// tests above assert the returned bytes are correct AFTER freeing, but that
// alone can't tell a real free() apart from one that was silently deleted —
// a refactor that removed both `finally` blocks would still pass every test
// above (Uint8Array copies never alias wasm memory either way) and silently
// reintroduce the leak. These tests spy on the actual `.free()` methods and
// assert each fires exactly once per render call.
describe('wasm memory discipline (regression guard for the .free() fix)', () => {
  // RenderedImage is not exported by @resvg/resvg-wasm (only Resvg and
  // initWasm are) — its prototype is reachable only via a real instance. A
  // throwaway 8px render gets one cheaply; the Resvg/RenderedImage instances
  // renderSvgToPng/renderSvgToPixmap create internally share these exact same
  // prototype objects (module-level singletons within one process), so
  // spying on them here intercepts the real calls made inside render.ts.
  async function getRenderedImagePrototype(sources: WasmSources): Promise<{ free(): void }> {
    await ensureResvgReady(sources.resvg);
    const probe = new Resvg(SQUARE_SVG, { fitTo: { mode: 'width', value: 8 } });
    const probeImage = probe.render();
    const proto = Object.getPrototypeOf(probeImage) as { free(): void };
    probeImage.free();
    probe.free();
    return proto;
  }

  it('calls Resvg.prototype.free and RenderedImage.prototype.free exactly once per renderSvgToPng call', async () => {
    const sources = nodeWasmSources();
    const renderedImageProto = await getRenderedImagePrototype(sources);

    const resvgFree = mock.method(Resvg.prototype, 'free');
    const renderedImageFree = mock.method(renderedImageProto, 'free');
    try {
      await renderSvgToPng(SQUARE_SVG, 32, sources);
      assert.equal(resvgFree.mock.callCount(), 1);
      assert.equal(renderedImageFree.mock.callCount(), 1);

      await renderSvgToPng(SQUARE_SVG, 512, sources);
      assert.equal(resvgFree.mock.callCount(), 2);
      assert.equal(renderedImageFree.mock.callCount(), 2);
    } finally {
      resvgFree.mock.restore();
      renderedImageFree.mock.restore();
    }
  });

  it('calls Resvg.prototype.free and RenderedImage.prototype.free exactly once per renderSvgToPixmap call', async () => {
    const sources = nodeWasmSources();
    const renderedImageProto = await getRenderedImagePrototype(sources);

    const resvgFree = mock.method(Resvg.prototype, 'free');
    const renderedImageFree = mock.method(renderedImageProto, 'free');
    try {
      await renderSvgToPixmap(SQUARE_SVG, 32, sources);
      assert.equal(resvgFree.mock.callCount(), 1);
      assert.equal(renderedImageFree.mock.callCount(), 1);
    } finally {
      resvgFree.mock.restore();
      renderedImageFree.mock.restore();
    }
  });
});
