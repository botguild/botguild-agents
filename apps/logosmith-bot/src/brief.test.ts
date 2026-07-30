import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkLogoUrl, isLatinScript, parseFaviconBrief, parseLogoBrief } from './brief.js';

const fence = (json: unknown): string =>
  `We need a mark for our new place.\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;

describe('parseLogoBrief', () => {
  it('extracts a fenced JSON brief from a gig description', () => {
    const result = parseLogoBrief(
      fence({ brandName: 'Harbor & Vine', industry: 'boutique inn', script: 'latin' }),
    );
    assert.ok(result.ok);
    assert.equal(result.brief.brandName, 'Harbor & Vine');
    assert.equal(result.brief.industry, 'boutique inn');
  });

  it('accepts a brief with the optional fields present', () => {
    const result = parseLogoBrief(
      fence({
        brandName: 'Harbor & Vine',
        industry: 'boutique inn',
        brief: 'coastal, warm, understated luxury',
        palettePreference: ['#0F3D3E', '#E8C39E'],
        avoid: ['gradients', 'mascots'],
      }),
    );
    assert.ok(result.ok);
    assert.deepEqual(result.brief.avoid, ['gradients', 'mascots']);
  });

  it('rejects a description with no fenced block', () => {
    const result = parseLogoBrief('Please make me a logo, thanks!');
    assert.ok(!result.ok);
    assert.match(result.reason, /no fenced json/i);
  });

  it('rejects a brief missing a required field', () => {
    const result = parseLogoBrief(fence({ brandName: 'Harbor & Vine' }));
    assert.ok(!result.ok);
    assert.match(result.reason, /industry/);
  });

  it('rejects a blank brand name', () => {
    const result = parseLogoBrief(fence({ brandName: '   ', industry: 'inn' }));
    assert.ok(!result.ok);
    assert.match(result.reason, /brandName/);
  });

  it('rejects non-Latin brand names (v1 scope, PRD §13)', () => {
    const result = parseLogoBrief(fence({ brandName: '海港与藤', industry: 'inn' }));
    assert.ok(!result.ok);
    assert.match(result.reason, /latin/i);
  });

  it('rejects malformed JSON inside the fence', () => {
    const result = parseLogoBrief('```json\n{ brandName: nope }\n```');
    assert.ok(!result.ok);
    assert.match(result.reason, /parse/i);
  });
});

describe('isLatinScript', () => {
  it('accepts Latin letters, digits, punctuation, and diacritics', () => {
    assert.ok(isLatinScript('Harbor & Vine'));
    assert.ok(isLatinScript('Café Ünicode 42'));
    assert.ok(isLatinScript("O'Brien-Smith"));
  });

  it('rejects CJK, Arabic, and Devanagari', () => {
    assert.ok(!isLatinScript('海港'));
    assert.ok(!isLatinScript('مرحبا'));
    assert.ok(!isLatinScript('नमस्ते'));
  });
});

describe('parseFaviconBrief', () => {
  it('extracts a logoUrl brief', () => {
    const result = parseFaviconBrief(fence({ logoUrl: 'https://example.com/logo.png' }));
    assert.ok(result.ok);
    assert.equal(result.brief.logoUrl, 'https://example.com/logo.png');
  });

  it('rejects a brief whose logoUrl fails the guard policy', () => {
    const result = parseFaviconBrief(fence({ logoUrl: 'http://example.com/logo.png' }));
    assert.ok(!result.ok);
    assert.match(result.reason, /https/i);
  });
});

describe('checkLogoUrl', () => {
  it('accepts an https URL with a hostname', () => {
    const result = checkLogoUrl('https://example.com/logo.png');
    assert.ok(result.ok);
    assert.equal(result.url.hostname, 'example.com');
  });

  it('rejects non-https schemes', () => {
    for (const url of [
      'http://example.com/a.png',
      'file:///etc/passwd',
      'data:image/png;base64,x',
    ]) {
      const result = checkLogoUrl(url);
      assert.ok(!result.ok, `expected rejection: ${url}`);
    }
  });

  it('rejects IP literals and localhost (SSRF, §12)', () => {
    for (const host of [
      'https://127.0.0.1/a.png',
      'https://localhost/a.png',
      'https://localhost./a.png',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/a.png',
      'https://0.0.0.0/a.png',
      'https://10.0.0.5/a.png',
    ]) {
      const result = checkLogoUrl(host);
      assert.ok(!result.ok, `expected rejection: ${host}`);
      assert.match(result.reason, /host/i);
    }
  });

  it('rejects garbage that is not a URL at all', () => {
    const result = checkLogoUrl('not a url');
    assert.ok(!result.ok);
  });
});
