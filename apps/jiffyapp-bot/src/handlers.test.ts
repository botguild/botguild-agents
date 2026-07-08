// Webhook-handler unit tests against real D1-backed stores (in-memory sqlite,
// migrations applied) — only the AgentClient/AgentMcpClient/queue are fakes.
// Covers the milestone.funded claim/enqueue flow (build + known-cycle
// classification, foreign-contract filtering, redelivery idempotency) and the
// contract.status.changed dispute-evidence path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { createConsoleLogger, type WebhookEvent } from '@botguild/agent-core-workers';
import { DEFAULT_DISPUTE_RESPONSE, type AgentMcpClient } from '@botguild/agent-core';
import type { D1Like } from '@botguild/agent-core-workers';
import { applyMigrations } from './testSupport.js';
import { createGigStore } from './gigStore.js';
import { createCycleStore, createJobStore, createToolStore, jobKeyFor, sha256Hex } from './jobs.js';
import { buildHandlers, type HandlerDeps, type QueueLike } from './handlers.js';
import type { JobMessage } from './types.js';

const logger = createConsoleLogger({ service: 'test', level: 'silent' });
const BASE_URL = 'https://jiffyapp-bot.example.com';

function fundedEvent(contractId?: string): WebhookEvent {
  return { eventType: 'milestone.funded', payload: contractId ? { contractId } : {} };
}

function statusChangedEvent(contractId: string, newStatus: string): WebhookEvent {
  return { eventType: 'contract.status.changed', payload: { contractId, newStatus } };
}

interface Harness {
  handlers: ReturnType<typeof buildHandlers>;
  sent: JobMessage[];
  messages: Array<{ contractId: string; content: string }>;
  disputeCalls: Array<{ contractId: string; response: string; evidenceUrls?: string[] }>;
  jobs: ReturnType<typeof createJobStore>;
  db: D1Like;
  ownContract: { id: string; gigId: string; botId: string };
}

async function harness(
  options: { botId?: string; disputeThrows?: boolean } = {},
): Promise<Harness> {
  const db = createMemoryD1();
  await applyMigrations(db);

  const botId = 'bot-jiffyapp';
  const gigs = createGigStore(db);
  const jobs = createJobStore(db);
  const cycles = createCycleStore(db);
  const tools = createToolStore(db);

  const contracts = new Map<string, { id: string; gigId: string; botId: string }>();
  const sent: JobMessage[] = [];
  const messages: Array<{ contractId: string; content: string }> = [];
  const disputeCalls: Array<{ contractId: string; response: string; evidenceUrls?: string[] }> = [];

  const client: HandlerDeps['client'] = {
    getContract: async (contractId: string) => {
      const c = contracts.get(contractId);
      if (!c) throw new Error(`no fake contract registered for ${contractId}`);
      return c as unknown as Awaited<ReturnType<HandlerDeps['client']['getContract']>>;
    },
    getGig: async (gigId: string) =>
      ({ id: gigId, title: 't', description: 'd' }) as unknown as Awaited<
        ReturnType<HandlerDeps['client']['getGig']>
      >,
    sendMessage: async (contractId: string, content: string) => {
      messages.push({ contractId, content });
    },
    getContractReview: async () => null,
  };

  const mcp: HandlerDeps['mcp'] = {
    respondToDispute: async (input) => {
      if (options.disputeThrows) throw new Error('mcp transport down');
      disputeCalls.push({
        contractId: input.contractId,
        response: input.response,
        evidenceUrls: input.evidenceUrls,
      });
      return { responseId: 'resp_1' };
    },
  };

  const queue: QueueLike = {
    send: async (msg) => {
      sent.push(msg);
    },
  };

  const handlers = buildHandlers({
    client,
    mcp,
    gigs,
    jobs,
    cycles,
    tools,
    queue,
    botId: options.botId ?? botId,
    publicBaseUrl: BASE_URL,
    logger,
  });

  const ownContract = { id: 'c1', gigId: 'gig-1', botId };
  contracts.set('c1', ownContract);
  contracts.set('c-foreign', { id: 'c-foreign', gigId: 'gig-2', botId: 'other-bot' });

  return { handlers, sent, messages, disputeCalls, jobs, db, ownContract };
}

// --- milestone.funded --------------------------------------------------------

test('milestone.funded: own contract, unknown gig → claims a build job and enqueues it', async () => {
  const h = await harness();
  await h.handlers['milestone.funded']!(fundedEvent('c1'));

  const hash = await sha256Hex('c1');
  const jobKey = jobKeyFor(hash, 'build');
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], { kind: 'build', contractId: 'c1', jobKey });

  const row = await h.jobs.get(jobKey);
  assert.equal(row?.contractId, 'c1');
  assert.equal(row?.kind, 'build');
  assert.equal(row?.status, 'claimed');
});

