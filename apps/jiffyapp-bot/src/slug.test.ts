import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSlug,
  slugPolicyErrors,
  candidateSlugs,
  stagingSlug,
  STAGING_PREFIX,
} from './slug.js';

test('normalizeSlug: lowercases, replaces non [a-z0-9-] runs with a single dash, trims edges', () => {
  assert.equal(normalizeSlug('Acme Rates!'), 'acme-rates');
  assert.equal(normalizeSlug('  Spaced Out  '), 'spaced-out');
  assert.equal(normalizeSlug('Already-Fine'), 'already-fine');
  assert.equal(normalizeSlug('Multiple   Spaces___Here'), 'multiple-spaces-here');
});

test('normalizeSlug: caps at 40 characters', () => {
  const long = 'a'.repeat(60);
  const result = normalizeSlug(long);
  assert.ok(result.length <= 40, `expected <=40 chars, got ${result.length}`);
});

test('slugPolicyErrors: valid slug has no errors', () => {
  assert.deepEqual(slugPolicyErrors('acme-rates'), []);
});

test('slugPolicyErrors: rejects slugs shorter than 3 characters', () => {
  const errors = slugPolicyErrors('ab');
  assert.ok(errors.length > 0);
});

test('slugPolicyErrors: rejects reserved words', () => {
  for (const reserved of ['www', 'api', 'admin', 'dashboard', 'jiffyapp']) {
    const errors = slugPolicyErrors(reserved);
    assert.ok(errors.length > 0, `expected ${reserved} to be rejected`);
  }
});

test('slugPolicyErrors: rejects the stg- staging prefix', () => {
  const errors = slugPolicyErrors('stg-anything');
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => /stg-/.test(e)));
});

test('slugPolicyErrors: rejects phishing-fragment slugs like acme-login', () => {
  const errors = slugPolicyErrors('acme-login');
  assert.ok(errors.length > 0);
});

test('slugPolicyErrors: rejects brand-blocklist slugs like paypal-help', () => {
  const errors = slugPolicyErrors('paypal-help');
  assert.ok(errors.length > 0);
});

test('slugPolicyErrors: multiple violations all get reported', () => {
  // short AND contains a brand name is unlikely to co-occur meaningfully, but
  // a slug that is both a phishing fragment and a brand name should surface both.
  const errors = slugPolicyErrors('paypal-login');
  assert.ok(errors.length >= 2);
});

test('candidateSlugs: prefers slugPreference over name, and yields base + -2..-9 suffixes', () => {
  const candidates = candidateSlugs('acme', 'ignored');
  assert.deepEqual(candidates, [
    'acme',
    'acme-2',
    'acme-3',
    'acme-4',
    'acme-5',
    'acme-6',
    'acme-7',
    'acme-8',
    'acme-9',
  ]);
});

test('candidateSlugs: falls back to name when no preference is given', () => {
  const candidates = candidateSlugs(undefined, 'My Cool Tool');
  assert.equal(candidates[0], 'my-cool-tool');
  assert.equal(candidates.length, 9);
});

test('candidateSlugs: falls back to name when preference is an empty string', () => {
  const candidates = candidateSlugs('', 'Fallback Name');
  assert.equal(candidates[0], 'fallback-name');
});

test('stagingSlug: derives from the job deliverable token, not a recomputable hash', () => {
  const token = 'a'.repeat(64); // realistic 64-hex deliverable token
  const slug = stagingSlug(token);
  assert.ok(slug.startsWith(STAGING_PREFIX));
  assert.equal(slug.length, 28); // 'stg-' (4) + 24 chars of token
  assert.equal(slug, stagingSlug(token)); // deterministic for the same token
});

test('stagingSlug: different tokens produce different slugs', () => {
  const tokenA = 'a'.repeat(64);
  const tokenB = 'b'.repeat(64);
  assert.notEqual(stagingSlug(tokenA), stagingSlug(tokenB));
});
