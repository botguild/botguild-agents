import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSlug,
  decideDispatch,
  isStagingSlug,
  GONE_PAGE_HTML,
  NOT_FOUND_PAGE_HTML,
} from './decide.js';

test('resolveSlug extracts the leftmost label under the tool suffix', () => {
  assert.equal(resolveSlug('acme-rates.jiffyapp.dev', 'jiffyapp.dev'), 'acme-rates');
});

test('resolveSlug rejects apex, www, nested and foreign hosts', () => {
  assert.equal(resolveSlug('jiffyapp.dev', 'jiffyapp.dev'), null);
  assert.equal(resolveSlug('www.jiffyapp.dev', 'jiffyapp.dev'), null);
  assert.equal(resolveSlug('a.b.jiffyapp.dev', 'jiffyapp.dev'), null);
  assert.equal(resolveSlug('acme.example.com', 'jiffyapp.dev'), null);
  assert.equal(resolveSlug('ACME.JIFFYAPP.DEV', 'jiffyapp.dev'), 'acme');
});

test('decideDispatch serves live and grace tools', () => {
  assert.deepEqual(decideDispatch('live'), { kind: 'serve' });
  assert.deepEqual(decideDispatch('grace'), { kind: 'serve' });
});

test('decideDispatch 410s suspended and killed tools', () => {
  assert.deepEqual(decideDispatch('suspended'), { kind: 'gone' });
  assert.deepEqual(decideDispatch('killed'), { kind: 'gone' });
});

test('decideDispatch treats building/unknown as not found', () => {
  assert.deepEqual(decideDispatch('building'), { kind: 'unknown' });
  assert.deepEqual(decideDispatch(null), { kind: 'unknown' });
});

// Staging slugs (bot Task 17) are recognized by their `stg-` prefix and served straight from
// the dispatch namespace before the D1 status read (index.ts) — no tools row exists yet.
test('isStagingSlug is true only for the stg- prefix', () => {
  assert.equal(isStagingSlug('stg-0123456789abcdef01234567'), true);
  assert.equal(isStagingSlug('acme-rates'), false);
  assert.equal(isStagingSlug('staging'), false);
  assert.equal(isStagingSlug('stg'), false);
});

test('gone page carries the eject note; both pages are complete HTML', () => {
  assert.match(GONE_PAGE_HTML, /eject/i);
  assert.match(GONE_PAGE_HTML, /hosting/i);
  assert.match(NOT_FOUND_PAGE_HTML, /<html/i);
});
