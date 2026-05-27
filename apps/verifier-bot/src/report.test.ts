import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentClient } from '@botguild/agent-core';
import type { Logger } from 'pino';
import { generateAndDeliverReport } from './report.js';
import type { CheckResult } from './runners/http.js';
import type { AuditVerdict } from './runners/audit.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function checkResult(verdict: 'pass' | 'fail', description: string): CheckResult {
  return {
    criterionId: description.toLowerCase().replace(/\s+/g, '-'),
    description,
    expected: 'ok',
    actual: verdict === 'pass' ? 'ok' : 'not ok',
    verdict,
  } as CheckResult;
}

function audit(needsHumanReview: boolean): AuditVerdict {
  return {
    criterionId: 'subjective-1',
    verdict: 'pass',
    reasoning: 'looks fine',
    confidence: 0.8,
    needsHumanReview,
  } as AuditVerdict;
}

// Captures the milestone delivery and returns canned report markdown from Claude.
function harness() {
  const delivered: { note: string; attachments?: string[] }[] = [];
  const client = {
    deliverMilestone: async (
      _c: string,
      _m: string,
      payload: { note: string; attachments?: string[] },
    ) => {
      delivered.push(payload);
    },
  } as unknown as AgentClient;
  globalThis.fetch = (async () => {
    const body = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: '## Verdict\nGenerated report body.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { client, delivered };
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('all checks pass with no human review → PASS, and delivers the report', async () => {
  const { client, delivered } = harness();
  const result = await generateAndDeliverReport(
    'contract-1',
    'ms-1',
    [checkResult('pass', 'home loads'), checkResult('pass', 'login works')],
    [],
    [],
    { client, apiKey: 'k', logger: silentLogger },
  );

  assert.equal(result.verdict, 'PASS');
  assert.equal(result.passCount, 2);
  assert.equal(result.failCount, 0);
  assert.equal(result.reportMarkdown, '## Verdict\nGenerated report body.');
  assert.match(result.milestoneNote, /Verdict: PASS/);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].note, /Generated report body/);
  assert.equal(delivered[0].attachments, undefined, 'no screenshots → no attachments');
});

test('any failed check → FAIL, and the milestone note lists critical failures', async () => {
  const { client, delivered } = harness();
  const result = await generateAndDeliverReport(
    'contract-1',
    'ms-1',
    [checkResult('pass', 'home loads'), checkResult('fail', 'checkout works')],
    [],
    [],
    { client, apiKey: 'k', logger: silentLogger },
  );

  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failCount, 1);
  assert.match(result.milestoneNote, /Critical failures: checkout works/);
  assert.equal(delivered.length, 1);
});

test('checks pass but an audit needs human review → PARTIAL', async () => {
  const { client } = harness();
  const result = await generateAndDeliverReport(
    'contract-1',
    'ms-1',
    [checkResult('pass', 'home loads')],
    [audit(true)],
    [],
    { client, apiKey: 'k', logger: silentLogger },
  );

  assert.equal(result.verdict, 'PARTIAL');
});

test('screenshots are delivered as png data-URL attachments', async () => {
  const { client, delivered } = harness();
  await generateAndDeliverReport(
    'contract-1',
    'ms-1',
    [checkResult('pass', 'home loads')],
    [],
    ['AAAA', 'BBBB'],
    { client, apiKey: 'k', logger: silentLogger },
  );

  assert.deepEqual(delivered[0].attachments, [
    'data:image/png;base64,AAAA',
    'data:image/png;base64,BBBB',
  ]);
});
