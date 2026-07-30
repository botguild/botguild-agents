import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentClient, Contract, WebhookEvent } from '@botguild/agent-core';
import { withOwnershipFilter } from './ownership.js';
import { createConsoleLogger } from './logger.js';

const silentLogger = createConsoleLogger({ service: 'test', level: 'silent' });

function stubClient(contractBotId: string | undefined): Pick<AgentClient, 'getContract'> {
  return {
    getContract: async (contractId: string) =>
      ({ id: contractId, botId: contractBotId }) as unknown as Contract,
  };
}

function event(payload: unknown): WebhookEvent {
  return { eventType: 'milestone.funded', payload };
}

test('runs the handler for a contract assigned to this bot', async () => {
  let ran = false;
  const filtered = withOwnershipFilter(
    async () => {
      ran = true;
    },
    { client: stubClient('bot_mine'), botId: 'bot_mine', logger: silentLogger },
  );

  await filtered(event({ contractId: 'c_1' }));
  assert.equal(ran, true);
});

test("drops a sibling bot's contract event without running the handler", async () => {
  let ran = false;
  const filtered = withOwnershipFilter(
    async () => {
      ran = true;
    },
    { client: stubClient('bot_sibling'), botId: 'bot_mine', logger: silentLogger },
  );

  await filtered(event({ contractId: 'c_1' }));
  assert.equal(ran, false);
});

test('drops events with no extractable contract id', async () => {
  let ran = false;
  let fetched = false;
  const client: Pick<AgentClient, 'getContract'> = {
    getContract: async () => {
      fetched = true;
      return {} as Contract;
    },
  };
  const filtered = withOwnershipFilter(
    async () => {
      ran = true;
    },
    { client, botId: 'bot_mine', logger: silentLogger },
  );

  await filtered(event({ proposalId: 'p_1' }));
  assert.equal(ran, false);
  assert.equal(fetched, false, 'must not fetch when there is nothing to check');
});

test('getContract failure propagates so the delivery 500s and is retried', async () => {
  const client: Pick<AgentClient, 'getContract'> = {
    getContract: async () => {
      throw new Error('platform 503');
    },
  };
  const filtered = withOwnershipFilter(async () => {}, {
    client,
    botId: 'bot_mine',
    logger: silentLogger,
  });

  await assert.rejects(() => filtered(event({ contractId: 'c_1' })), /platform 503/);
});

test('custom contractIdOf extractor overrides the payload.contractId default', async () => {
  let ran = false;
  const filtered = withOwnershipFilter(
    async () => {
      ran = true;
    },
    {
      client: stubClient('bot_mine'),
      botId: 'bot_mine',
      logger: silentLogger,
      contractIdOf: (e) => (e.payload as { contract?: { id?: string } }).contract?.id,
    },
  );

  await filtered(event({ contract: { id: 'c_nested' } }));
  assert.equal(ran, true);
});
