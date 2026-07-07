// Queue-pipeline plan-step tests (no rendering — the plan step never touches the
// render core). Focus: the FR-14 blocking moderation pass now gates the async
// gig paths (social packs / A/B thumbnails), which previously delivered with no
// moderation at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import type { AgentClient } from '@botguild/agent-core';
import { applyMigrations } from './dbTestSupport.js';
import { createAuditStore, createOutputStore, createRenderJobStore, sha256Hex } from './jobs.js';
import { processRenderMessage, type PipelineConfig, type RenderContext, type RenderMessage } from './pipeline.js';
import type { Moderator, ModerationOutcome } from './moderation.js';

const logger = createConsoleLogger({ service: 'test' });
const BRIEF = '```json\n' + JSON.stringify({ job_type: 'social_pack', social_pack: { copy: ['Buy now', 'Save big'], count: 2, formats: ['feed'] } }) + '\n```';

function fakeClient(): { client: AgentClient; messages: string[] } {
  const messages: string[] = [];
  const client = {
    getContract: async (id: string) => ({ id, gigId: 'gig-1', milestones: [{ id: 'm1', status: 'funded' }] }),
    getGig: async () => ({ id: 'gig-1', title: 'social pack', description: BRIEF }),
    sendMessage: async (_c: string, content: string) => {
      messages.push(content);
    },
  } as unknown as AgentClient;
  return { client, messages };
}

async function harness(moderator: Moderator): Promise<{
  cfg: PipelineConfig;
  sent: RenderMessage[];
  messages: string[];
  jobKey: string;
}> {
  const db = createMemoryD1();
  await applyMigrations(db);
  const renderJobs = createRenderJobStore(db);
  const jobKey = await sha256Hex('c1');
  await renderJobs.claim(jobKey, 'c1');
  const sent: RenderMessage[] = [];
  const { client, messages } = fakeClient();
  const cfg: PipelineConfig = {
    renderJobs,
    outputs: createOutputStore(db),
    audit: createAuditStore(db),
    client,
    render: {} as RenderContext, // never touched by the plan step
    storage: { put: async () => {}, getBytes: async () => null },
    probe: { probe: async () => ({ status: 200, byteLength: 1, ok: true }) },
    moderator,
    queue: { send: async (m) => void sent.push(m) },
    publicBaseUrl: 'https://tf.example.com',
    logger,
  };
  return { cfg, sent, messages, jobKey };
}

test('a flagged headline rejects the job before any render or fan-out (FR-14)', async () => {
  const flagged: Moderator = { moderate: async (): Promise<ModerationOutcome> => ({ status: 'flagged', reason: 'scam' }) };
  const { cfg, sent, messages, jobKey } = await harness(flagged);
  await processRenderMessage(cfg, { kind: 'plan', contractId: 'c1', jobKey });

  const row = await cfg.renderJobs.get(jobKey);
  assert.equal(row?.status, 'rejected');
  assert.equal(row?.plan, null, 'no plan is saved for flagged copy');
  assert.equal(sent.length, 0, 'no graphic messages are fanned out');
  assert.ok(messages.some((m) => m.includes('content-safety')), 'the buyer is told why');
});

test('moderation unavailable throws (fail closed → queue retry), never delivers unmoderated', async () => {
  const down: Moderator = { moderate: async (): Promise<ModerationOutcome> => ({ status: 'unavailable', detail: 'timeout' }) };
  const { cfg, jobKey } = await harness(down);
  await assert.rejects(() => processRenderMessage(cfg, { kind: 'plan', contractId: 'c1', jobKey }), /moderation unavailable/);
  assert.equal((await cfg.renderJobs.get(jobKey))?.plan, null);
});

test('clean copy plans the pack and fans out one graphic message per output', async () => {
  const clean: Moderator = { moderate: async (): Promise<ModerationOutcome> => ({ status: 'clean' }) };
  const { cfg, sent, jobKey } = await harness(clean);
  await processRenderMessage(cfg, { kind: 'plan', contractId: 'c1', jobKey });

  const row = await cfg.renderJobs.get(jobKey);
  assert.equal(row?.status, 'in_progress');
  assert.equal(row?.plan?.graphics.length, 2);
  assert.equal(sent.length, 2, 'both graphics fan out after moderation passes');
});
