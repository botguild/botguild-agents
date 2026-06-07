import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { AgentClient } from './client.js';

const silentLogger = pino({ level: 'silent' });

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function installFetchMock(responder: unknown | ((req: CapturedRequest) => unknown)): {
  calls: CapturedRequest[];
  restore: () => void;
} {
  const calls: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    const body =
      init?.body instanceof FormData
        ? init.body
        : init?.body
          ? JSON.parse(init.body as string)
          : undefined;
    const req: CapturedRequest = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(req);
    const responseBody = typeof responder === 'function' ? responder(req) : responder;
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test('submitProposal POSTs to /proposals with gigId and botId in body', async () => {
  const mock = installFetchMock({ proposal: { id: 'prop_123' } });

  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_42',
      logger: silentLogger,
    });

    const result = await client.submitProposal('gig_999', {
      price: 200,
      timeline: '4 weeks',
      milestones: [
        {
          title: 'Week 1',
          duration: '1 week',
          deliverables: ['First report'],
        },
      ],
      warrantyOffer: '30-day fix',
      assumptions: ['Buyer provides API keys'],
    });

    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0]!;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, 'https://api.botguild.test/proposals');
    assert.equal(call.headers['X-API-Key'], 'bg_test');

    const body = call.body as Record<string, unknown>;
    assert.equal(body.gigId, 'gig_999');
    assert.equal(body.botId, 'bot_42');
    assert.equal(body.price, 200);
    assert.equal(body.timeline, '4 weeks');
    assert.deepEqual(body.assumptions, ['Buyer provides API keys']);
    assert.equal(body.warrantyOffer, '30-day fix');

    const milestones = body.milestones as Array<Record<string, unknown>>;
    assert.equal(milestones.length, 1);
    assert.equal(milestones[0]!.title, 'Week 1');
    assert.equal(milestones[0]!.duration, '1 week');
    assert.deepEqual(milestones[0]!.deliverables, ['First report']);

    assert.equal(result.proposalId, 'prop_123');
  } finally {
    mock.restore();
  }
});

test('sendMessage resolves thread by contract scope then POSTs to /threads/:id/messages', async () => {
  const mock = installFetchMock((req: CapturedRequest) => {
    if (req.method === 'GET' && req.url.includes('/threads?')) {
      return { threads: [{ id: 'thr_abc' }] };
    }
    return { message: { id: 'msg_xyz' } };
  });

  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_42',
      logger: silentLogger,
    });

    await client.sendMessage('contract_99', 'Hello payer', 'progress_update');

    assert.equal(mock.calls.length, 2);

    const lookupCall = mock.calls[0]!;
    assert.equal(lookupCall.method, 'GET');
    assert.match(lookupCall.url, /\/threads\?/);
    assert.match(lookupCall.url, /scope=contract/);
    assert.match(lookupCall.url, /scopeId=contract_99/);

    const sendCall = mock.calls[1]!;
    assert.equal(sendCall.method, 'POST');
    assert.equal(sendCall.url, 'https://api.botguild.test/threads/thr_abc/messages');
    const body = sendCall.body as Record<string, unknown>;
    assert.equal(body.content, 'Hello payer');
    assert.equal(body.contentType, 'progress_update');
    assert.equal(body.botId, 'bot_42');
  } finally {
    mock.restore();
  }
});

test('sendMessage caches threadId across calls to the same contract', async () => {
  const mock = installFetchMock((req: CapturedRequest) => {
    if (req.method === 'GET' && req.url.includes('/threads?')) {
      return { threads: [{ id: 'thr_1' }] };
    }
    return { message: { id: 'msg' } };
  });

  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });

    await client.sendMessage('c_1', 'first');
    await client.sendMessage('c_1', 'second');

    const lookups = mock.calls.filter((c) => c.method === 'GET');
    const sends = mock.calls.filter((c) => c.method === 'POST');
    assert.equal(lookups.length, 1, 'thread lookup should be cached');
    assert.equal(sends.length, 2);
  } finally {
    mock.restore();
  }
});

test('sendMessage defaults contentType to "text" not "text/plain"', async () => {
  const mock = installFetchMock((req: CapturedRequest) => {
    if (req.method === 'GET') return { threads: [{ id: 'thr_1' }] };
    return { message: { id: 'msg' } };
  });

  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });

    await client.sendMessage('c_1', 'hello');

    const send = mock.calls.find((c) => c.method === 'POST')!;
    const body = send.body as Record<string, unknown>;
    assert.equal(body.contentType, 'text');
  } finally {
    mock.restore();
  }
});

test('sendMessage on a contract with no thread logs and returns without posting', async () => {
  const mock = installFetchMock((req: CapturedRequest) => {
    if (req.method === 'GET') return { threads: [] };
    return { message: { id: 'msg' } };
  });

  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });

    await client.sendMessage('c_missing', 'hello');

    const sends = mock.calls.filter((c) => c.method === 'POST');
    assert.equal(sends.length, 0);
  } finally {
    mock.restore();
  }
});

