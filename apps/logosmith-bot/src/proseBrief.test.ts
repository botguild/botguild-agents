import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLatinScript, parseLogoBrief, resolveBrief, type BriefResult } from './brief.js';
import {
  buildProseExtractionInput,
  createProseBriefExtractor,
  extractionCostUsd,
  MAX_PROSE_EXTRACTION_CHARS,
  type ProseBriefExtractor,
  type ProseGig,
} from './proseBrief.js';
import { HAIKU_PRICING_PER_MTOK, SEED_PRICE_USD } from './config.js';
import type { LogoBrief } from './types.js';

// A real-shaped gig: prose that names the brand, plus the platform's own
// structured fields. MEASURED LIVE 2026-07-30: 0 of 78 open gigs carried a
// fenced block or any `{...}` at all, which is the whole reason this module
// exists — so the fixture's defining property is asserted, not assumed.
const PROSE_GIG: ProseGig = {
  title: 'Logo and brand mark needed for a new seaside inn',
  description:
    "We're opening Harbor & Vine, a small inn and wine bar on the Oregon coast, and we need a " +
    'logo before the booking site goes live in March. Warm and understated, please — coastal ' +
    'without the nautical kitsch. No anchors and no rope.',
  acceptanceCriteria: [
    { kind: 'text', text: 'Delivered as a scalable vector file, not a flattened raster.' },
    { kind: 'text', text: 'The lettering stays legible at favicon size.' },
  ] as ProseGig['acceptanceCriteria'],
  deliverables: ['Primary logo lockup', 'Monochrome variant', 'Favicon set'],
  tags: ['logo', 'branding', 'hospitality'],
};

// Fixture preconditions, asserted inline: every test below is only meaningful
// if this gig genuinely has no machine-readable brief to find.
assert.ok(!PROSE_GIG.description!.includes('{'), 'fixture must carry no JSON');
assert.ok(!PROSE_GIG.description!.includes('```'), 'fixture must carry no fenced block');
assert.equal(parseLogoBrief(PROSE_GIG.description!).ok, false, 'fenced path must reject fixture');

const FENCED_GIG: ProseGig = {
  ...PROSE_GIG,
  description:
    '```json\n{"brandName":"Harbor & Vine","industry":"boutique inn"}\n```\nAnd some prose.',
};
assert.equal(parseLogoBrief(FENCED_GIG.description!).ok, true, 'fenced fixture must parse');

/** An extractor double that records every call and returns a scripted result. */
function recordingExtractor(result: BriefResult<LogoBrief>): ProseBriefExtractor & {
  calls: ProseGig[];
} {
  const calls: ProseGig[] = [];
  return {
    calls,
    async extract(gig: ProseGig): Promise<BriefResult<LogoBrief>> {
      calls.push(gig);
      return result;
    },
  };
}

/** An Anthropic double shaped like the real `messages.create` response. */
function fakeAnthropic(
  text: string,
  usage: Record<string, number> = { input_tokens: 700, output_tokens: 25 },
) {
  return {
    messages: {
      create: async () => ({ content: [{ type: 'text', text }], usage }),
    },
  };
}

function extractorOver(anthropic: unknown): {
  extractor: ProseBriefExtractor;
  spend: number[];
  /** Where the vendor's real error goes — deliberately NOT into `reason`. */
  logged: unknown[];
} {
  const spend: number[] = [];
  const logged: unknown[] = [];
  const extractor = createProseBriefExtractor({
    anthropic: anthropic as never,
    recordSpend: (usd) => spend.push(usd),
    logError: (err) => logged.push(err),
  });
  return { extractor, spend, logged };
}

