import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CSV_MAX_BYTES,
  META_BULK_TEMPLATE_HEADERS,
  buildCsv,
  escapeCsvField,
  parseCsv,
  validateCsvAgainstTemplate,
} from './csv.js';
import type { AdBrief, Variant } from '../types.js';

const brief: AdBrief = {
  brandVoiceGuide: 'friendly',
  offer: 'Spring sale',
  campaign: { campaignName: 'Q3-Launch-Test', objective: 'OUTCOME_TRAFFIC', adSetName: 'Prospecting-Broad-US' },
  creative: { landingUrl: 'https://example.com/offer', pageId: '1234567890', imageRef: 'hero.png' },
  platform: 'facebook-instagram-feed',
  variantCount: 10,
  angleCount: 3,
  policyConstraints: [],
};

const variant = (id: string, overrides: Partial<Variant> = {}): Variant => ({
  id,
  angle: 'value',
  headline: 'Spring savings start today',
  primaryText: 'Fresh styles, smaller prices.',
  description: 'Shop the sale',
  ...overrides,
});

test('escapeCsvField follows RFC 4180', () => {
  assert.equal(escapeCsvField('plain'), 'plain');
  assert.equal(escapeCsvField('has,comma'), '"has,comma"');
  assert.equal(escapeCsvField('has "quote"'), '"has ""quote"""');
  assert.equal(escapeCsvField('line\nbreak'), '"line\nbreak"');
  assert.equal(escapeCsvField(''), '');
});

test('buildCsv emits the exact template header row, CRLF-terminated', () => {
  const csv = buildCsv([variant('v1')], brief);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], META_BULK_TEMPLATE_HEADERS.join(','));
  assert.equal(csv.endsWith('\r\n'), true);
  assert.equal(lines.length, 3); // header + 1 row + trailing empty from final CRLF
});

test('fields with commas/quotes survive a build → parse round trip', () => {
  const tricky = variant('v1', {
    headline: 'Hello, "world"',
    primaryText: 'Multi\nline, with commas',
  });
  const csv = buildCsv([tricky], brief);
  const rows = parseCsv(csv);
  const header = rows[0] as string[];
  const row = rows[1] as string[];
  assert.equal(row[header.indexOf('Title')], 'Hello, "world"');
  assert.equal(row[header.indexOf('Body')], 'Multi\nline, with commas');
  assert.equal(row[header.indexOf('Link')], 'https://example.com/offer');
  assert.equal(row[header.indexOf('Display Link')], 'example.com');
});

test('validateCsvAgainstTemplate accepts our own output', () => {
  const csv = buildCsv([variant('v1'), variant('v2', { angle: 'urgency' })], brief);
  const result = validateCsvAgainstTemplate(csv);
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.rowCount, 2);
  assert.equal(result.templateVersion, 'meta-bulk-import-v1');
});

test('validateCsvAgainstTemplate rejects a wrong or reordered header set', () => {
  const good = buildCsv([variant('v1')], brief);
  const reordered = good.replace('Campaign Name,Campaign Objective', 'Campaign Objective,Campaign Name');
  assert.equal(validateCsvAgainstTemplate(reordered).valid, false);
  const renamed = good.replace('Title', 'Headline');
  assert.equal(validateCsvAgainstTemplate(renamed).valid, false);
});

test('validateCsvAgainstTemplate rejects rows with missing required columns', () => {
  const csv = buildCsv([variant('v1', { headline: '' })], brief);
  const result = validateCsvAgainstTemplate(csv);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"Title"')));
});

test('buildCsv throws past the 2 MB cap; validator reports oversize too', () => {
  const fat = 'x'.repeat(120); // per-variant payload large enough to blow 2MB at scale
  const variants = Array.from({ length: 20000 }, (_, i) =>
    variant(`v${i}`, { primaryText: fat, headline: fat }),
  );
  assert.throws(() => buildCsv(variants, brief), /exceeds the \d+-byte template cap/);

  // The validator independently enforces the same cap on arbitrary input.
  const oversize = `${META_BULK_TEMPLATE_HEADERS.join(',')}\r\n` + 'a,'.repeat(CSV_MAX_BYTES / 2);
  assert.equal(validateCsvAgainstTemplate(oversize).valid, false);
});
