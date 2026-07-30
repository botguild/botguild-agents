import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEADLINE_LIMIT,
  HEADLINE_LIMIT_MARGIN,
  PRIMARY_TEXT_LIMIT,
  PRIMARY_TEXT_LIMIT_MARGIN,
  checkVariantLength,
  graphemeLength,
  hasEmojiOrNonLatin,
  lengthGatePasses,
} from './length.js';

test('graphemeLength counts grapheme clusters, not code units', () => {
  assert.equal(graphemeLength('hello'), 5);
  // Family emoji: 7 code points / 11 UTF-16 units, ONE grapheme cluster.
  assert.equal(graphemeLength('👨‍👩‍👧‍👦'), 1);
  assert.equal('👨‍👩‍👧‍👦'.length, 11);
  // Combining accent: e + U+0301 is one user-perceived character.
  assert.equal(graphemeLength('café'), 4);
  // Flag emoji (two regional indicators) is one grapheme.
  assert.equal(graphemeLength('🇩🇪'), 1);
  assert.equal(graphemeLength(''), 0);
});

test('hasEmojiOrNonLatin triggers on emoji and CJK but not accented Latin', () => {
  assert.equal(hasEmojiOrNonLatin('Plain ascii copy'), false);
  assert.equal(hasEmojiOrNonLatin('Café crème — très bon'), false); // Latin script keeps full limits
  assert.equal(hasEmojiOrNonLatin('Great deal 🎉'), true);
  assert.equal(hasEmojiOrNonLatin('限定オファー'), true); // CJK
  assert.equal(hasEmojiOrNonLatin('Скидка сегодня'), true); // Cyrillic
});

test('plain-Latin headline passes at exactly 40 graphemes and fails at 41', () => {
  const at = 'a'.repeat(HEADLINE_LIMIT);
  const over = 'a'.repeat(HEADLINE_LIMIT + 1);
  const pass = checkVariantLength({ headline: at, primaryText: 'short' });
  assert.equal(pass[0]?.pass, true);
  assert.equal(pass[0]?.marginApplied, false);
  const fail = checkVariantLength({ headline: over, primaryText: 'short' });
  assert.equal(fail[0]?.pass, false);
  assert.equal(lengthGatePasses(fail), false);
});

test('emoji headline gets the 10% margin: 36 passes, 37 fails', () => {
  const at = '🎉' + 'a'.repeat(HEADLINE_LIMIT_MARGIN - 1); // 36 graphemes with emoji
  const over = '🎉' + 'a'.repeat(HEADLINE_LIMIT_MARGIN); // 37 graphemes
  const pass = checkVariantLength({ headline: at, primaryText: 'short' })[0];
  assert.equal(pass?.marginApplied, true);
  assert.equal(pass?.limit, HEADLINE_LIMIT_MARGIN);
  assert.equal(pass?.pass, true);
  const fail = checkVariantLength({ headline: over, primaryText: 'short' })[0];
  assert.equal(fail?.graphemes, 37);
  assert.equal(fail?.pass, false);
});

test('CJK primary text gets the 112-grapheme margin limit', () => {
  const at = '限'.repeat(PRIMARY_TEXT_LIMIT_MARGIN);
  const over = '限'.repeat(PRIMARY_TEXT_LIMIT_MARGIN + 1);
  const checks = checkVariantLength({ headline: 'ok', primaryText: at });
  assert.equal(checks[1]?.pass, true);
  assert.equal(checks[1]?.limit, PRIMARY_TEXT_LIMIT_MARGIN);
  const failing = checkVariantLength({ headline: 'ok', primaryText: over });
  assert.equal(failing[1]?.pass, false);
});

test('plain primary text uses the full 125 limit', () => {
  const at = 'b'.repeat(PRIMARY_TEXT_LIMIT);
  const checks = checkVariantLength({ headline: 'ok', primaryText: at });
  assert.equal(checks[1]?.pass, true);
  assert.equal(checks[1]?.limit, PRIMARY_TEXT_LIMIT);
  assert.equal(lengthGatePasses(checks), true);
});
