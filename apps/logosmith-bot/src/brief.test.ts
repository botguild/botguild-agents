import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkLogoUrl, isLatinScript, parseFaviconBrief, parseLogoBrief } from './brief.js';
import { normalizeForMatch, similarity } from './gates/ocr.js';
import { logoBriefFreeText } from './types.js';

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

  // The two `string[]` fields are buyer-controlled free text that reaches the
  // moderation payload AND, via buildAxisPrompt, the image vendors' prompts
  // under our API keys. Unbounded, one gig pushes an arbitrary payload through
  // both.
  it('refuses a palettePreference or avoid list with too many entries', () => {
    for (const field of ['palettePreference', 'avoid'] as const) {
      const result = parseLogoBrief(
        fence({
          brandName: 'Harbor & Vine',
          industry: 'boutique inn',
          [field]: Array.from({ length: 21 }, (_, i) => `#00000${i % 10}`),
        }),
      );
      assert.ok(!result.ok, `${field} must be bounded`);
      assert.match(result.reason, new RegExp(`${field} lists 21 entries`));
    }
  });

  it('refuses a single over-long entry in either list', () => {
    for (const field of ['palettePreference', 'avoid'] as const) {
      const result = parseLogoBrief(
        fence({
          brandName: 'Harbor & Vine',
          industry: 'boutique inn',
          [field]: ['teal', 'x'.repeat(201)],
        }),
      );
      assert.ok(!result.ok, `${field} entries must be bounded`);
      assert.match(result.reason, new RegExp(`entry in ${field} is 201 characters`));
    }
  });

  it('accepts lists that sit exactly on the bounds', () => {
    // A false rejection is as bad as a false acceptance here: a real brief must
    // never be refused for a limit it did not cross.
    const result = parseLogoBrief(
      fence({
        brandName: 'Harbor & Vine',
        industry: 'boutique inn',
        palettePreference: Array.from({ length: 20 }, () => 'x'.repeat(200)),
        avoid: Array.from({ length: 20 }, () => 'y'.repeat(200)),
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.brief.palettePreference?.length, 20);
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

// ---------------------------------------------------------------------------
// The FR-2 screening surface is DERIVED FROM `LogoBrief`, not re-listed.
//
// `moderationText` (pipeline.ts) used to name four fields by hand and missed
// `palettePreference` — which reaches Ideogram's and Recraft's prompts under
// our API keys, and the axis compiler's user message, unscreened, while the
// refusal copy told the buyer every brief is screened.
//
// The compile-time half of the guarantee is in types.ts: `LOGO_BRIEF_TEXT` is a
// mapped type over `keyof Required<LogoBrief>`, so a new field that is not
// classified there does not build. This is the runtime half — that every field
// which EXISTS today is actually read.
// ---------------------------------------------------------------------------
describe('logoBriefFreeText', () => {
  it('reads every buyer-supplied field, each one named individually', () => {
    const text = logoBriefFreeText({
      brandName: 'SENTINEL-BRAND',
      industry: 'SENTINEL-INDUSTRY',
      brief: 'SENTINEL-BRIEF',
      palettePreference: ['SENTINEL-PALETTE-1', 'SENTINEL-PALETTE-2'],
      avoid: ['SENTINEL-AVOID'],
      script: 'SENTINEL-SCRIPT',
    });
    // Named one by one on purpose: deriving the expectation from the same
    // helper under test would pass however few fields it read.
    for (const sentinel of [
      'SENTINEL-BRAND',
      'SENTINEL-INDUSTRY',
      'SENTINEL-BRIEF',
      'SENTINEL-PALETTE-1',
      'SENTINEL-PALETTE-2',
      'SENTINEL-AVOID',
      'SENTINEL-SCRIPT',
    ]) {
      assert.ok(text.includes(sentinel), `${sentinel} was not screened`);
    }
  });

  it('omits absent optional fields rather than emitting empty strings', () => {
    assert.deepEqual(logoBriefFreeText({ brandName: 'Acme', industry: 'tools' }), [
      'Acme',
      'tools',
    ]);
  });
});

// ---------------------------------------------------------------------------
// THE COUPLING BETWEEN INTAKE AND THE READBACK GATE, ASSERTED RATHER THAN
// COMMENTED.
//
// brief.ts cannot import `normalizeForMatch` — that would close a cycle through
// config.ts — so `hasReadableLettering` states the rule in brief.ts's own
// vocabulary. Two rules in two modules is exactly the drift this branch keeps
// paying for, so the relationship is a test: anything intake ACCEPTS must have
// something for the readback gate to compare, and `similarity` must refuse to
// verdict when it does not.
//
// The bug this closes needed no attacker: `isLatinScript` admits \p{P}, so
// "&&&" was a valid brand name, `normalizeForMatch` emptied it, a model
// reporting no legible lettering emptied too, and `similarity('','')` was 1.
// With the prompt_tokens canary satisfied the gate returned PASS (1.00) — and
// the M1 note, progress page, report.json, warranty terms and dispute document
// all republished that as a machine verification that never happened.
// ---------------------------------------------------------------------------
describe('brand-name intake feeds the lettering gate something to verify', () => {
  const NAMES = [
    '&&&',
    '---',
    '...',
    '&',
    '#',
    '   -   ',
    '!!!',
    '@#$%^*',
    '<>=|~`',
    "'''",
    'Acme Corp',
    'Harbor & Vine',
    'Café 42',
    "O'Brien-Smith",
    'X',
    '7',
  ];

  it('never accepts a brand name whose normalized form is empty', () => {
    let accepted = 0;
    for (const brandName of NAMES) {
      const result = parseLogoBrief(fence({ brandName, industry: 'boutique inn' }));
      if (!result.ok) continue;
      accepted += 1;
      assert.notEqual(
        normalizeForMatch(result.brief.brandName),
        '',
        `intake accepted ${JSON.stringify(brandName)}, which the readback gate cannot verify`,
      );
    }
    // Not a vacuous sweep: real names must still get through.
    assert.ok(accepted >= 6, `expected the legitimate names to be accepted, got ${accepted}`);
  });

  it('refuses the punctuation-only names by name, with an actionable reason', () => {
    for (const brandName of ['&&&', '---', '...', '&']) {
      const result = parseLogoBrief(fence({ brandName, industry: 'boutique inn' }));
      assert.ok(!result.ok, brandName);
      assert.match(result.reason, /no letters or digits/);
    }
  });

  it('and similarity refuses to verdict on an empty reference either way', () => {
    // The second, independent guard: intake is not the only caller, and
    // "nothing to compare against" must never read as a perfect match.
    assert.equal(similarity(normalizeForMatch('   '), normalizeForMatch('&&&')), 0);
  });
});
