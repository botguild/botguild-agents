import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1RegisteredBotStore, resolveRegisteredBotId } from './registeredBotStore.js';
import { createMemoryD1 } from './testing.js';

// The BOTGUILD_BOT_ID drift bug: registration returns the platform-assigned
// bot id, but the client submitted with the deploy-time env secret — set to
// the internal name before the bot existed — and every proposal 403'd with
// "You can only submit proposals for your own bots". The registered id is
// platform-issued at runtime, so like the webhook secret it lives in D1.

test('registered bot store: load returns null before any save', async () => {
  const store = createD1RegisteredBotStore(createMemoryD1());
  assert.equal(await store.load(), null);
});

test('registered bot store: save then load round-trips the id', async () => {
  const store = createD1RegisteredBotStore(createMemoryD1());
  await store.save('01KZ9XB2SC28QS1FB5Y4C935CV');
  const stored = await store.load();
  assert.equal(stored?.botId, '01KZ9XB2SC28QS1FB5Y4C935CV');
  assert.ok(stored?.capturedAt);
});

test('registered bot store: a re-registration overwrites the single row', async () => {
  const store = createD1RegisteredBotStore(createMemoryD1());
  await store.save('bot_old');
  await store.save('bot_new');
  assert.equal((await store.load())?.botId, 'bot_new');
});

test('resolveRegisteredBotId: the stored id wins over the env fallback', async () => {
  const store = createD1RegisteredBotStore(createMemoryD1());
  await store.save('01KZ9XB2SC28QS1FB5Y4C935CV');
  assert.equal(await resolveRegisteredBotId(store, 'bot-logosmith'), '01KZ9XB2SC28QS1FB5Y4C935CV');
});

test('resolveRegisteredBotId: falls back to the env id before first registration', async () => {
  const store = createD1RegisteredBotStore(createMemoryD1());
  assert.equal(await resolveRegisteredBotId(store, 'bot-logosmith'), 'bot-logosmith');
});

test('resolveRegisteredBotId: a broken store falls back rather than failing boot', async () => {
  const store = {
    load: () => Promise.reject(new Error('D1 down')),
    save: () => Promise.resolve(),
  };
  assert.equal(await resolveRegisteredBotId(store, 'bot-logosmith'), 'bot-logosmith');
});
