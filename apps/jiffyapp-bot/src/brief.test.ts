import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJiffyBrief,
  extractToolId,
  matchTemplate,
  briefErrorsForTemplate,
  formatBriefErrors,
  MATCHER_KEYWORDS,
} from './brief.js';
import { TEMPLATE_IDS } from './types.js';
import type { JiffyBrief } from './types.js';

// ---- parseJiffyBrief ----

test('parseJiffyBrief: fenced JSON extraction wins over inline braces', () => {
  const description = `
Here is some prose with an inline object {"name":"wrong","description":"wrong"} that should be ignored.

\`\`\`json
{"name": "Acme Calculator", "description": "A pricing calculator for Acme"}
\`\`\`
`;
  const result = parseJiffyBrief(description);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.brief.name, 'Acme Calculator');
    assert.equal(result.brief.description, 'A pricing calculator for Acme');
  }
});

test('parseJiffyBrief: falls back to the largest inline {...} object when no fence is present', () => {
  const description = 'Please build this: {"name": "Acme Tool", "description": "Does things"}';
  const result = parseJiffyBrief(description);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.brief.name, 'Acme Tool');
  }
});

test('parseJiffyBrief: invalid JSON in a fenced block returns errors', () => {
  const description = '```json\n{name: "not valid json"}\n```';
  const result = parseJiffyBrief(description);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.length > 0);
  }
});

test('parseJiffyBrief: prose-only briefs (no JSON at all) return ok:false with no JSON brief found', () => {
  const result = parseJiffyBrief('I would love a landing page for my new product launch, thanks!');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.errors, ['no JSON brief found']);
  }
});

test('parseJiffyBrief: rejects a brief missing name/description', () => {
  const result = parseJiffyBrief('```json\n{"copy": {}}\n```');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((e) => /name/.test(e)));
    assert.ok(result.errors.some((e) => /description/.test(e)));
  }
});

// ---- extractToolId ----

test('extractToolId: fenced JSON form', () => {
  const description = '```json\n{"toolId": "abc123def456"}\n```';
  assert.equal(extractToolId(description), 'abc123def456');
});

test('extractToolId: bare toolId: <uuid-ish> form', () => {
  const description = 'Following up on toolId: 9f8e7d6c5b4a3210';
  assert.equal(extractToolId(description), '9f8e7d6c5b4a3210');
});

test('extractToolId: returns undefined when absent', () => {
  assert.equal(extractToolId('no ids here at all'), undefined);
});

test('extractToolId: bare form requires a boundary, does not match inside extraToolId', () => {
  assert.equal(extractToolId('extraToolId: 9f8e7d6c5b4a3210'), undefined);
});

test('extractToolId: bare "toolId: <id>" as a standalone key still extracts', () => {
  assert.equal(extractToolId('toolId: 9f8e7d6c5b4a3210'), '9f8e7d6c5b4a3210');
});

test('extractToolId: bare "toolId=<id>" mid-sentence still extracts', () => {
  assert.equal(extractToolId('Use toolId=abc12345 here'), 'abc12345');
});

test('extractToolId: fenced JSON form still works alongside the boundary fix', () => {
  const description = '```json\n{"toolId": "abc123def456"}\n```';
  assert.equal(extractToolId(description), 'abc123def456');
});

// ---- matchTemplate ----

test('matchTemplate: explicit valid template wins, via explicit', () => {
  const brief = { template: 'calculator', name: 'n', description: 'd' } as JiffyBrief;
  const result = matchTemplate(brief, 'this text does not matter at all');
  assert.deepEqual(result, { templateId: 'calculator', via: 'explicit' });
});

test('matchTemplate: explicit invalid template returns null, never falls through to keywords', () => {
  const brief = { template: 'not-a-real-template', name: 'n', description: 'd' } as JiffyBrief;
  const result = matchTemplate(
    brief,
    'I need a landing page / marketing site for my product launch page',
  );
  assert.equal(result, null);
});

test('matchTemplate: keyword match picks the template with the most distinct keyword hits', () => {
  const result = matchTemplate(
    null,
    'I need a landing page / marketing site for my product launch page',
  );
  assert.deepEqual(result, { templateId: 'landing', via: 'keywords' });
});

test('matchTemplate: ambiguous or too-sparse text returns null', () => {
  assert.equal(matchTemplate(null, 'a page'), null);
  assert.equal(matchTemplate(undefined, 'just a generic request for a website'), null);
});

test('matchTemplate: a tie between two templates (equal top hit counts) returns null', () => {
  // "widget" keywords hit twice (widget, embed) and "quiz" keywords hit twice
  // (quiz, assessment) -- neither strictly beats the other.
  const text = 'I want a widget to embed, and also a quiz assessment on the same page';
  const result = matchTemplate(null, text);
  assert.equal(result, null);
});

test('matchTemplate: brief with no template field falls through to keyword matching', () => {
  const brief = { name: 'n', description: 'd' } as JiffyBrief;
  const result = matchTemplate(brief, 'I need a csv dashboard with a data table and chart');
  assert.deepEqual(result, { templateId: 'csv-dashboard', via: 'keywords' });
});

