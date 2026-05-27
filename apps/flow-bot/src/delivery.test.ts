import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentClient } from '@botguild/agent-core';
import type { Logger } from 'pino';
import { deliverOutput } from './delivery.js';
import type { TransformJobConfig } from './parser.js';
import type { NormalizeResult } from './normalizer.js';

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;

const jobConfig = {
  outputFormat: 'json',
  inputType: 'csv',
  transformRules: {},
} as TransformJobConfig;

const stats = {
  originalCount: 0,
  afterDedupCount: 0,
  normalizedCount: 0,
  skippedCount: 0,
  phoneFailCount: 0,
  rows: [],
  summary: '',
} as NormalizeResult;

test('skips delivery when there are zero output rows, without touching the client or Claude', async () => {
  let clientCalled = false;
  const client = {
    deliverMilestone: async () => {
      clientCalled = true;
    },
  } as unknown as AgentClient;

  const result = await deliverOutput('contract-1', 'ms-1', [], jobConfig, stats, {
    client,
    apiKey: 'unused', // never reached — no Anthropic call on the zero-rows path
    logger: silentLogger,
  });

  assert.deepEqual(result, { delivered: false, reason: 'zero_rows', milestoneId: 'ms-1' });
  assert.equal(clientCalled, false, 'no milestone delivery should be attempted');
});
