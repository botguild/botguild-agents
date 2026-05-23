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

function installFetchMock(response: unknown): { calls: CapturedRequest[]; restore: () => void } {
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
    calls.push({ url, method: init?.method ?? 'GET', headers, body });
    return new Response(JSON.stringify(response), {
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
