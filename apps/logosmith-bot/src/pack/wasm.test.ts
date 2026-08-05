import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensurePotraceReady } from './wasm.js';
import { nodeWasmSources } from './wasm.node.js';

// Covers the once-per-isolate potrace init path end to end under real Node:
// the dynamic import of esm-potrace-wasm, the Node CJS-global shim installed
// by nodeWasmSources() (see wasm.node.ts), and the package's own embedded-wasm
// init(). Does NOT call the potrace trace function itself — that needs a real
// ImageBitmapSource and lands with traceMonoSvg (Task 6).
describe('ensurePotraceReady', () => {
  it('resolves without throwing', async () => {
    const sources = nodeWasmSources();
    await assert.doesNotReject(ensurePotraceReady(sources.potrace));
  });

  it('memoizes: a second call returns the same promise and resolves immediately', async () => {
    const sources = nodeWasmSources();
    const first = ensurePotraceReady(sources.potrace);
    const second = ensurePotraceReady(sources.potrace);
    assert.equal(second, first);
    await assert.doesNotReject(second);
  });
});
