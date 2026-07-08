import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PLAIN_LANGUAGE_FLOOR_GRADE,
  READABILITY_LIB,
  checkRewrite,
  scoreReadability,
} from './readability.js';

const COMPLEX =
  'Notwithstanding the considerable methodological heterogeneity characterizing contemporary ' +
  'investigations, longitudinal epidemiological analyses consistently demonstrate statistically ' +
  'significant associations between socioeconomic determinants and differential morbidity outcomes.';

const SIMPLE = 'The cat sat on the mat. It was warm. The sun was out. We went to play.';

test('scoreReadability reports the pinned lib name and version with the grade', () => {
  const score = scoreReadability(SIMPLE);
  assert.equal(score.lib, 'text-readability');
  assert.equal(score.version, READABILITY_LIB.version);
  assert.equal(typeof score.fleschKincaidGrade, 'number');
});

test('READABILITY_LIB.version matches the exact pin in package.json', () => {
  const packageJson = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'),
  ) as { dependencies: Record<string, string> };
  assert.equal(packageJson.dependencies['text-readability'], READABILITY_LIB.version);
});

test('complex prose grades far above simple prose', () => {
  const complex = scoreReadability(COMPLEX).fleschKincaidGrade;
  const simple = scoreReadability(SIMPLE).fleschKincaidGrade;
  assert.ok(complex > 12, `expected graduate-level grade, got ${complex}`);
  assert.ok(simple <= PLAIN_LANGUAGE_FLOOR_GRADE, `expected floor-level grade, got ${simple}`);
});

test('checkRewrite passes when the rewrite lowers the grade', () => {
  const check = checkRewrite(COMPLEX, SIMPLE);
  assert.equal(check.pass, true);
  assert.equal(check.atFloor, false);
  assert.ok(check.rewriteGrade < check.inputGrade);
});

test('checkRewrite fails when the rewrite raises the grade', () => {
  const check = checkRewrite(SIMPLE, COMPLEX);
  assert.equal(check.pass, false);
});

test('floor case: input at FK ≤ 5 sets atFloor and only requires not raising the grade', () => {
  const check = checkRewrite(SIMPLE, SIMPLE);
  assert.equal(check.atFloor, true);
  assert.equal(check.pass, true); // identical grade — "must merely not raise it"
  assert.equal(check.lib, 'text-readability');
});
