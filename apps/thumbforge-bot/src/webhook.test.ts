// Webhook-handler unit test against the shim's in-memory D1 fake (§10.5 fork):
// an OG gig ARMS the per-offer CMS route; a social-pack gig CLAIMS the render
// job and enqueues a plan message. No live APIs — the AgentClient and queue are
// fakes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { createConsoleLogger, type WebhookEvent } from '@botguild/agent-core-workers';
import type { AgentClient } from '@botguild/agent-core';
import { applyMigrations } from './dbTestSupport.js';
import { createOfferStore, createRenderJobStore, sha256Hex } from './jobs.js';
import { createWebhookHandlers } from './handlers.js';
import type { RenderMessage, RenderQueueLike } from './pipeline.js';

const logger = createConsoleLogger({ service: 'test' });

function fundedEvent(contractId: string): WebhookEvent {
  return { eventType: 'milestone.funded', payload: { contractId } };
}

function fakeClient(gigDescription: string): { client: AgentClient; messages: string[] } {
  const messages: string[] = [];
  const client = {
    getContract: async (id: string) => ({
      id,
      gigId: 'gig-1',
      milestones: [{ id: 'm1', status: 'funded' }],
    }),
    getGig: async () => ({ id: 'gig-1', title: 'ThumbForge job', description: gigDescription }),
    sendMessage: async (_contractId: string, content: string) => {
      messages.push(content);
    },
  } as unknown as AgentClient;
  return { client, messages };
}

async function harness(gigDescription: string): Promise<{
  handlers: ReturnType<typeof createWebhookHandlers>;
  sent: RenderMessage[];
  messages: string[];
  renderJobs: ReturnType<typeof createRenderJobStore>;
  offers: ReturnType<typeof createOfferStore>;
}> {
  const db = createMemoryD1();
  await applyMigrations(db);
  const renderJobs = createRenderJobStore(db);
  const offers = createOfferStore(db);
  const sent: RenderMessage[] = [];
  const queue: RenderQueueLike = {
    send: async (m) => {
      sent.push(m);
    },
  };
  const { client, messages } = fakeClient(gigDescription);
  const handlers = createWebhookHandlers({
    client,
    renderJobs,
    offers,
    queue,
    publicBaseUrl: 'https://tf.example.com',
    logger,
    randomSecret: () => 'deterministic-test-secret',
  });
  return { handlers, sent, messages, renderJobs, offers };
}

test('social-pack milestone.funded claims a render job and enqueues one plan message', async () => {
  const h = await harness(
    'Need 10 on-brand social media graphics from our brand kit for a campaign.',
  );
  await h.handlers['milestone.funded']!(fundedEvent('c1'));

  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], { kind: 'plan', contractId: 'c1', jobKey: await sha256Hex('c1') });
  const row = await h.renderJobs.get(await sha256Hex('c1'));
  assert.equal(row?.contractId, 'c1');
  assert.equal(row?.status, 'claimed');
});

test('a redelivery before planning re-enqueues (claim+fan-out are not atomic)', async () => {
  const h = await harness('Social pack of graphics, brand kit attached.');
  await h.handlers['milestone.funded']!(fundedEvent('c1'));
  await h.handlers['milestone.funded']!(fundedEvent('c1'));
  assert.equal(h.sent.length, 2, 'unstarted job re-enqueues rather than stalling');
});

test('OG milestone.funded arms the per-offer CMS route and posts the signing snippet (no queue send)', async () => {
  const h = await harness(
    'Auto-generate an OG open graph share image for every published page via webhook.',
  );
  await h.handlers['milestone.funded']!(fundedEvent('c2'));

  assert.equal(h.sent.length, 0, 'OG arms a route, it does not enqueue a render');
  const offer = await h.offers.get('c2');
  assert.equal(offer?.contractId, 'c2');
  assert.equal(offer?.secret, 'deterministic-test-secret');
  assert.ok(
    h.messages.some((m) => m.includes('/hooks/c2')),
    'the buyer is handed the signing snippet',
  );
});

test('arming is idempotent — re-funding a still-armed OG offer keeps its secret and posts nothing new', async () => {
  const h = await harness('OG share image automation on publish.');
  await h.handlers['milestone.funded']!(fundedEvent('c2'));
  await h.handlers['milestone.funded']!(fundedEvent('c2'));
  assert.equal(h.messages.length, 1, 'the snippet is posted once');
});