test('submitProposal does not send a coverNote field', async () => {
  const mock = installFetchMock({ proposal: { id: 'prop_abc' } });

  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });

    await client.submitProposal('gig_1', {
      price: 100,
      timeline: '1 week',
      milestones: [],
    });

    const body = mock.calls[0]!.body as Record<string, unknown>;
    assert.equal('coverNote' in body, false);
  } finally {
    mock.restore();
  }
});

test('getGig unwraps the { gig } envelope', async () => {
  const mock = installFetchMock({ gig: { id: 'gig_42', title: 'Watch my site' } });
  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });
    const gig = await client.getGig('gig_42');
    assert.equal(mock.calls[0]!.url, 'https://api.botguild.test/gigs/gig_42');
    assert.equal(gig.id, 'gig_42');
    assert.equal(gig.title, 'Watch my site');
  } finally {
    mock.restore();
  }
});

test('getContract unwraps the { contract } envelope', async () => {
  const mock = installFetchMock({
    contract: { id: 'c_99', milestones: [{ id: 'm1' }, { id: 'm2' }] },
  });
  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });
    const contract = await client.getContract('c_99');
    assert.equal(mock.calls[0]!.url, 'https://api.botguild.test/contracts/c_99');
    assert.equal(contract.id, 'c_99');
    assert.equal(contract.milestones.length, 2);
  } finally {
    mock.restore();
  }
});

test('listGigs coerces stringified-JSON array fields into real arrays', async () => {
  // The gigs endpoint returns acceptanceCriteria/deliverables/tags as
  // stringified JSON; consumers (scorer, parsers) expect real arrays.
  const mock = installFetchMock({
    gigs: [
      {
        id: 'gig_1',
        title: 'Watch',
        acceptanceCriteria: '["7 daily alerts","dedup repeats"]',
        deliverables: '["report"]',
        tags: '["monitoring"]',
      },
    ],
  });
  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });
    const gigs = await client.listGigs({ status: 'open' });
    const g = gigs[0]!;
    // SDK 0.3.0: acceptanceCriteria is AcceptanceCriterion[]. Plain-string rows
    // (back-compat) normalize to `text` criteria.
    assert.deepEqual(g.acceptanceCriteria, [
      { kind: 'text', text: '7 daily alerts' },
      { kind: 'text', text: 'dedup repeats' },
    ]);
    assert.deepEqual(g.deliverables, ['report']);
    assert.deepEqual(g.tags, ['monitoring']);
    // The parsed arrays must support array ops (this is what crashed in prod).
    assert.equal(
      g.acceptanceCriteria.map((c) => (c.kind === 'text' ? c.text : '')).join('; '),
      '7 daily alerts; dedup repeats',
    );
  } finally {
    mock.restore();
  }
});

test('listGigs passes structured acceptance criteria through unchanged', async () => {
  const mock = installFetchMock({
    gigs: [
      {
        id: 'gig_3',
        title: 'Verify',
        acceptanceCriteria: [
          { kind: 'text', text: 'returns 200' },
          { kind: 'metric', label: 'p95 latency', op: 'lte', value: 200, unit: 'ms' },
        ],
      },
    ],
  });
  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });
    const g = (await client.listGigs({ status: 'open' }))[0]!;
    assert.deepEqual(g.acceptanceCriteria, [
      { kind: 'text', text: 'returns 200' },
      { kind: 'metric', label: 'p95 latency', op: 'lte', value: 200, unit: 'ms' },
    ]);
  } finally {
    mock.restore();
  }
});

test('getGig coerces missing/array fields to [] (never a non-array)', async () => {
  const mock = installFetchMock({
    gig: {
      id: 'gig_2',
      title: 'X',
      acceptanceCriteria: undefined,
      deliverables: ['already-array'],
    },
  });
  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });
    const gig = await client.getGig('gig_2');
    assert.deepEqual(gig.acceptanceCriteria, [], 'undefined → []');
    assert.deepEqual(gig.deliverables, ['already-array'], 'array passes through');
    assert.equal(typeof gig.acceptanceCriteria.join, 'function', 'always a real array');
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// deliverMilestone — platform contract is { summary, evidence[] } (#238).
// ---------------------------------------------------------------------------

function uploadsResponder(req: CapturedRequest): unknown {
  if (req.url.endsWith('/uploads')) {
    const file = (req.body as FormData).get('file') as File;
    return { key: `h/${file.name}`, url: `/files/h/${file.name}`, size: file.size, type: file.type };
  }
  return {};
}

test('deliverMilestone uploads the note and POSTs { summary, evidence }', async () => {
  const mock = installFetchMock(uploadsResponder);
  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });

    await client.deliverMilestone('c_1', 'm_1', { note: 'All checks passed.' });

    assert.equal(mock.calls.length, 2);
    const upload = mock.calls[0]!;
    assert.equal(upload.method, 'POST');
    assert.equal(upload.url, 'https://api.botguild.test/uploads');
    assert.equal(
      'Content-Type' in upload.headers,
      false,
      'multipart boundary must be set by fetch, not forced to application/json',
    );
    const file = (upload.body as FormData).get('file') as File;
    assert.equal(file.name, 'delivery-m_1.md');
    assert.equal(file.type, 'text/markdown');
    assert.equal(await file.text(), 'All checks passed.');

    const deliver = mock.calls[1]!;
    assert.equal(deliver.url, 'https://api.botguild.test/contracts/c_1/milestones/m_1/deliver');
    const body = deliver.body as { summary: string; evidence: unknown[]; note?: string };
    assert.equal(body.summary, 'All checks passed.');
    assert.equal('note' in body, false, 'legacy note field must not be sent');
    assert.deepEqual(body.evidence, [
      { type: 'file', url: '/files/h/delivery-m_1.md', name: 'Delivery note' },
    ]);
  } finally {
    mock.restore();
  }
});

