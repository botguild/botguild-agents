import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { buildEjectZip, verifyEjectZip } from './zip.js';

const WRANGLER_JSONC = `{
  // pinned compatibility date — do not bump without re-running the eject gate
  "name": "acme-widget",
  "main": "index.mjs",
  "compatibility_date": "2026-06-01"
}
`;

function baseEntries(): Record<string, Uint8Array | string> {
  return {
    'index.html': '<!doctype html><html><body>hi</body></html>',
    'app.js': 'console.log("hi");',
    'wrangler.jsonc': WRANGLER_JSONC,
    'package.json': JSON.stringify({ name: 'acme-widget', version: '1.0.0' }),
    'README.md': '# acme-widget\n\nSelf-host instructions.\n',
    'assets/logo.png': new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
  };
}

const REQUIRED = ['index.html', 'wrangler.jsonc', 'package.json', 'README.md'];

test('build -> verify round trip: ok with both string and Uint8Array entries', () => {
  const zip = buildEjectZip(baseEntries());
  const result = verifyEjectZip(zip, REQUIRED);
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('round trip preserves exact bytes for a binary entry', () => {
  const zip = buildEjectZip(baseEntries());
  const unzipped = unzipSync(zip);
  assert.deepEqual(Array.from(unzipped['assets/logo.png']), [137, 80, 78, 71, 1, 2, 3]);
  assert.equal(strFromU8(unzipped['index.html']), baseEntries()['index.html']);
});

test('missing required path is listed', () => {
  const entries = baseEntries();
  delete entries['README.md'];
  const zip = buildEjectZip(entries);
  const result = verifyEjectZip(zip, REQUIRED);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('README.md')));
});

test('empty required file is listed', () => {
  const entries = baseEntries();
  entries['package.json'] = '{}';
  entries['README.md'] = '';
  const zip = buildEjectZip(entries);
  const result = verifyEjectZip(zip, REQUIRED);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('README.md')));
});

test('corrupt wrangler.jsonc member (invalid JSON after comment-strip) is listed', () => {
  const entries = baseEntries();
  entries['wrangler.jsonc'] = `{
    // still a comment
    "name": "acme-widget",
    "main": "index.mjs",
  ` /* missing closing brace + trailing comma */;
  const zip = buildEjectZip(entries);
  const result = verifyEjectZip(zip, REQUIRED);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('wrangler.jsonc')));
});

test('valid JSON that merely contains a // inside a string value still parses', () => {
  const entries = baseEntries();
  entries['package.json'] = JSON.stringify({
    name: 'acme-widget',
    homepage: 'https://example.com/x',
  });
  const zip = buildEjectZip(entries);
  const result = verifyEjectZip(zip, REQUIRED);
  assert.equal(result.ok, true);
});

test('corrupt zip bytes fail ok:false', () => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const result = verifyEjectZip(garbage, REQUIRED);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test('deterministic output: identical entries in any insertion order produce identical bytes', () => {
  const entries = baseEntries();
  const keysReversed = Object.keys(entries).reverse();
  const reordered: Record<string, Uint8Array | string> = {};
  for (const k of keysReversed) reordered[k] = entries[k];

  const zipA = buildEjectZip(entries);
  const zipB = buildEjectZip(reordered);

  assert.deepEqual(Array.from(zipA), Array.from(zipB));
});

test('multiple errors are all collected, not just the first', () => {
  const entries: Record<string, Uint8Array | string> = {
    'index.html': '',
    'wrangler.jsonc': '{ invalid',
  };
  const zip = buildEjectZip(entries);
  const result = verifyEjectZip(zip, REQUIRED);
  assert.equal(result.ok, false);
  // missing package.json, missing README.md, empty index.html, invalid wrangler.jsonc
  assert.ok(result.errors.length >= 4);
});