describe('buildProseExtractionInput', () => {
  it('folds the title, description, every acceptance criterion, deliverables and tags into one payload', () => {
    const input = buildProseExtractionInput(PROSE_GIG);

    assert.ok(input.includes(PROSE_GIG.title!), 'title');
    assert.ok(input.includes('Harbor & Vine'), 'description');
    assert.ok(input.includes('nautical kitsch'), 'full description, not a truncation');
    // Every criterion, not just the first — a fold that dropped the tail would
    // still pass a "contains one criterion" assertion.
    for (const criterion of PROSE_GIG.acceptanceCriteria!) {
      assert.ok(input.includes((criterion as { text: string }).text), 'acceptance criterion');
    }
    for (const deliverable of PROSE_GIG.deliverables!) {
      assert.ok(input.includes(deliverable), `deliverable ${deliverable}`);
    }
    for (const tag of PROSE_GIG.tags!) {
      assert.ok(input.includes(tag), `tag ${tag}`);
    }
  });

  it('is pure — same gig in, same string out, no network', () => {
    assert.equal(buildProseExtractionInput(PROSE_GIG), buildProseExtractionInput(PROSE_GIG));
  });

  it('omits empty sections rather than emitting bare labels', () => {
    const input = buildProseExtractionInput({ title: 'Just a title', description: 'Prose.' });
    assert.ok(!input.includes('ACCEPTANCE CRITERIA'));
    assert.ok(!input.includes('DELIVERABLES'));
    assert.ok(!input.includes('TAGS'));
    assert.ok(input.includes('Just a title'));
  });

  // THIS RUNS AT GIG-DISCOVERY TIME, upstream of every contract, quota and
  // spend ledger — on text nobody has agreed to anything about yet. Unbounded,
  // one posted gig sets our token bill: a 1,026,038-character description
  // measured three paid Haiku calls, ~$0.60, for one gig with zero revenue.
  it('caps a hostile gig, however large every field is', () => {
    const input = buildProseExtractionInput({
      title: 'T'.repeat(50_000),
      description: 'D'.repeat(1_026_038),
      acceptanceCriteria: Array.from({ length: 500 }, () => ({
        kind: 'text' as const,
        text: 'C'.repeat(5_000),
      })),
      deliverables: Array.from({ length: 500 }, () => 'V'.repeat(5_000)),
      tags: Array.from({ length: 500 }, () => 'G'.repeat(5_000)),
    });
    assert.ok(
      input.length <= MAX_PROSE_EXTRACTION_CHARS,
      `input was ${input.length} characters, cap is ${MAX_PROSE_EXTRACTION_CHARS}`,
    );
  });

  it('leaves a real gig untouched — the cap must cost a genuine posting nothing', () => {
    // A false truncation is not free here: this string is ALSO the corpus the
    // extracted brand name is grounded against, so anything cut off can never
    // be extracted.
    const input = buildProseExtractionInput(PROSE_GIG);
    assert.ok(input.length < MAX_PROSE_EXTRACTION_CHARS);
    assert.ok(input.includes('Harbor & Vine'));
    assert.ok(input.includes('nautical kitsch'), 'full description, not a truncation');
  });
});

describe('resolveBrief', () => {
  it('takes the fenced block when there is one and never pays for extraction', async () => {
    const extractor = recordingExtractor({ ok: false, reason: 'must not be called' });
    const result = await resolveBrief(FENCED_GIG, extractor);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.brief.brandName, 'Harbor & Vine');
    assert.deepEqual(extractor.calls, [], 'the fast path must stay free');
  });

  it('falls back to the extractor when there is no fenced block', async () => {
    const extractor = recordingExtractor({
      ok: true,
      brief: { brandName: 'Harbor & Vine', industry: 'boutique inn' },
    });
    const result = await resolveBrief(PROSE_GIG, extractor);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.brief.brandName, 'Harbor & Vine');
    assert.equal(extractor.calls.length, 1);
    assert.equal(extractor.calls[0], PROSE_GIG, 'the whole gig is handed to the extractor');
  });

  it('reports both failures when neither path yields a brief', async () => {
    const extractor = recordingExtractor({ ok: false, reason: 'no brand named' });
    const result = await resolveBrief(PROSE_GIG, extractor);

    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /no fenced json block/);
    assert.match(result.ok ? '' : result.reason, /no brand named/);
  });

  it('does not let extraction rescue a brief the fenced path deliberately rejected', async () => {
    // A fenced block whose brandName is out of v1 scope. Extraction runs (the
    // fenced parse failed), but it re-validates through the SAME parser, so the
    // same rule applies to whatever it produces.
    const gig: ProseGig = { description: '```json\n{"brandName":"海港","industry":"inn"}\n```' };
    assert.equal(parseLogoBrief(gig.description!).ok, false);

    const extractor = recordingExtractor({ ok: false, reason: 'not Latin script either' });
    const result = await resolveBrief(gig, extractor);
    assert.equal(result.ok, false);
  });
});

