import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAIKU_PRICING_PER_MTOK } from './config.js';
import { parseVariantsPayload, usageCostUsd } from './generate.js';

// FR-5 spend accounting: real token usage at pinned Haiku pricing.
test('usageCostUsd prices input/output/cache tokens at Haiku list rates', () => {
  assert.equal(usageCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }), HAIKU_PRICING_PER_MTOK.input);
  assert.equal(usageCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }), HAIKU_PRICING_PER_MTOK.output);
  const mixed = usageCostUsd({
    input_tokens: 2_000,
    output_tokens: 1_500,
    cache_creation_input_tokens: 4_000,
    cache_read_input_tokens: 10_000,
  });
  // 2k×$1 + 1.5k×$5 + 4k×$1.25 + 10k×$0.10, all per MTok
  assert.ok(Math.abs(mixed - (0.002 + 0.0075 + 0.005 + 0.001)) < 1e-12);
  assert.equal(usageCostUsd({ input_tokens: 0, output_tokens: 0 }), 0);
  // Null cache fields (the SDK's type) don't poison the sum.
  assert.equal(
    usageCostUsd({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null }),
    0,
  );
});

test('parseVariantsPayload accepts bare and fenced JSON objects', () => {
  const bare = parseVariantsPayload(
    '{"variants": [{"angle": "urgency", "headline": "h", "primaryText": "p", "description": "d"}]}',
  );
  assert.equal(bare.length, 1);
  assert.equal(bare[0]?.angle, 'urgency');

  const fenced = parseVariantsPayload(
    'Here you go:\n```json\n{"variants": [{"angle": " value ", "headline": " h ", "primaryText": "p", "description": "d"}]}\n```',
  );
  assert.equal(fenced[0]?.angle, 'value'); // trimmed
  assert.equal(fenced[0]?.headline, 'h');
});

test('parseVariantsPayload rejects missing arrays and malformed variants', () => {
  assert.throws(() => parseVariantsPayload('{"nope": true}'), /no variants array/);
  assert.throws(
    () => parseVariantsPayload('{"variants": [{"angle": "a", "headline": 42}]}'),
    /missing angle\/headline\/primaryText\/description/,
  );
  assert.throws(() => parseVariantsPayload('not json at all'));
});
