import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTemplate, serializeTemplate, TEMPLATE_VERSION } from './template.js';
import { og } from '../layouts/og.js';
import type { BrandKit } from '../types.js';

const brandKit: BrandKit = {
  palette: ['#0F1E3C', '#FF6B5E', '#F5C518'],
  swatchRegions: [],
};

test('serializeTemplate emits parseable JSON with the layout source', () => {
  const artifact = serializeTemplate(og, brandKit, { headline: 'On-brand in one publish' });
  const result = checkTemplate(artifact);
  assert.equal(result.pass, true);
  assert.equal(result.parsed?.templateId, og.templateId);
  assert.equal(result.parsed?.version, TEMPLATE_VERSION);
  assert.equal(result.parsed?.element.type, 'div');
  assert.equal(result.parsed?.width, 1200);
});

test('an absent template fails the gate', () => {
  assert.equal(checkTemplate(undefined).pass, false);
  assert.equal(checkTemplate('').pass, false);
  assert.equal(checkTemplate('   ').pass, false);
});

test('malformed JSON fails the gate', () => {
  assert.equal(checkTemplate('{ not json').pass, false);
});

test('JSON missing the layout source fails the gate', () => {
  assert.equal(checkTemplate(JSON.stringify({ templateId: 'x', width: 1, height: 1 })).pass, false);
  assert.equal(checkTemplate(JSON.stringify({ width: 1, height: 1, element: { type: 'div' } })).pass, false);
});
