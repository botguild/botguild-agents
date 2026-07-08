import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import type { D1Like } from '@botguild/agent-core-workers';
import { applyMigrations } from './testSupport.js';
import {
  createAuditStore,
  createRelayStore,
  createUsageStore,
  dayPeriod,
  minutePeriod,
} from './jobs.js';
import { RELAY_PER_DAY_CAP, RELAY_PER_MINUTE_CAP } from './config.js';
import {
  buildVerificationEmail,
  createEmailRoutingClient,
  handleRelaySubmission,
  handleRelayVerification,
  relayCorsHeaders,
  type OutboundEmail,
  type RelayDeps,
  type RelayMailer,
} from './relay.js';

async function freshDb(): Promise<D1Like> {
  const db = createMemoryD1();
  await applyMigrations(db);
  return db;
}

const logger = createConsoleLogger({ service: 'test', level: 'silent' });

function fakeMailer(): RelayMailer & { sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = [];
  return {
    sent,
    async send(msg) {
      sent.push(msg);
      return { messageId: `msg-${sent.length}` };
    },
  };
}

function buildDeps(db: D1Like, mailer: RelayMailer, now?: () => Date): RelayDeps {
  return {
    relay: createRelayStore(db),
    usage: createUsageStore(db),
    mailer,
    audit: createAuditStore(db),
    fromAddress: 'relay@jiffyapp.dev',
    logger,
    now,
  };
}

async function verifiedRelay(
  db: D1Like,
  toolId: string,
  recipient = 'buyer@example.com',
): Promise<string> {
  const store = createRelayStore(db);
  const { token, verifyToken } = await store.ensure(toolId, recipient);
  await store.verifyByToken(verifyToken);
  return token;
}

// --- handleRelaySubmission: gate order -----------------------------------------

test('unknown tool -> 404', async () => {
  const db = await freshDb();
  const deps = buildDeps(db, fakeMailer());
  const result = await handleRelaySubmission(deps, {
    toolId: 'no-such-tool',
    token: 'anything',
    body: { fields: { email: 'a@example.com' } },
  });
  assert.equal(result.status, 404);
});

test('missing or wrong token -> 403 (constant-time compare)', async () => {
  const db = await freshDb();
  await verifiedRelay(db, 'tool-a');
  const deps = buildDeps(db, fakeMailer());

  const missing = await handleRelaySubmission(deps, {
    toolId: 'tool-a',
    token: null,
    body: { fields: { email: 'a@example.com' } },
  });
  assert.equal(missing.status, 403);

  const wrongSameLength = await handleRelaySubmission(deps, {
    toolId: 'tool-a',
    token: '0'.repeat(64),
    body: { fields: { email: 'a@example.com' } },
  });
  assert.equal(wrongSameLength.status, 403);

  const wrongDifferentLength = await handleRelaySubmission(deps, {
    toolId: 'tool-a',
    token: 'short',
    body: { fields: { email: 'a@example.com' } },
  });
  assert.equal(wrongDifferentLength.status, 403);
});

test('unverified recipient -> 409', async () => {
  const db = await freshDb();
  const store = createRelayStore(db);
  const { token } = await store.ensure('tool-b', 'buyer@example.com'); // never verified
  const deps = buildDeps(db, fakeMailer());

  const result = await handleRelaySubmission(deps, {
    toolId: 'tool-b',
    token,
    body: { fields: { email: 'a@example.com' } },
  });
  assert.equal(result.status, 409);
});

// --- test mode ------------------------------------------------------------------

test('test mode validates like live, records a metadata-only event, and skips mailer + counters', async () => {
  const db = await freshDb();
  const token = await verifiedRelay(db, 'tool-c');
  const mailer = fakeMailer();
  const now = () => new Date('2026-07-07T12:00:00Z');
  const deps = buildDeps(db, mailer, now);

  const result = await handleRelaySubmission(deps, {
    toolId: 'tool-c',
    token,
    body: { fields: { email: 'a@example.com' }, test: true },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, test: true });
  assert.equal(mailer.sent.length, 0);

  const usage = createUsageStore(db);
  assert.equal(await usage.getUsed(`relay-min:tool-c`, minutePeriod(now())), 0);
  assert.equal(await usage.getUsed(`relay-day:tool-c`, dayPeriod(now())), 0);

  const { results } = await db
    .prepare('SELECT kind, status FROM relay_events WHERE tool_id = ?')
    .bind('tool-c')
    .all<{ kind: string; status: string }>();
  assert.equal(results.length, 1);
  assert.equal(results[0]?.kind, 'test');
  assert.equal(results[0]?.status, 'validated');
});

