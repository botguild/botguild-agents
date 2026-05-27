import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRows } from './normalizer.js';

// normalizeRows is pure — no Claude, no I/O. It drops empty rows, optionally
// dedups by key, trims strings, and normalizes date/phone fields by column name.

test('drops fully empty rows and counts them as skipped', () => {
  const r = normalizeRows([{ a: 'x' }, { a: '', b: null }, { a: '   ' }], {});
  assert.equal(r.originalCount, 3);
  assert.equal(r.skippedCount, 2);
  assert.equal(r.rows.length, 1);
});

test('dedups by key (last wins) and keeps rows that lack the key', () => {
  const r = normalizeRows(
    [
      { id: 1, v: 'a' },
      { id: 1, v: 'b' },
      { id: 2, v: 'c' },
      { id: '', v: 'd' }, // empty key — kept
      { v: 'e' }, // missing key — kept
    ],
    { dedupKey: 'id' },
  );
  // id:1 collapses to one (last value 'b'), id:2 one, plus the two keyless rows.
  assert.equal(r.afterDedupCount, 4);
  const idOne = r.rows.find((row) => row['id'] === 1);
  assert.equal(idOne?.['v'], 'b');
});

test('normalizes date-named columns to ISO and counts the change', () => {
  const r = normalizeRows([{ created_at: '01/15/2024' }], {});
  assert.equal(r.rows[0]['created_at'], '2024-01-15T00:00:00.000Z');
  assert.equal(r.normalizedCount, 1);
});

test('leaves already-ISO dates unchanged', () => {
  const r = normalizeRows([{ updated_at: '2024-01-15' }], {});
  assert.equal(r.rows[0]['updated_at'], '2024-01-15');
  assert.equal(r.normalizedCount, 0);
});

test('normalizes phone-named columns to E.164 and tracks failures', () => {
  const r = normalizeRows(
    [{ phone: '(555) 123-4567' }, { mobile: '+44 20 7946 0958' }, { tel: '12' }],
    {},
  );
  assert.equal(r.rows[0]['phone'], '+15551234567');
  assert.equal(r.rows[1]['mobile'], '+442079460958');
  assert.equal(r.rows[2]['tel'], '12'); // unparseable → left as-is
  assert.equal(r.phoneFailCount, 1);
});

test('trims whitespace on plain string fields', () => {
  const r = normalizeRows([{ name: '  Ada  ' }], {});
  assert.equal(r.rows[0]['name'], 'Ada');
  assert.equal(r.normalizedCount, 1);
});

test('reports a summary and consistent counts on a mixed batch', () => {
  const r = normalizeRows(
    [
      { id: 1, name: ' A ', created_at: '01/02/2024' },
      { id: 1, name: 'A2' }, // dup id
      { id: 2, name: '' }, // not empty (has id) but blank name
      {}, // empty → skipped
    ],
    { dedupKey: 'id' },
  );
  assert.equal(r.originalCount, 4);
  assert.equal(r.skippedCount, 1);
  assert.equal(r.afterDedupCount, 2);
  assert.match(r.summary, /Processed 4 rows/);
});