test('MATCHER_KEYWORDS: has an entry for every template id', () => {
  for (const id of TEMPLATE_IDS) {
    assert.ok(Array.isArray(MATCHER_KEYWORDS[id]), `missing keywords for ${id}`);
    assert.ok(MATCHER_KEYWORDS[id].length > 0);
  }
});

test('MATCHER_KEYWORDS: bare "converter" belongs to transformer only, not calculator', () => {
  assert.ok(MATCHER_KEYWORDS.transformer.includes('converter'));
  assert.ok(!MATCHER_KEYWORDS.calculator.includes('converter'));
});

test('matchTemplate: an intra-list subsumed hit ("plans" inside "compare plans") counts as one signal, not two', () => {
  // pricing-table's keyword list has both 'plans' and 'compare plans'; this text only
  // contains one real signal ('compare plans'), so it must not clear the 2-distinct-
  // hits confidence gate.
  const result = matchTemplate(null, 'customers can compare plans');
  assert.equal(result, null);
});

test('matchTemplate: two genuinely independent pricing-table hits still match', () => {
  // 'pricing page' and 'compare plans' are independent signals (neither is a substring
  // of the other), so this should clear the gate even with the subsumption fix.
  const result = matchTemplate(null, 'Check out our pricing page and compare plans here');
  assert.deepEqual(result, { templateId: 'pricing-table', via: 'keywords' });
});

// ---- briefErrorsForTemplate ----

test('briefErrorsForTemplate: complete brief for a template with no extra requirements has no errors', () => {
  const errors = briefErrorsForTemplate('landing', { name: 'x', description: 'y' } as JiffyBrief);
  assert.deepEqual(errors, []);
});

test('briefErrorsForTemplate: missing name/description always errors', () => {
  const errors = briefErrorsForTemplate('landing', {} as JiffyBrief);
  assert.ok(errors.some((e) => /name/.test(e)));
  assert.ok(errors.some((e) => /description/.test(e)));
});

test('briefErrorsForTemplate: form requires a syntactically valid notifyEmail', () => {
  const errors = briefErrorsForTemplate('form', { name: 'x', description: 'y' } as JiffyBrief);
  assert.ok(errors.some((e) => /notifyEmail/.test(e)));
});

test('briefErrorsForTemplate: form accepts a valid notifyEmail', () => {
  const errors = briefErrorsForTemplate('form', {
    name: 'x',
    description: 'y',
    notifyEmail: 'buyer@example.com',
  } as JiffyBrief);
  assert.deepEqual(errors, []);
});

test('briefErrorsForTemplate: form rejects a malformed notifyEmail', () => {
  const errors = briefErrorsForTemplate('form', {
    name: 'x',
    description: 'y',
    notifyEmail: 'not-an-email',
  } as JiffyBrief);
  assert.ok(errors.some((e) => /notifyEmail/.test(e)));
});

test('briefErrorsForTemplate: waitlist requires notifyEmail', () => {
  const errors = briefErrorsForTemplate('waitlist', { name: 'x', description: 'y' } as JiffyBrief);
  assert.ok(errors.some((e) => /notifyEmail/.test(e)));
});

test('briefErrorsForTemplate: quiz only requires notifyEmail when relayResult is true', () => {
  const withoutRelay = briefErrorsForTemplate('quiz', {
    name: 'x',
    description: 'y',
  } as JiffyBrief);
  assert.deepEqual(withoutRelay, []);

  const withRelayNoEmail = briefErrorsForTemplate('quiz', {
    name: 'x',
    description: 'y',
    relayResult: true,
  } as JiffyBrief);
  assert.ok(withRelayNoEmail.some((e) => /notifyEmail/.test(e)));

  const withRelayAndEmail = briefErrorsForTemplate('quiz', {
    name: 'x',
    description: 'y',
    relayResult: true,
    notifyEmail: 'buyer@example.com',
  } as JiffyBrief);
  assert.deepEqual(withRelayAndEmail, []);
});

test('briefErrorsForTemplate: calculator/csv-dashboard/widget/etc. do not require notifyEmail', () => {
  for (const id of [
    'calculator',
    'csv-dashboard',
    'widget',
    'link-in-bio',
    'pricing-table',
    'transformer',
  ] as const) {
    const errors = briefErrorsForTemplate(id, { name: 'x', description: 'y' } as JiffyBrief);
    assert.deepEqual(errors, [], `expected no errors for ${id}`);
  }
});

// ---- formatBriefErrors ----

test('formatBriefErrors: renders an intro line and a bullet per error', () => {
  const message = formatBriefErrors([
    'name: required non-empty string',
    'notifyEmail: required for the form template (a valid email address)',
  ]);
  assert.match(message, /```json/);
  assert.match(message, /- name: required non-empty string/);
  assert.match(message, /- notifyEmail: required for the form template \(a valid email address\)/);
});

test('formatBriefErrors: empty errors still produces a string (not called in practice, but must not throw)', () => {
  assert.doesNotThrow(() => formatBriefErrors([]));
});
