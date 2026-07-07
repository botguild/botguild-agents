import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1WebhookSecretStore } from './webhookSecretStore.js';
import { createMemoryD1 } from './testing.js';

test('load returns null before any secret is saved', async () => {
  const store = createD1WebhookSecretStore(createMemoryD1());
  assert.equal(await store.loadWebhookSecret(), null);
});

test('save then load round-trips secret + webhookId with a capture timestamp', async () => {
  const store = createD1WebhookSecretStore(createMemoryD1());

  await store.saveWebhookSecret('whsec_abc', 'wh_1');
  const loaded = await store.loadWebhookSecret();

  assert.equal(loaded?.secret, 'whsec_abc');
  assert.equal(loaded?.webhookId, 'wh_1');
  assert.ok(!Number.isNaN(Date.parse(loaded!.capturedAt)));
});

test('a re-registration overwrites the single stored secret', async () => {
  const db = createMemoryD1();
  const store = createD1WebhookSecretStore(db);

  await store.saveWebhookSecret('whsec_old', 'wh_old');
  await store.saveWebhookSecret('whsec_new', 'wh_new');

  const loaded = await store.loadWebhookSecret();
  assert.equal(loaded?.secret, 'whsec_new');
  assert.equal(loaded?.webhookId, 'wh_new');

  const { results } = await db.prepare('SELECT id FROM webhook_secret').all();
  assert.equal(results.length, 1, 'exactly one row ever exists');
});

test('missing webhookId is stored as null and loads as undefined', async () => {
  const store = createD1WebhookSecretStore(createMemoryD1());
  await store.saveWebhookSecret('whsec_abc');
  const loaded = await store.loadWebhookSecret();
  assert.equal(loaded?.secret, 'whsec_abc');
  assert.equal(loaded?.webhookId, undefined);
});

test('a second store over the same database reads the persisted secret (redeploy survival)', async () => {
  const db = createMemoryD1();
  await createD1WebhookSecretStore(db).saveWebhookSecret('whsec_abc', 'wh_1');

  const loaded = await createD1WebhookSecretStore(db).loadWebhookSecret();
  assert.equal(loaded?.secret, 'whsec_abc');
});