test('test mode still 403s on a bad token', async () => {
  const db = await freshDb();
  await verifiedRelay(db, 'tool-d');
  const deps = buildDeps(db, fakeMailer());

  const result = await handleRelaySubmission(deps, {
    toolId: 'tool-d',
    token: 'not-the-token',
    body: { fields: { email: 'a@example.com' }, test: true },
  });
  assert.equal(result.status, 403);
});

// --- body validation --------------------------------------------------------------

test('oversized body -> 400', async () => {
  const db = await freshDb();
  const token = await verifiedRelay(db, 'tool-e');
  const deps = buildDeps(db, fakeMailer());

  const result = await handleRelaySubmission(deps, {
    toolId: 'tool-e',
    token,
    body: { fields: { note: 'x'.repeat(9000) } },
  });
  assert.equal(result.status, 400);
});

test('malformed body shape -> 400', async () => {
  const db = await freshDb();
  const token = await verifiedRelay(db, 'tool-f');
  const deps = buildDeps(db, fakeMailer());

  const noFields = await handleRelaySubmission(deps, { toolId: 'tool-f', token, body: {} });
  assert.equal(noFields.status, 400);

  const fieldsIsArray = await handleRelaySubmission(deps, {
    toolId: 'tool-f',
    token,
    body: { fields: ['not', 'an', 'object'] },
  });
  assert.equal(fieldsIsArray.status, 400);

  const badValueType = await handleRelaySubmission(deps, {
    toolId: 'tool-f',
    token,
    body: { fields: { count: 5 } },
  });
  assert.equal(badValueType.status, 400);

  const notAnObject = await handleRelaySubmission(deps, {
    toolId: 'tool-f',
    token,
    body: 'not an object',
  });
  assert.equal(notAnObject.status, 400);
});

// --- happy path + metadata-only persistence ----------------------------------------

test('happy path sends exactly one email and persists metadata only', async () => {
  const db = await freshDb();
  const token = await verifiedRelay(db, 'tool-g', 'owner@example.com');
  const mailer = fakeMailer();
  const deps = buildDeps(db, mailer);

  const result = await handleRelaySubmission(deps, {
    toolId: 'tool-g',
    token,
    body: { fields: { name: 'Ada', subscribe: true }, subject: 'Hello' },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0]?.to, 'owner@example.com');
  assert.equal(mailer.sent[0]?.from, 'relay@jiffyapp.dev');
  assert.match(mailer.sent[0]?.text ?? '', /name: Ada/);
  assert.match(mailer.sent[0]?.text ?? '', /subscribe: true/);

  const { results } = await db
    .prepare('SELECT * FROM relay_events WHERE tool_id = ?')
    .bind('tool-g')
    .all<Record<string, unknown>>();
  assert.equal(results.length, 1);
  assert.deepEqual(
    Object.keys(results[0]).sort(),
    ['created_at', 'id', 'kind', 'message_id', 'status', 'tool_id'].sort(),
  );
  assert.equal(results[0]?.kind, 'submission');
  assert.equal(results[0]?.status, 'sent');
});

// --- subject handling ---------------------------------------------------------------

test('subject is truncated to 100 chars when provided, else a default naming the toolId', async () => {
  const db = await freshDb();
  const mailer = fakeMailer();
  const deps = buildDeps(db, mailer);

  const longSubject = 'S'.repeat(150);
  const tokenH = await verifiedRelay(db, 'tool-h');
  await handleRelaySubmission(deps, {
    toolId: 'tool-h',
    token: tokenH,
    body: { fields: { email: 'a@example.com' }, subject: longSubject },
  });
  assert.equal(mailer.sent[0]?.subject.length, 100);
  assert.equal(mailer.sent[0]?.subject, longSubject.slice(0, 100));

  const tokenI = await verifiedRelay(db, 'tool-i');
  await handleRelaySubmission(deps, {
    toolId: 'tool-i',
    token: tokenI,
    body: { fields: { email: 'a@example.com' } }, // no subject
  });
  assert.equal(mailer.sent[1]?.subject, 'New submission — tool-i');
});

