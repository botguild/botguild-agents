import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import type { Criterion } from './parser.js';
import {
  buildHttpConfigFromCriterion,
  buildDomCheckFromCriterion,
  buildDataQualityCriterion,
} from './criterion-mapping.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function crit(expected: string, overrides: Partial<Criterion> = {}): Criterion {
  return {
    id: 'c1',
    description: 'a criterion',
    expected,
    checkMethod: 'http',
    ...overrides,
  };
}

// --- buildHttpConfigFromCriterion -----------------------------------------

test('http: extracts an explicit status code', () => {
  const out = buildHttpConfigFromCriterion(crit('returns status code 201'), {
    logger: silentLogger,
  });
  assert.equal(out.expectedStatusCode, 201);
});

test('http: falls back to any 3-digit status token', () => {
  const out = buildHttpConfigFromCriterion(crit('the endpoint should respond 503'), {
    logger: silentLogger,
  });
  assert.equal(out.expectedStatusCode, 503);
});

test('http: parses latency in seconds and milliseconds', () => {
  assert.equal(
    buildHttpConfigFromCriterion(crit('responds in under 3 seconds'), { logger: silentLogger })
      .maxLatencyMs,
    3000,
  );
  assert.equal(
    buildHttpConfigFromCriterion(crit('responds within 500 ms'), { logger: silentLogger })
      .maxLatencyMs,
    500,
  );
});

test('http: parses a required-headers list', () => {
  const out = buildHttpConfigFromCriterion(crit('headers: Content-Type, X-Request-Id'), {
    logger: silentLogger,
  });
  assert.deepEqual(out.requiredHeaders, ['Content-Type', 'X-Request-Id']);
});

test('http: leaves fields unset when the expectation says nothing', () => {
  const out = buildHttpConfigFromCriterion(crit('the API works'), { logger: silentLogger });
  assert.equal(out.expectedStatusCode, undefined);
  assert.equal(out.maxLatencyMs, undefined);
  assert.equal(out.requiredHeaders, undefined);
});

// --- buildDomCheckFromCriterion -------------------------------------------

test('dom: detects a visible-element check and extracts the selector', () => {
  const out = buildDomCheckFromCriterion(crit('#status element should be visible'));
  assert.equal(out.checkType, 'element-visible');
  assert.equal(out.selector, '#status');
});

test('dom: detects a text-match check from a quoted string', () => {
  const out = buildDomCheckFromCriterion(crit('the page shows "Welcome back"'));
  assert.equal(out.checkType, 'text-match');
  assert.equal(out.expectedText, 'Welcome back');
});

test('dom: defaults to element-present with a body selector when none is given', () => {
  const out = buildDomCheckFromCriterion(crit('the login form loads'));
  assert.equal(out.checkType, 'element-present');
  assert.equal(out.selector, 'body');
});

// --- buildDataQualityCriterion --------------------------------------------

test('data: uniqueness check with a percentage threshold and field name', () => {
  const out = buildDataQualityCriterion(crit("the field 'email' must be 100% unique"));
  assert.equal(out.check, 'uniqueness');
  assert.equal(out.field, 'email');
  assert.equal(out.threshold, 1);
});

test('data: type-correctness check with the expected type', () => {
  const out = buildDataQualityCriterion(crit('column age must be a number'));
  assert.equal(out.check, 'type-correctness');
  assert.equal(out.field, 'age');
  assert.equal(out.expectedType, 'number');
});

test('data: value-range check from a "between X and Y" expectation', () => {
  const out = buildDataQualityCriterion(crit('value between 1 and 10', { id: 'score' }));
  assert.equal(out.check, 'value-range');
  assert.equal(out.minValue, 1);
  assert.equal(out.maxValue, 10);
});

test('data: pattern-match check extracts the regex body', () => {
  const out = buildDataQualityCriterion(crit('must match pattern /^[a-z]+$/', { id: 'code' }));
  assert.equal(out.check, 'pattern-match');
  assert.equal(out.pattern, '^[a-z]+$');
});

test('data: defaults to null-rate with a parsed threshold and id as field', () => {
  const out = buildDataQualityCriterion(crit('no more than 5% nulls', { id: 'notes' }));
  assert.equal(out.check, 'null-rate');
  assert.equal(out.field, 'notes');
  assert.equal(out.threshold, 0.05);
});
