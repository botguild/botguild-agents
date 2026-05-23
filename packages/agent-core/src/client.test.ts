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
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
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
          amount: 50,
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
    assert.equal(milestones[0]!.amount, 50);
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
    assert.equal(w.failureCount, 3, 'failure_count → failureCount');
    assert.equal(w.createdAt, '2026-05-10T00:00:00Z', 'created_at → createdAt');
    assert.equal('failure_count' in w, false, 'snake_case key removed');
    // Values (event names) must NOT be altered — only keys are camelized.
    assert.deepEqual(w.events, ['proposal.accepted']);
  } finally {
    mock.restore();
  }
});
