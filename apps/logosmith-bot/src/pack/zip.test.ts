import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkZipCompleteness } from '../gates/zip.js';
import {
  REQUIRED_ZIP_ENTRIES,
  buildHtmlSnippet,
  buildWebmanifest,
  unzipFiles,
  zipFiles,
} from './zip.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A complete, valid pack — every §8 entry with plausible content. */
function completePack(): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const name of REQUIRED_ZIP_ENTRIES) {
    files[name] = bytes(`stub:${name}`);
  }
  files['site.webmanifest'] = bytes(buildWebmanifest('Harbor & Vine'));
  files['snippet.html'] = bytes(buildHtmlSnippet());
  return files;
}

describe('zipFiles / unzipFiles', () => {
  it('round-trips entries byte-for-byte', () => {
    const zip = zipFiles({ 'a.txt': bytes('hello'), 'b/c.txt': bytes('world') });
    const out = unzipFiles(zip);
    assert.equal(new TextDecoder().decode(out['a.txt']), 'hello');
    assert.equal(new TextDecoder().decode(out['b/c.txt']), 'world');
  });
});

describe('buildWebmanifest', () => {
  it('produces JSON that parses and names the brand', () => {
    const parsed = JSON.parse(buildWebmanifest('Harbor & Vine')) as {
      name: string;
      icons: Array<{ src: string; sizes: string }>;
    };
    assert.equal(parsed.name, 'Harbor & Vine');
    assert.ok(parsed.icons.some((i) => i.sizes === '192x192'));
    assert.ok(parsed.icons.some((i) => i.sizes === '512x512'));
  });

  it('escapes a brand name containing quotes', () => {
    const parsed = JSON.parse(buildWebmanifest('The "Real" Deal')) as { name: string };
    assert.equal(parsed.name, 'The "Real" Deal');
  });
});

describe('buildHtmlSnippet', () => {
  it('references only files that exist in the pack', () => {
    const snippet = buildHtmlSnippet();
    const refs = [...snippet.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      assert.ok(REQUIRED_ZIP_ENTRIES.includes(ref), `snippet references missing entry: ${ref}`);
    }
  });
});

describe('checkZipCompleteness', () => {
  it('passes a complete pack', () => {
    const result = checkZipCompleteness(zipFiles(completePack()));
    assert.equal(result.pass, true, result.reasons.join('; '));
    assert.deepEqual(result.missing, []);
  });

  it('fails when a required entry is absent', () => {
    const files = completePack();
    delete files['favicon.ico'];
    const result = checkZipCompleteness(zipFiles(files));
    assert.equal(result.pass, false);
    assert.ok(result.missing.includes('favicon.ico'));
  });

  it('fails when site.webmanifest does not parse as JSON', () => {
    const files = completePack();
    files['site.webmanifest'] = bytes('{ not json');
    const result = checkZipCompleteness(zipFiles(files));
    assert.equal(result.pass, false);
    assert.ok(result.reasons.some((r) => /webmanifest/i.test(r)));
  });

  it('fails when the snippet references an entry that is not in the ZIP', () => {
    const files = completePack();
    files['snippet.html'] = bytes('<link rel="icon" href="does-not-exist.png">');
    const result = checkZipCompleteness(zipFiles(files));
    assert.equal(result.pass, false);
    assert.ok(result.reasons.some((r) => /does-not-exist\.png/.test(r)));
  });

  it('fails when an entry is present but empty', () => {
    const files = completePack();
    files['logo.svg'] = new Uint8Array(0);
    const result = checkZipCompleteness(zipFiles(files));
    assert.equal(result.pass, false);
    assert.ok(result.reasons.some((r) => /logo\.svg/.test(r)));
  });

  it('fails on a buffer that is not a ZIP', () => {
    const result = checkZipCompleteness(bytes('not a zip'));
    assert.equal(result.pass, false);
  });
});
