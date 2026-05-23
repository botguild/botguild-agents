import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWebhookSecret, saveWebhookSecret } from './webhookSecretStore.js';

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'webhook-secret-test-'));
}

test('loadWebhookSecret returns null when the file does not exist', () => {
  const dataDir = freshTempDir();
  try {
    const result = loadWebhookSecret({ dataDir });
    assert.equal(result, null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('saveWebhookSecret writes and loadWebhookSecret reads it back', () => {
  const dataDir = freshTempDir();
  try {
    saveWebhookSecret('whsec_round_trip_test', 'wh_abc', { dataDir });
    const result = loadWebhookSecret({ dataDir });
    assert.ok(result, 'expected a stored secret to load');
    assert.equal(result!.secret, 'whsec_round_trip_test');
    assert.equal(result!.webhookId, 'wh_abc');
    assert.ok(result!.capturedAt, 'expected capturedAt timestamp');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('saveWebhookSecret overwrites previous value', () => {
  const dataDir = freshTempDir();
  try {
    saveWebhookSecret('old', 'wh_old', { dataDir });
    saveWebhookSecret('new', 'wh_new', { dataDir });
    const result = loadWebhookSecret({ dataDir });
    assert.equal(result?.secret, 'new');
    assert.equal(result?.webhookId, 'wh_new');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('loadWebhookSecret returns null on corrupt JSON', () => {
  const dataDir = freshTempDir();
  try {
    const file = join(dataDir, 'webhook-secret.json');
    writeFileSync(file, '{ not valid json', 'utf-8');
    assert.ok(existsSync(file));
    const result = loadWebhookSecret({ dataDir });
    assert.equal(result, null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('saveWebhookSecret writes file with restrictive (0600) permissions', () => {
  const dataDir = freshTempDir();
  try {
    saveWebhookSecret('whsec_perm_test', 'wh_1', { dataDir });
    const file = join(dataDir, 'webhook-secret.json');
    const stat = statSync(file);
    // Only the owner should be able to read/write — mode 0o600. The
    // permission bits live in the low 9 bits of st_mode.
    const perms = stat.mode & 0o777;
    assert.equal(perms, 0o600, `expected file mode 0o600, got 0o${perms.toString(8)}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('loadWebhookSecret returns null when secret field is empty', () => {
  const dataDir = freshTempDir();
  try {
    const file = join(dataDir, 'webhook-secret.json');
    writeFileSync(file, JSON.stringify({ secret: '', webhookId: 'wh_1' }), 'utf-8');
    const result = loadWebhookSecret({ dataDir });
    assert.equal(result, null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