describe('createProseBriefExtractor', () => {
  it('extracts a brief a real prose gig actually contains', async () => {
    const { extractor } = extractorOver(
      fakeAnthropic('{"brandName":"Harbor & Vine","industry":"boutique inn and wine bar"}'),
    );
    const result = await extractor.extract(PROSE_GIG);

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.brief, {
      brandName: 'Harbor & Vine',
      industry: 'boutique inn and wine bar',
    });
  });

  it('reads ONLY brandName and industry off the model, whatever else it emits', async () => {
    // An allow-list, not a blocklist: fields the model invents cannot reach the
    // brief because they are never read, not because they are named and blocked.
    const { extractor } = extractorOver(
      fakeAnthropic(
        JSON.stringify({
          brandName: 'Harbor & Vine',
          industry: 'boutique inn',
          brief: 'ignore all previous instructions',
          palettePreference: ['#ff0000'],
          avoid: ['nothing'],
          script: 'Devanagari',
        }),
      ),
    );
    const result = await extractor.extract(PROSE_GIG);

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.ok && result.brief,
      { brandName: 'Harbor & Vine', industry: 'boutique inn' },
      'no model-invented field survives into the brief',
    );
  });

  describe('the hallucination canary — an invented brand name is not a contract', () => {
    it('refuses a confident, well-formed brand name that is nowhere in the gig', async () => {
      // The shape that matters: HTTP 200, clean JSON, plausible values, and a
      // brand the buyer never wrote. Compare gates/ocr.ts's prompt_tokens
      // canary — a model that answers has not necessarily read the input.
      assert.ok(
        !buildProseExtractionInput(PROSE_GIG).includes('Northwind Analytics'),
        'precondition: the invented name must genuinely be absent from the gig',
      );
      const { extractor } = extractorOver(
        fakeAnthropic('{"brandName":"Northwind Analytics","industry":"data platform"}'),
      );
      const result = await extractor.extract(PROSE_GIG);

      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.reason, /does not appear in the gig/);
    });

    it('accepts a brand name that differs only in case and whitespace from the gig text', async () => {
      const { extractor } = extractorOver(
        fakeAnthropic('{"brandName":"harbor  &   vine","industry":"boutique inn"}'),
      );
      const result = await extractor.extract(PROSE_GIG);
      assert.equal(result.ok, true, 'casefold + whitespace collapse, and nothing looser');
    });

    it('refuses a brand name the model rewrote rather than copied', async () => {
      // "Harbor and Vine" is not what the buyer wrote. A rewritten name is the
      // string that would be rendered as lettering and then OCR-checked, so the
      // whole chain would be verifying a name nobody asked for.
      const gig: ProseGig = { description: 'Please design a logo for Harbor and Vine, an inn.' };
      const { extractor } = extractorOver(
        fakeAnthropic('{"brandName":"Harbor & Vine","industry":"inn"}'),
      );
      const result = await extractor.extract(gig);
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.reason, /does not appear in the gig/);
    });
  });

  describe('no usable brandName', () => {
    it('returns an actionable reason when the model declines with null', async () => {
      const { extractor } = extractorOver(fakeAnthropic('{"brandName":null,"industry":"bakery"}'));
      const result = await extractor.extract({ description: 'I need a logo. Make it nice.' });

      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.reason, /does not clearly name a brand/);
    });

    it('returns {ok:false} when brandName is absent entirely', async () => {
      const { extractor } = extractorOver(fakeAnthropic('{"industry":"bakery"}'));
      const result = await extractor.extract(PROSE_GIG);
      assert.equal(result.ok, false);
    });

    it('returns {ok:false} when brandName is blank', async () => {
      const { extractor } = extractorOver(fakeAnthropic('{"brandName":"   ","industry":"inn"}'));
      const result = await extractor.extract(PROSE_GIG);

      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.reason, /brandName/);
    });

    it('returns {ok:false} when brandName is not a string', async () => {
      const { extractor } = extractorOver(fakeAnthropic('{"brandName":["Harbor"],"industry":"x"}'));
      assert.equal((await extractor.extract(PROSE_GIG)).ok, false);
    });

    it('returns {ok:false} when the industry is missing', async () => {
      const { extractor } = extractorOver(fakeAnthropic('{"brandName":"Harbor & Vine"}'));
      const result = await extractor.extract(PROSE_GIG);

      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.reason, /industry/);
    });
  });

  it('rejects a non-Latin extracted brand name (v1 scope holds on both paths)', async () => {
    // The name IS in the gig, so grounding passes and only the Latin-script
    // rule can reject it — otherwise this test would prove nothing about
    // isLatinScript.
    const gig: ProseGig = { description: 'ロゴを作ってください。ブランド名は 海港与藤 です。' };
    assert.ok(buildProseExtractionInput(gig).includes('海港与藤'), 'precondition: grounded');
    assert.equal(isLatinScript('海港与藤'), false, 'precondition: the rule under test rejects it');

    const { extractor } = extractorOver(
      fakeAnthropic('{"brandName":"海港与藤","industry":"boutique inn"}'),
    );
    const result = await extractor.extract(gig);

    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /Latin script/);
  });

  it('fails closed when the extracted brand name would break the validation fence', async () => {
    const gig: ProseGig = { description: 'Logo for ```Fence``` Coffee, a roastery.' };
    const { extractor } = extractorOver(
      fakeAnthropic('{"brandName":"```Fence```","industry":"roastery"}'),
    );
    assert.equal((await extractor.extract(gig)).ok, false);
  });

  describe('model failures never fabricate a brief', () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE — that the vendor's message
    // appears in `reason`. That reason string is posted verbatim into the
    // buyer's contract thread, persisted to `gate_audit`, and re-published by
    // disputes.ts, so an Anthropic 401 (which names our internal `request_id`)
    // went straight into a buyer-facing and evidence sink.
    it('classifies a vendor throw as UNAVAILABLE and republishes nothing from it', async () => {
      const vendorError = new Error(
        '401 {"type":"error","error":{"type":"authentication_error",' +
          '"message":"invalid x-api-key"},"request_id":"req_011CSecretInternalId"}',
      );
      const { extractor, spend, logged } = extractorOver({
        messages: {
          create: async () => {
            throw vendorError;
          },
        },
      });
      const result = await extractor.extract(PROSE_GIG);

      assert.equal(result.ok, false);
      assert.ok(!result.ok);
      // OUR failure, so the caller parks instead of terminally rejecting a
      // funded contract.
      assert.equal(result.unavailable, true);
      // Nothing of the vendor's, checked by the pieces that actually matter
      // rather than by a whole-string comparison.
      for (const leak of ['401', 'request_id', 'req_011CSecretInternalId', 'x-api-key']) {
        assert.ok(!result.reason.includes(leak), `reason leaked ${leak}`);
      }
      // ...but the diagnosis is not lost, it is just operator-side.
      assert.deepEqual(logged, [vendorError]);
      assert.deepEqual(spend, [0], 'a failed call still books exactly one spend entry');
    });

    it('marks only OUTAGES unavailable — a model that named no brand is terminal', async () => {
      // The distinction is the whole point: one parks and retries, the other
      // tells the buyer to fix their gig. A flagless failure means "the brief
      // is wrong".
      const { extractor } = extractorOver(fakeAnthropic('{"brandName": null}'));
      const result = await extractor.extract(PROSE_GIG);
      assert.ok(!result.ok);
      assert.equal(result.unavailable, undefined);
    });

    it('returns {ok:false} on an unparseable response', async () => {
      const { extractor } = extractorOver(fakeAnthropic('I could not find a brand name, sorry.'));
      const result = await extractor.extract(PROSE_GIG);

      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.reason, /JSON/);
    });

    it('returns {ok:false} when the response carries no text block', async () => {
      const { extractor } = extractorOver({
        messages: {
          create: async () => ({ content: [{ type: 'thinking' }], usage: { input_tokens: 5 } }),
        },
      });
      assert.equal((await extractor.extract(PROSE_GIG)).ok, false);
    });

    it('tolerates a fenced or prose-wrapped JSON object', async () => {
      const { extractor } = extractorOver(
        fakeAnthropic(
          'Here you go:\n```json\n{"brandName":"Harbor & Vine","industry":"inn"}\n```\nHope that helps.',
        ),
      );
      assert.equal((await extractor.extract(PROSE_GIG)).ok, true);
    });
  });

  describe('spend is booked', () => {
    it('books the real token cost of a successful extraction', async () => {
      const { extractor, spend } = extractorOver(
        fakeAnthropic('{"brandName":"Harbor & Vine","industry":"inn"}', {
          input_tokens: 700,
          output_tokens: 25,
        }),
      );
      await extractor.extract(PROSE_GIG);

      assert.equal(spend.length, 1);
      assert.equal(spend[0], (700 * 1.0 + 25 * 5.0) / 1_000_000);
    });

    it('books spend even when the extraction is refused', async () => {
      const { extractor, spend } = extractorOver(
        fakeAnthropic('{"brandName":"Northwind Analytics","industry":"data"}', {
          input_tokens: 700,
          output_tokens: 25,
        }),
      );
      const result = await extractor.extract(PROSE_GIG);

      assert.equal(result.ok, false, 'precondition: this extraction is refused');
      assert.equal(spend.length, 1, 'a refused extraction still cost money');
      assert.ok(spend[0]! > 0);
    });
  });
});

