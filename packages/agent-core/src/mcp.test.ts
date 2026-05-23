import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { AgentMcpClient, type McpToolCaller } from './mcp.js';

const silentLogger = pino({ level: 'silent' });

interface ToolCall {
  name: string;
  args?: Record<string, unknown>;
}

function stubTransport(responder: (call: ToolCall) => unknown): {
  transport: McpToolCaller;
  calls: ToolCall[];
} {
  const calls: ToolCall[] = [];
  const transport: McpToolCaller = {
    async callTool<T>(name: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ name, args });
      return responder({ name, args }) as T;
    },
  };
  return { transport, calls };
}

test('respondToDispute calls respond_to_dispute with normalized args', async () => {
  const { transport, calls } = stubTransport(() => ({ responseId: 'resp_1' }));
  const client = new AgentMcpClient({
    apiUrl: 'https://api.botguild.test',
    apiKey: 'bg_test',
    logger: silentLogger,
    transport,
  });

  const result = await client.respondToDispute({
    contractId: 'c_1',
    response: 'Delivery evidence is in the contract events.',
    evidenceUrls: ['https://example.com/log.txt'],
    evidenceType: 'logs',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, 'respond_to_dispute');
  assert.deepEqual(calls[0]!.args, {
    contractId: 'c_1',
    response: 'Delivery evidence is in the contract events.',
    evidenceUrls: ['https://example.com/log.txt'],
    evidenceType: 'logs',
  });
  assert.equal(result.responseId, 'resp_1');
});

test('respondToDispute defaults evidenceUrls to [] and omits evidenceType when absent', async () => {
  const { transport, calls } = stubTransport(() => ({ responseId: 'resp_2' }));
  const client = new AgentMcpClient({
    apiUrl: 'https://api.botguild.test',
    apiKey: 'bg_test',
    logger: silentLogger,
    transport,
  });

  await client.respondToDispute({ contractId: 'c_2', response: 'Standing by for human review.' });

  const args = calls[0]!.args!;
  assert.deepEqual(args.evidenceUrls, []);
  assert.equal('evidenceType' in args, false);
});

test('respondToDispute propagates transport errors', async () => {
  const { transport } = stubTransport(() => {
    throw new Error('mcp 500');
  });
  const client = new AgentMcpClient({
    apiUrl: 'https://api.botguild.test',
    apiKey: 'bg_test',
    logger: silentLogger,
    transport,
  });

  await assert.rejects(
    () => client.respondToDispute({ contractId: 'c_3', response: 'x' }),
    /mcp 500/,
  );
});

test('getWarrantyStatus calls get_warranty_status with the claimId', async () => {
  const { transport, calls } = stubTransport(() => ({
    id: 'wc_1',
    contractId: 'c_1',
    status: 'open',
    type: 'bug-fix',
  }));
  const client = new AgentMcpClient({
    apiUrl: 'https://api.botguild.test',
    apiKey: 'bg_test',
    logger: silentLogger,
    transport,
  });

  const status = await client.getWarrantyStatus('wc_1');

  assert.equal(calls[0]!.name, 'get_warranty_status');
  assert.deepEqual(calls[0]!.args, { claimId: 'wc_1' });
  assert.equal(status?.status, 'open');
});

test('getWarrantyStatus returns null when claim is not found', async () => {
  const { transport } = stubTransport(() => null);
  const client = new AgentMcpClient({
    apiUrl: 'https://api.botguild.test',
    apiKey: 'bg_test',
    logger: silentLogger,
    transport,
  });

  const status = await client.getWarrantyStatus('missing');
  assert.equal(status, null);
});
