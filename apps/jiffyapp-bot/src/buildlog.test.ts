import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import type { D1Like } from '@botguild/agent-core-workers';
import { applyMigrations } from './testSupport.js';
import { createBuildLogStore, type BuildLogStore } from './jobs.js';
import { buildLogPageHtml, createLogEventStream, handleLogJson } from './buildlog.js';

async function freshDb(): Promise<D1Like> {
  const db = createMemoryD1();
  await applyMigrations(db);
  return db;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

// --- handleLogJson ------------------------------------------------------------------

test('handleLogJson returns events after seq, and done when the returned slice hits a terminal stage', async () => {
  const db = await freshDb();
  const store = createBuildLogStore(db);
  await store.append('tok-1', 'plan', 'planning');
  await store.append('tok-1', 'codegen', 'generating');

  const before = await handleLogJson(store, 'tok-1', 0);
  assert.equal(before.status, 200);
  assert.equal(before.body.events.length, 2);
  assert.equal(before.body.done, false);

  await store.append('tok-1', 'delivered', 'tool delivered');
  const withTerminal = await handleLogJson(store, 'tok-1', 0);
  assert.equal(withTerminal.body.events.length, 3);
  assert.equal(withTerminal.body.done, true);

  // Only the new (terminal) row is returned when polling from seq 2.
  const afterTwo = await handleLogJson(store, 'tok-1', 2);
  assert.equal(afterTwo.body.events.length, 1);
  assert.equal(afterTwo.body.done, true);

  // A slice with nothing new (the terminal row already consumed) is not "done".
  const stale = await handleLogJson(store, 'tok-1', 3);
  assert.equal(stale.body.events.length, 0);
  assert.equal(stale.body.done, false);
});

test('handleLogJson done is false when the slice has non-terminal events only', async () => {
  const db = await freshDb();
  const store = createBuildLogStore(db);
  await store.append('tok-2', 'plan', 'planning');
  const result = await handleLogJson(store, 'tok-2', 0);
  assert.equal(result.body.done, false);
});

// --- createLogEventStream -----------------------------------------------------------

test('createLogEventStream emits id:/data: frames for events already present and closes on terminal', async () => {
  const db = await freshDb();
  const store = createBuildLogStore(db);
  await store.append('tok-3', 'plan', 'planning');
  await store.append('tok-3', 'codegen', 'generating');
  await store.append('tok-3', 'delivered', 'tool delivered');

  const stream = createLogEventStream({
    store,
    token: 'tok-3',
    lastEventId: 0,
    pollMs: 1,
    sleep: async () => {
      throw new Error('sleep should not be called — a terminal event is already present');
    },
  });
  const text = await readAll(stream);

  assert.match(text, /id: 1\ndata: /);
  assert.match(text, /id: 2\ndata: /);
  assert.match(text, /id: 3\ndata: /);
  assert.match(text, /"stage":"delivered"/);
});

test('createLogEventStream polls for new rows between frames (fake sleep) and closes on terminal', async () => {
  const db = await freshDb();
  const store = createBuildLogStore(db);
  await store.append('tok-4', 'plan', 'planning');

  let sleeps = 0;
  const stream = createLogEventStream({
    store,
    token: 'tok-4',
    lastEventId: 0,
    pollMs: 1,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) await store.append('tok-4', 'codegen', 'generating');
      else if (sleeps === 2) await store.append('tok-4', 'delivered', 'tool delivered');
    },
  });
  const text = await readAll(stream);

  assert.ok(sleeps >= 2, `expected at least 2 polls, got ${sleeps}`);
  assert.match(text, /id: 1\ndata: /);
  assert.match(text, /id: 2\ndata: /);
  assert.match(text, /id: 3\ndata: /);
  assert.match(text, /"stage":"delivered"/);
});

test('createLogEventStream honors lastEventId (Last-Event-ID reconnect)', async () => {
  const db = await freshDb();
  const store = createBuildLogStore(db);
  await store.append('tok-5', 'plan', 'planning');
  await store.append('tok-5', 'codegen', 'generating');
  await store.append('tok-5', 'delivered', 'tool delivered');

  const stream = createLogEventStream({
    store,
    token: 'tok-5',
    lastEventId: 2, // reconnect after seq 2 — only the terminal row should be emitted
    pollMs: 1,
    sleep: async () => {
      throw new Error('sleep should not be called');
    },
  });
  const text = await readAll(stream);

  assert.doesNotMatch(text, /id: 1\n/);
  assert.doesNotMatch(text, /id: 2\n/);
  assert.match(text, /id: 3\ndata: /);
});

test('createLogEventStream stops polling the store once the reader cancels', async () => {
  const db = await freshDb();
  const store = createBuildLogStore(db);
  await store.append('tok-6', 'plan', 'planning');

  let sinceCalls = 0;
  const countingStore: BuildLogStore = {
    ...store,
    since: async (tok, after) => {
      sinceCalls += 1;
      return store.since(tok, after);
    },
  };

  const stream = createLogEventStream({
    store: countingStore,
    token: 'tok-6',
    lastEventId: 0,
    pollMs: 1,
    // Resolves immediately — a tight loop, so cancellation actually races the poll loop instead
    // of trivially winning because nothing else is happening.
    sleep: async () => {},
  });

  const reader = stream.getReader();
  await reader.read(); // first frame — the 'plan' event already in the store
  const callsAtCancel = sinceCalls;
  await reader.cancel();

  // Give any single in-flight iteration a chance to finish so we're not racing it.
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(
    sinceCalls <= callsAtCancel + 1,
    `expected since() polling to stop after cancel (callsAtCancel=${callsAtCancel}, sinceCalls=${sinceCalls})`,
  );
});

// --- buildLogPageHtml ---------------------------------------------------------------

test('buildLogPageHtml references its own SSE + poll endpoints and no external origin', () => {
  const token = 'a'.repeat(64);
  const html = buildLogPageHtml(token);

  // The token is a runtime JS variable (embedded once, then concatenated into each URL), so the
  // page source builds `/p/<token>/events` and `/p/<token>/log.json?after=<seq>` via string
  // concatenation rather than a literal substituted path.
  assert.match(html, /new EventSource\('\/p\/' \+ token \+ '\/events'\)/);
  assert.match(html, /fetch\('\/p\/' \+ token \+ '\/log\.json\?after=' \+ lastSeq\)/);
  assert.match(html, new RegExp(`var token = ${JSON.stringify(token)}`));
  // No http(s) URL anywhere — every request target is a same-origin relative path.
  assert.doesNotMatch(html, /https?:\/\//);
});

test('buildLogPageHtml is self-contained (no <link>/<script src> to another origin)', () => {
  const html = buildLogPageHtml('b'.repeat(64));
  assert.doesNotMatch(html, /<link\b/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
});