// --- rate caps ---------------------------------------------------------------------

test('minute cap 429s on the 6th submission within the same minute', async () => {
  const db = await freshDb();
  const token = await verifiedRelay(db, 'tool-j');
  const mailer = fakeMailer();
  const now = () => new Date('2026-07-07T12:30:00Z');
  const deps = buildDeps(db, mailer, now);

  for (let i = 0; i < RELAY_PER_MINUTE_CAP; i++) {
    const result = await handleRelaySubmission(deps, {
      toolId: 'tool-j',
      token,
      body: { fields: { n: String(i) } },
    });
    assert.equal(result.status, 200, `submission ${i} should succeed`);
  }
  assert.equal(mailer.sent.length, RELAY_PER_MINUTE_CAP);

  const sixth = await handleRelaySubmission(deps, {
    toolId: 'tool-j',
    token,
    body: { fields: { n: 'six' } },
  });
  assert.equal(sixth.status, 429);
  assert.deepEqual(sixth.body, { held: true });
  assert.equal(mailer.sent.length, RELAY_PER_MINUTE_CAP); // no additional send
});

test('day cap 429 releases the minute reservation (ThumbForge pattern)', async () => {
  const db = await freshDb();
  const token = await verifiedRelay(db, 'tool-k');
  const mailer = fakeMailer();
  const fixedNow = new Date('2026-07-07T09:00:00Z');
  const deps = buildDeps(db, mailer, () => fixedNow);

  const usage = createUsageStore(db);
  const dayScope = 'relay-day:tool-k';
  const dayPer = dayPeriod(fixedNow);
  for (let i = 0; i < RELAY_PER_DAY_CAP; i++) {
    const reserved = await usage.reserve(dayScope, dayPer, RELAY_PER_DAY_CAP);
    assert.equal(reserved.reserved, true);
  }

  const result = await handleRelaySubmission(deps, {
    toolId: 'tool-k',
    token,
    body: { fields: { email: 'a@example.com' } },
  });
  assert.equal(result.status, 429);
  assert.deepEqual(result.body, { held: true });
  assert.equal(mailer.sent.length, 0);

  const minuteScope = 'relay-min:tool-k';
  const minutePer = minutePeriod(fixedNow);
  assert.equal(await usage.getUsed(minuteScope, minutePer), 0); // released back
  assert.equal(await usage.getUsed(dayScope, dayPer), RELAY_PER_DAY_CAP); // unchanged
});

// --- CORS -----------------------------------------------------------------------

test('relayCorsHeaders grants matching origins (incl. staging) and refuses others', () => {
  const suffix = 'jiffyapp.dev';

  const acme = relayCorsHeaders('https://acme.jiffyapp.dev', suffix);
  assert.equal(acme['access-control-allow-origin'], 'https://acme.jiffyapp.dev');
  assert.equal(acme.vary, 'Origin');
  assert.equal(acme['access-control-allow-methods'], 'POST, OPTIONS');
  assert.equal(acme['access-control-allow-headers'], 'content-type');
  assert.equal(acme['access-control-max-age'], '86400');

  const staging = relayCorsHeaders('https://stg-abc123.jiffyapp.dev', suffix);
  assert.equal(staging['access-control-allow-origin'], 'https://stg-abc123.jiffyapp.dev');

  assert.deepEqual(relayCorsHeaders('https://evil.com', suffix), {});
  assert.deepEqual(relayCorsHeaders(null, suffix), {});
  assert.deepEqual(relayCorsHeaders('https://sub.acme.jiffyapp.dev', suffix), {}); // extra label not allowed
});

// --- verification ------------------------------------------------------------------