test('deliverMilestone uploads data: attachments as files and passes http(s) as links', async () => {
  const mock = installFetchMock(uploadsResponder);
  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });

    const png = Buffer.from('fake-png-bytes');
    await client.deliverMilestone('c_1', 'm_2', {
      note: 'Report attached.',
      attachments: [
        `data:image/png;base64,${png.toString('base64')}`,
        'https://example.com/report',
        'not-a-url', // skipped with a warn, never blocks delivery
      ],
    });

    const uploads = mock.calls.filter((c) => c.url.endsWith('/uploads'));
    assert.equal(uploads.length, 2, 'note + one data: attachment');
    const attachmentFile = (uploads[1]!.body as FormData).get('file') as File;
    assert.equal(attachmentFile.name, 'attachment-1.png');
    assert.equal(attachmentFile.type, 'image/png');
    assert.deepEqual(Buffer.from(await attachmentFile.arrayBuffer()), png);

    const deliver = mock.calls.at(-1)!;
    const body = deliver.body as { evidence: Array<Record<string, unknown>> };
    assert.deepEqual(body.evidence, [
      { type: 'file', url: '/files/h/delivery-m_2.md', name: 'Delivery note' },
      { type: 'file', url: '/files/h/attachment-1.png', name: 'Attachment 1' },
      { type: 'link', url: 'https://example.com/report' },
    ]);
  } finally {
    mock.restore();
  }
});

test('deliverMilestone uploads CSV data: attachments as text/plain (allowed type)', async () => {
  const mock = installFetchMock(uploadsResponder);
  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });

    const csv = Buffer.from('a,b\n1,2');
    await client.deliverMilestone('c_1', 'm_3', {
      note: 'Output attached.',
      attachments: [`data:text/csv;base64,${csv.toString('base64')}`],
    });

    const uploads = mock.calls.filter((c) => c.url.endsWith('/uploads'));
    const attachmentFile = (uploads[1]!.body as FormData).get('file') as File;
    assert.equal(attachmentFile.name, 'attachment-1.csv');
    assert.equal(attachmentFile.type, 'text/plain', 'POST /uploads does not allow text/csv');
  } finally {
    mock.restore();
  }
});

test('deliverMilestone truncates long notes in the summary, full note stays in the upload', async () => {
  const mock = installFetchMock(uploadsResponder);
  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });

    const note = 'x'.repeat(1200);
    await client.deliverMilestone('c_1', 'm_4', { note });

    const file = (mock.calls[0]!.body as FormData).get('file') as File;
    assert.equal((await file.text()).length, 1200, 'uploaded note is not truncated');

    const body = mock.calls.at(-1)!.body as { summary: string };
    assert.equal(body.summary.length, 501);
    assert.ok(body.summary.endsWith('…'));
  } finally {
    mock.restore();
  }
});

test('responses are normalized snake_case → camelCase (incl. nested + arrays)', async () => {
  // The platform returns snake_case; our types are camelCase. Without
  // normalization these fields would be undefined at runtime.
  const mock = installFetchMock({
    webhooks: [
      {
        id: 'wh_1',
        url: 'https://x/webhook',
        events: ['proposal.accepted'],
        failure_count: 3,
        created_at: '2026-05-10T00:00:00Z',
        // nested object with snake_case keys — must be camelized recursively
        last_delivery: { status_code: 200, sent_at: '2026-05-11T00:00:00Z' },
      },
    ],
  });
  try {
    const client = new AgentClient({
      apiUrl: 'https://api.botguild.test',
      apiKey: 'bg_test',
      botId: 'bot_1',
      logger: silentLogger,
    });
    const webhooks = (await client.listWebhooks()) as unknown as Array<Record<string, unknown>>;
    const w = webhooks[0]!;
    // top-level key (array element)
    assert.equal(w.failureCount, 3, 'failure_count → failureCount');
    assert.equal(w.createdAt, '2026-05-10T00:00:00Z', 'created_at → createdAt');
    assert.equal('failure_count' in w, false, 'snake_case key removed');
    // nested object keys camelized recursively
    const nested = w.lastDelivery as Record<string, unknown>;
    assert.equal(nested.statusCode, 200, 'nested status_code → statusCode');
    assert.equal(nested.sentAt, '2026-05-11T00:00:00Z', 'nested sent_at → sentAt');
    // Values (event names) must NOT be altered — only keys are camelized.
    assert.deepEqual(w.events, ['proposal.accepted']);
  } finally {
    mock.restore();
  }
});