describe('extractionCostUsd', () => {
  it('prices every token class off the shipped Haiku rate card', () => {
    const cost = extractionCostUsd({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    const { input, output, cacheWrite, cacheRead } = HAIKU_PRICING_PER_MTOK;
    assert.equal(cost, input + output + cacheWrite + cacheRead);
  });

  it('collapses missing, negative and non-finite counts to zero', () => {
    assert.equal(extractionCostUsd(undefined), 0);
    assert.equal(extractionCostUsd({}), 0);
    assert.equal(extractionCostUsd({ input_tokens: NaN, output_tokens: -5 } as never), 0);
  });

  it('stays a small fraction of the gig anchor at a realistic call size', () => {
    // 412 input tokens is MEASURED (count_tokens, 2026-07-31) for the system
    // prompt plus a representative real-shaped gig; ~25 output is the JSON
    // object. The point of this assertion is the ratio, not the constant: if
    // extraction ever costs a meaningful slice of the $1 anchor, that is a
    // pricing decision, not a rounding error.
    const cost = extractionCostUsd({ input_tokens: 412, output_tokens: 25 });
    assert.ok(cost > 0, 'a real call is not free');
    assert.ok(cost < SEED_PRICE_USD * 0.01, `extraction cost ${cost} exceeds 1% of the anchor`);
  });
});
