import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFileSize } from './filesize.js';
import { MAX_FILE_BYTES, type EncodeResult } from '../render/encodeTypes.js';

const encoded = (over: Partial<EncodeResult>): EncodeResult => ({
  bytes: new Uint8Array(0),
  format: 'png',
  byteLength: 1000,
  ...over,
});

test('PNG under the ceiling passes (lossless, preferred)', () => {
  const decision = checkFileSize(encoded({ format: 'png', byteLength: MAX_FILE_BYTES - 1 }));
  assert.equal(decision.pass, true);
  assert.equal(decision.reason, 'ok');
  assert.equal(decision.recompose, false);
});

test('PNG over the ceiling signals a re-compose (PNG has no quality knob)', () => {
  const decision = checkFileSize(encoded({ format: 'png', byteLength: MAX_FILE_BYTES + 1 }));
  assert.equal(decision.pass, false);
  assert.equal(decision.reason, 'png-over-ceiling-recompose');
  assert.equal(decision.recompose, true);
});

test('JPEG under the ceiling at/above the floor passes', () => {
  const decision = checkFileSize(encoded({ format: 'jpeg', quality: 82, byteLength: 500_000 }));
  assert.equal(decision.pass, true);
  assert.equal(decision.reason, 'ok');
});

test('JPEG at the floor still over the ceiling signals re-compose, never degrades', () => {
  const decision = checkFileSize(
    encoded({ format: 'jpeg', quality: 70, byteLength: MAX_FILE_BYTES + 1 }),
    { jpegQualityFloor: 70 },
  );
  assert.equal(decision.pass, false);
  assert.equal(decision.reason, 'jpeg-floor-over-ceiling-recompose');
  assert.equal(decision.recompose, true);
});

test('JPEG below the declared quality floor never ships', () => {
  const decision = checkFileSize(
    encoded({ format: 'jpeg', quality: 60, byteLength: 100 }),
    { jpegQualityFloor: 70 },
  );
  assert.equal(decision.pass, false);
  assert.equal(decision.reason, 'jpeg-below-quality-floor');
});

test('honors a custom byte ceiling', () => {
  const decision = checkFileSize(encoded({ format: 'png', byteLength: 2000 }), { maxBytes: 1500 });
  assert.equal(decision.pass, false);
  assert.equal(decision.reason, 'png-over-ceiling-recompose');
});
