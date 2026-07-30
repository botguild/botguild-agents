import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOcrGate, normalizeForMatch, similarity } from './ocr.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// usage.prompt_tokens must clear MIN_VISION_PROMPT_TOKENS or every call here
// trips the hallucination canary and returns `unavailable` before the
// transcription is ever read — 2497 is the brief's own live-measured value
// for a prompt that actually carried the image.
const aiReturning = (text: string) => ({
  run: async () => ({ response: text, usage: { prompt_tokens: 2497 } }),
});

describe('normalizeForMatch', () => {
  it('case-folds and strips punctuation and whitespace', () => {
    assert.equal(normalizeForMatch('Harbor & Vine'), 'harborvine');
    assert.equal(normalizeForMatch('HARBOR&VINE'), 'harborvine');
    assert.equal(normalizeForMatch("  O'Brien-Smith "), 'obriensmith');
  });

  it('folds diacritics so Café matches Cafe', () => {
    assert.equal(normalizeForMatch('Café'), normalizeForMatch('Cafe'));
  });

  it('does NOT fold digits or symbols into letters (garbled must stay garbled)', () => {
    assert.notEqual(normalizeForMatch('H@rb0r'), normalizeForMatch('Harbor'));
    assert.notEqual(normalizeForMatch('V1NE'), normalizeForMatch('VINE'));
  });
});

describe('similarity', () => {
  it('is 1 for identical strings and 0 for wholly different ones', () => {
    assert.equal(similarity('harborvine', 'harborvine'), 1);
    assert.ok(similarity('harborvine', 'zzzzzzzzzz') < 0.2);
  });

  it('scores a one-character slip high and glyph soup low', () => {
    assert.ok(similarity('harborvine', 'harborvin') > 0.85);
    assert.ok(similarity('harborvine', 'hrbcrvlne') < 0.85);
  });

  it('handles empty input without dividing by zero', () => {
    assert.equal(similarity('', ''), 1);
    assert.equal(similarity('abc', ''), 0);
  });
});

describe('OcrGate', () => {
  it('passes a clean readback and snapshots the model id and raw text', async () => {
    const gate = createOcrGate({ ai: aiReturning('{"text":"Harbor & Vine","unsafe":false}') });
    const outcome = await gate.check(PNG, 'Harbor & Vine');
    assert.ok(outcome.status === 'ok');
    assert.equal(outcome.verdict.pass, true);
    assert.equal(outcome.verdict.transcription, 'Harbor & Vine');
    assert.ok(outcome.verdict.model.length > 0);
    assert.ok(outcome.verdict.checkedAt.length > 0);
  });

  it('fails glyph soup below the threshold', async () => {
    const gate = createOcrGate({ ai: aiReturning('{"text":"Hrbcr & Vlne","unsafe":false}') });
    const outcome = await gate.check(PNG, 'Harbor & Vine');
    assert.ok(outcome.status === 'ok');
    assert.equal(outcome.verdict.pass, false);
    assert.ok(outcome.verdict.score < 0.85);
  });

  it('fails an unsafe-flagged image regardless of the readback score', async () => {
    const gate = createOcrGate({ ai: aiReturning('{"text":"Harbor & Vine","unsafe":true}') });
    const outcome = await gate.check(PNG, 'Harbor & Vine');
    assert.ok(outcome.status === 'ok');
    assert.equal(outcome.verdict.unsafe, true);
    assert.equal(outcome.verdict.pass, false);
  });

  it('honours an explicit threshold', async () => {
    const gate = createOcrGate({ ai: aiReturning('{"text":"Harbor Vin","unsafe":false}') });
    const strict = await gate.check(PNG, 'Harbor Vine', 0.99);
    assert.ok(strict.status === 'ok' && !strict.verdict.pass);
    const lenient = await gate.check(PNG, 'Harbor Vine', 0.5);
    assert.ok(lenient.status === 'ok' && lenient.verdict.pass);
  });

  it('tolerates a model that wraps its JSON in prose or fences', async () => {
    const gate = createOcrGate({
      ai: aiReturning('Sure!\n```json\n{"text":"Harbor & Vine","unsafe":false}\n```'),
    });
    const outcome = await gate.check(PNG, 'Harbor & Vine');
    assert.ok(outcome.status === 'ok' && outcome.verdict.pass);
  });

  it('reports unavailable when the model call throws — never a silent pass', async () => {
    const gate = createOcrGate({
      ai: {
        run: async () => {
          throw new Error('AI binding unavailable');
        },
      },
    });
    assert.equal((await gate.check(PNG, 'Harbor & Vine')).status, 'unavailable');
  });

  it('reports unavailable when the response has no usable text', async () => {
    const gate = createOcrGate({ ai: aiReturning('I cannot read this image.') });
    assert.equal((await gate.check(PNG, 'Harbor & Vine')).status, 'unavailable');
  });

  it('reports unavailable when prompt_tokens is below the hallucination canary — never a verdict, even when the text would otherwise pass', async () => {
    // Mirrors the brief's live-measured failure mode: HTTP 200, a confident
    // well-formed transcription that happens to match the brand name exactly,
    // but prompt_tokens=40 proves the image never reached the model. A gate
    // that trusted this text would wave a broken logo through on hallucinated
    // evidence — the canary must short-circuit to `unavailable` before the
    // transcription is even considered, regardless of what it says.
    const gate = createOcrGate({
      ai: {
        run: async () => ({
          response: '{"text":"Harbor & Vine","unsafe":false}',
          usage: { prompt_tokens: 40 },
        }),
      },
    });
    const outcome = await gate.check(PNG, 'Harbor & Vine');
    assert.equal(outcome.status, 'unavailable');
    assert.ok(!('verdict' in outcome));
  });

  it('fails the gate on a hostile transcription that does not match the brand name, never a pass', async () => {
    // The mirror of the "clean readback" happy path: a transcription for a
    // wholly different string (not a near-miss typo) must drive the gate to
    // pass:false, not merely a low score that some caller could ignore.
    const gate = createOcrGate({
      ai: aiReturning('{"text":"The quick brown fox jumps over the lazy dog","unsafe":false}'),
    });
    const outcome = await gate.check(PNG, 'Harbor & Vine');
    assert.ok(outcome.status === 'ok');
    assert.equal(outcome.verdict.pass, false);
    assert.ok(outcome.verdict.score < 0.2);
  });
});
