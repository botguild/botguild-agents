import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleLogger } from './logger.js';

// Capture console output per method so tests can assert on emitted lines.
type Captured = { method: string; line: string };
let captured: Captured[] = [];
const original = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

beforeEach(() => {
  captured = [];
  for (const method of ['debug', 'info', 'warn', 'error'] as const) {
    console[method] = (line: string) => captured.push({ method, line });
  }
});

afterEach(() => {
  Object.assign(console, original);
});

function lastEntry(): Record<string, unknown> {
  assert.ok(captured.length > 0, 'expected at least one log line');
  return JSON.parse(captured[captured.length - 1]!.line) as Record<string, unknown>;
}

test('emits one-line JSON with the base field contract (service, botId)', () => {
  const logger = createConsoleLogger({ service: 'test-bot', botId: 'bot_1' });
  logger.info({ gigId: 'g_1' }, 'scored gig');

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.method, 'info');
  const entry = lastEntry();
  assert.equal(entry['level'], 'info');
  assert.equal(entry['service'], 'test-bot');
  assert.equal(entry['botId'], 'bot_1');
  assert.equal(entry['gigId'], 'g_1');
  assert.equal(entry['msg'], 'scored gig');
  assert.ok(typeof entry['time'] === 'string');
});

test('botId defaults to unregistered, matching agent-core createLogger', () => {
  const logger = createConsoleLogger({ service: 'test-bot' });
  logger.info('hello');
  assert.equal(lastEntry()['botId'], 'unregistered');
});

test('message-only call shape works', () => {
  const logger = createConsoleLogger({ service: 'test-bot' });
  logger.warn('plain message');
  const entry = lastEntry();
  assert.equal(entry['msg'], 'plain message');
  assert.equal(captured[0]!.method, 'warn');
});

test('child() merges bindings into every line', () => {
  const logger = createConsoleLogger({ service: 'test-bot', botId: 'bot_1' });
  const child = logger.child({ contractId: 'c_1' });
  child.error({ err: 'boom' }, 'handler failed');

  const entry = lastEntry();
  assert.equal(entry['contractId'], 'c_1');
  assert.equal(entry['service'], 'test-bot');
  assert.equal(captured[0]!.method, 'error');
});

test('level threshold filters lower levels; silent drops everything', () => {
  const logger = createConsoleLogger({ service: 'test-bot', level: 'warn' });
  logger.info('dropped');
  logger.debug('dropped');
  logger.warn('kept');
  logger.fatal('kept');
  assert.equal(captured.length, 2);
  assert.deepEqual(
    captured.map((c) => c.method),
    ['warn', 'error'],
  );

  captured = [];
  const silent = createConsoleLogger({ service: 'test-bot', level: 'silent' });
  silent.fatal('nothing');
  assert.equal(captured.length, 0);
});

test('Error values serialize with name/message/stack (the pino err idiom)', () => {
  const logger = createConsoleLogger({ service: 'test-bot' });
  logger.error({ err: new Error('kaput') }, 'failed');

  const entry = lastEntry();
  const err = entry['err'] as { name: string; message: string; stack?: string };
  assert.equal(err.name, 'Error');
  assert.equal(err.message, 'kaput');
  assert.ok(typeof err.stack === 'string');
});

test('unknown level throws at construction, like pino', () => {
  assert.throws(() => createConsoleLogger({ service: 'test-bot', level: 'loud' }));
});