test('verification flips verified and a second use 404s (single-use)', async () => {
  const db = await freshDb();
  const store = createRelayStore(db);
  const { verifyToken } = await store.ensure('tool-l', 'buyer@example.com');
  const deps = buildDeps(db, fakeMailer());

  const first = await handleRelayVerification(deps, verifyToken);
  assert.equal(first.status, 200);
  assert.match(first.html, /verified — your form can now go live/);
  const row = await store.get('tool-l');
  assert.equal(row?.verified, true);

  const second = await handleRelayVerification(deps, verifyToken);
  assert.equal(second.status, 404);
});

test('verification 404s an unrecognized token', async () => {
  const db = await freshDb();
  const deps = buildDeps(db, fakeMailer());
  const result = await handleRelayVerification(deps, 'not-a-real-token');
  assert.equal(result.status, 404);
});

test('buildVerificationEmail composes the confirmation email', () => {
  const email = buildVerificationEmail({
    recipient: 'buyer@example.com',
    from: 'relay@jiffyapp.dev',
    toolName: 'Acme Contact Form',
    verifyUrl: 'https://bot.example.com/relay/verify/abc123',
  });
  assert.equal(email.to, 'buyer@example.com');
  assert.equal(email.from, 'relay@jiffyapp.dev');
  assert.match(email.subject, /Acme Contact Form/);
  assert.match(email.text, /https:\/\/bot\.example\.com\/relay\/verify\/abc123/);
});

// --- EmailRoutingClient --------------------------------------------------------------

test('ensureDestination POSTs the address once and tolerates a 2xx', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;
  const client = createEmailRoutingClient({
    accountId: 'acct-1',
    apiToken: 'tok',
    fetchImpl,
    logger,
  });

  await client.ensureDestination('buyer@example.com');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.match(calls[0]?.url ?? '', /\/accounts\/acct-1\/email\/routing\/addresses$/);
});

test('ensureDestination tolerates an already-exists 409', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'exists' }] }), {
      status: 409,
    })) as typeof fetch;
  const client = createEmailRoutingClient({
    accountId: 'acct-1',
    apiToken: 'tok',
    fetchImpl,
    logger,
  });
  await assert.doesNotReject(() => client.ensureDestination('buyer@example.com'));
});

test('ensureDestination tolerates an already-exists CF error code in a non-409 body', async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 100, message: 'Destination address already exists.' }],
      }),
      { status: 400 },
    )) as typeof fetch;
  const client = createEmailRoutingClient({
    accountId: 'acct-1',
    apiToken: 'tok',
    fetchImpl,
    logger,
  });
  await assert.doesNotReject(() => client.ensureDestination('buyer@example.com'));
});

test('ensureDestination throws on a genuine failure', async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ success: false, errors: [{ code: 9, message: 'invalid email' }] }),
      {
        status: 400,
      },
    )) as typeof fetch;
  const client = createEmailRoutingClient({
    accountId: 'acct-1',
    apiToken: 'tok',
    fetchImpl,
    logger,
  });
  await assert.rejects(() => client.ensureDestination('not-an-email'));
});

test('isDestinationVerified parses a verified timestamp as true and null/missing as false', async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        result: [
          { email: 'buyer@example.com', verified: '2026-07-01T00:00:00Z' },
          { email: 'other@example.com', verified: null },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;
  const client = createEmailRoutingClient({
    accountId: 'acct-1',
    apiToken: 'tok',
    fetchImpl,
    logger,
  });

  assert.equal(await client.isDestinationVerified('buyer@example.com'), true);
  assert.equal(await client.isDestinationVerified('other@example.com'), false);
  assert.equal(await client.isDestinationVerified('missing@example.com'), false);
});

test('isDestinationVerified returns false — never throws — on an API error or network failure', async () => {
  const errorFetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
  const client = createEmailRoutingClient({
    accountId: 'acct-1',
    apiToken: 'tok',
    fetchImpl: errorFetch,
    logger,
  });
  assert.equal(await client.isDestinationVerified('buyer@example.com'), false);

  const throwingFetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  const client2 = createEmailRoutingClient({
    accountId: 'acct-1',
    apiToken: 'tok',
    fetchImpl: throwingFetch,
    logger,
  });
  assert.equal(await client2.isDestinationVerified('buyer@example.com'), false);
});