test('milestone.funded: gig previously classified as a hosting cycle → claims kind cycle with toolId', async () => {
  const h = await harness();
  const gigs = createGigStore(h.db);
  await gigs.saveCycle({ gigId: 'gig-1', toolId: 'tool-abc' });

  await h.handlers['milestone.funded']!(fundedEvent('c1'));

  const hash = await sha256Hex('c1');
  const jobKey = jobKeyFor(hash, 'cycle');
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], { kind: 'cycle', contractId: 'c1', jobKey, toolId: 'tool-abc' });

  const row = await h.jobs.get(jobKey);
  assert.equal(row?.kind, 'cycle');
  assert.equal(row?.toolId, 'tool-abc');
});

test('milestone.funded: foreign contract (sibling bot) is ignored — no claim, no send', async () => {
  const h = await harness({ botId: 'bot-jiffyapp' });
  await h.handlers['milestone.funded']!(fundedEvent('c-foreign'));

  assert.equal(h.sent.length, 0);
  const hash = await sha256Hex('c-foreign');
  assert.equal(await h.jobs.get(jobKeyFor(hash, 'build')), null);
});

test('milestone.funded: missing contractId payload is a no-op that never throws', async () => {
  const h = await harness();
  await assert.doesNotReject(() => h.handlers['milestone.funded']!(fundedEvent(undefined)));
  assert.equal(h.sent.length, 0);
});

test('milestone.funded: redelivery after a checkpoint is saved does not re-send', async () => {
  const h = await harness();
  await h.handlers['milestone.funded']!(fundedEvent('c1'));
  assert.equal(h.sent.length, 1);

  const hash = await sha256Hex('c1');
  const jobKey = jobKeyFor(hash, 'build');
  await h.jobs.saveCheckpoint(jobKey, {
    slotValues: null,
    round: 1,
    spendUsd: 0.05,
    activeMs: 1000,
    staged: false,
    lastFailures: [],
  });

  await h.handlers['milestone.funded']!(fundedEvent('c1'));
  assert.equal(
    h.sent.length,
    1,
    'a checkpointed job has already reached a consumer; no second send',
  );
});

test('milestone.funded: redelivery of a bare claim (no checkpoint yet) re-sends', async () => {
  const h = await harness();
  await h.handlers['milestone.funded']!(fundedEvent('c1'));
  await h.handlers['milestone.funded']!(fundedEvent('c1'));
  assert.equal(h.sent.length, 2, 'claim+enqueue are not atomic; a bare claim re-enqueues');
});

// --- proposal.accepted --------------------------------------------------------

test('proposal.accepted: sends a thread message mentioning escrow', async () => {
  const h = await harness();
  await h.handlers['proposal.accepted']!({
    eventType: 'proposal.accepted',
    payload: { contractId: 'c1' },
  });

  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0]!.contractId, 'c1');
  assert.match(h.messages[0]!.content, /escrow/i);
});

// --- contract.status.changed (dispute evidence) ------------------------------

test('contract.status.changed → disputed with an existing job row submits evidence URLs with the deliverable token', async () => {
  const h = await harness();
  await h.handlers['milestone.funded']!(fundedEvent('c1')); // creates the build job row
  const hash = await sha256Hex('c1');
  const row = await h.jobs.get(jobKeyFor(hash, 'build'));
  assert.ok(row);

  await h.handlers['contract.status.changed']!(statusChangedEvent('c1', 'disputed'));

  assert.equal(h.disputeCalls.length, 1);
  const call = h.disputeCalls[0]!;
  assert.equal(call.contractId, 'c1');
  assert.ok(call.evidenceUrls?.some((u) => u.includes(row!.deliverableToken)));
});

test('contract.status.changed → disputed with no job row falls back to DEFAULT_DISPUTE_RESPONSE', async () => {
  const h = await harness();
  await h.handlers['contract.status.changed']!(statusChangedEvent('c-no-job', 'disputed'));

  assert.equal(h.disputeCalls.length, 1);
  assert.equal(h.disputeCalls[0]!.response, DEFAULT_DISPUTE_RESPONSE);
  assert.equal(h.disputeCalls[0]!.evidenceUrls, undefined);
});

test('contract.status.changed → non-disputed status is ignored', async () => {
  const h = await harness();
  await h.handlers['contract.status.changed']!(statusChangedEvent('c1', 'completed'));
  assert.equal(h.disputeCalls.length, 0);
});

test('contract.status.changed → respondToDispute failure resolves without throwing', async () => {
  const h = await harness({ disputeThrows: true });
  await assert.doesNotReject(() =>
    h.handlers['contract.status.changed']!(statusChangedEvent('c1', 'disputed')),
  );
});

// A type-only check that AgentMcpClient (private fields and all) is still
// assignable to the Pick view HandlerDeps.mcp expects.
function _typeCheck(real: AgentMcpClient): HandlerDeps['mcp'] {
  return real;
}
void _typeCheck;
