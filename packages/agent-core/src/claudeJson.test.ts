import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeJson } from './claudeJson.js';

test('parses bare JSON', () => {
  assert.deepEqual(parseClaudeJson('{"a": 1}'), { a: 1 });
});

test('parses JSON wrapped in a ```json fence', () => {
  // The exact shape that killed VerifierBot's recovered pipeline.
  const text = '```json\n{\n  "checkType": "smoke",\n  "targets": ["https://botguild.ai"]\n}\n```';
  assert.deepEqual(parseClaudeJson(text), {
    checkType: 'smoke',
    targets: ['https://botguild.ai'],
  });
});

test('parses JSON wrapped in a bare ``` fence', () => {
  assert.deepEqual(parseClaudeJson('```\n{"a": true}\n```'), { a: true });
});

test('parses JSON with leading/trailing prose', () => {
  const text =
    'Here is the extraction you asked for:\n\n{"a": [1, 2]}\n\nLet me know if this works.';
  assert.deepEqual(parseClaudeJson(text), { a: [1, 2] });
});

test('parses a fenced object even with prose around the fence', () => {
  const text = 'Sure!\n```json\n{"a": "b"}\n```\nAnything else?';
  assert.deepEqual(parseClaudeJson(text), { a: 'b' });
});

test('nested braces survive the prose fallback', () => {
  const text = 'Result: {"outer": {"inner": 1}} — done.';
  assert.deepEqual(parseClaudeJson(text), { outer: { inner: 1 } });
});

test('throws on genuinely unparseable text', () => {
  assert.throws(() => parseClaudeJson('I cannot produce that JSON.'), SyntaxError);
});
