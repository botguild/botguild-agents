import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkLogoUrl, isLatinScript, parseFaviconBrief, parseLogoBrief } from './brief.js';
import { normalizeForMatch, similarity } from './gates/ocr.js';
import { LOGO_BRIEF_FIELDS, logoBriefFreeText } from './types.js';
import type { LogoBrief } from './types.js';

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

  // THE HAZARD IS CPU, NOT TOKENS. `similarity()` is a Levenshtein distance,
  // O(transcription x brandName); only the transcription is bounded (the vision
  // call's `max_tokens: 256`). Measured against a 1,000-char transcription:
  // 10k-char brandName = 77 ms, 40k = 655 ms, 160k = 2,739 ms — and the readback
  // gate runs up to 9x per job, so 160k chars is ~24.7 s of a 30 s Worker CPU
  // budget. Intake accepted 1,000,000 characters.
  //
  // The likelier outcome is a LIE, not a timeout: an oversized brief inflates
  // the FR-2 moderation payload, `moderation.ts` maps every `!response.ok` to
  // `unavailable`, and the buyer is told the vendor has been down for 3
  // attempts. It was our payload.
  it('refuses an oversized scalar field, naming which one and by how much', () => {
    const cases: Array<[string, number]> = [
      ['brandName', 201],
      ['industry', 201],
      ['script', 201],
      ['brief', 2001],
    ];
    for (const [field, length] of cases) {
      const result = parseLogoBrief(
        fence({
          brandName: 'Harbor & Vine',
          industry: 'boutique inn',
          [field]: 'x'.repeat(length),
        }),
      );
      assert.ok(!result.ok, `${field} must be bounded`);
      assert.match(result.reason, new RegExp(`${field} is ${length} characters`));
    }
  });

  it('refuses the megabyte brand name that used to reach the readback gate', () => {
    const result = parseLogoBrief(
      fence({ brandName: 'A'.repeat(1_000_000), industry: 'boutique inn' }),
    );
    assert.ok(!result.ok);
    assert.match(result.reason, /brandName is 1000000 characters/);
  });

  it('accepts scalars that sit exactly on the bounds', () => {
    // A false rejection is not free: these are real fields on a real brief.
    const result = parseLogoBrief(
      fence({
        brandName: 'x'.repeat(200),
        industry: 'y'.repeat(200),
        script: 'z'.repeat(200),
        brief: 'w'.repeat(2000),
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.brief.brandName.length, 200);
    assert.equal(result.brief.brief?.length, 2000);
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

  it('bounds EVERY free-text field of LogoBrief, each one exercised on its own', () => {
    // THE FIRST VERSION OF THIS TEST WAS VACUOUS AND ITS COMMENT SAID
    // OTHERWISE. It oversized every field at once and asserted refusal — which
    // one bounded field satisfies, leaving the other five untested. Deleting
    // `brief` from the intake loop left it green. A test that claims to catch a
    // forgotten field has to fail when a field is forgotten.
    //
    // The field list is DERIVED from `LOGO_BRIEF_FIELDS` (itself derived from
    // the compile-time-exhaustive `LOGO_BRIEF_TEXT`), and the table below is
    // asserted to cover it exactly — so adding a field to `LogoBrief` fails
    // here until it is bounded, rather than silently skipping it.
    const oversized: Record<keyof Required<LogoBrief>, unknown> = {
      brandName: 'x'.repeat(201),
      industry: 'x'.repeat(201),
      brief: 'x'.repeat(2001),
      script: 'x'.repeat(201),
      palettePreference: ['x'.repeat(201)],
      avoid: ['x'.repeat(201)],
    };
    assert.deepEqual(
      Object.keys(oversized).sort(),
      [...LOGO_BRIEF_FIELDS].sort(),
      'a field was added to LogoBrief without a bound case here',
    );

    for (const field of LOGO_BRIEF_FIELDS) {
      // Otherwise entirely valid — only this one field is over its bound, so a
      // refusal can only be attributable to it.
      const result = parseLogoBrief(
        fence({
          brandName: 'Harbor & Vine',
          industry: 'boutique inn',
          [field]: oversized[field],
        }),
      );
      assert.ok(!result.ok, `${field} is not bounded at intake`);
      assert.match(result.reason, new RegExp(field), `${field}'s refusal must name it`);
    }
  });

  it('and similarity refuses to verdict on an empty reference either way', () => {
    // The second, independent guard: intake is not the only caller, and
    // "nothing to compare against" must never read as a perfect match.
    assert.equal(similarity(normalizeForMatch('   '), normalizeForMatch('&&&')), 0);
  });
});
