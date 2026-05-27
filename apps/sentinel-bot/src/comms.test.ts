import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Messenger } from '@botguild/agent-core';
import { createComms } from './comms.js';
import type { WatchJobConfig } from './parser.js';

// Records every messenger.send call so we can assert the contract-thread copy.
function fakeMessenger() {
  const sent: { contractId: string; text: string; type: string }[] = [];
  const messenger = {
    send: (contractId: string, text: string, type: string) => {
      sent.push({ contractId, text, type });
      return Promise.resolve();
    },
  } as unknown as Messenger;
  return { messenger, sent };
}

const job = {
  contractId: 'contract-1',
  targets: ['https://a.com', 'https://b.com'],
  schedule: '0 9 * * *',
  watchType: 'change',
} as WatchJobConfig;

test('setupConfirmed reports targets, schedule, and watch type as a progress update', async () => {
  const { messenger, sent } = fakeMessenger();
  await createComms(messenger).setupConfirmed('contract-1', job);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'progress_update');
  assert.match(sent[0].text, /https:\/\/a\.com, https:\/\/b\.com/);
  assert.match(sent[0].text, /0 9 \* \* \*/);
  assert.match(sent[0].text, /change/);
  assert.match(sent[0].text, /First check running now/);
});

test('queuedAwaitingFunding tells the buyer work starts once escrow is funded', async () => {
  const { messenger, sent } = fakeMessenger();
  await createComms(messenger).queuedAwaitingFunding('contract-1', job);

  assert.match(sent[0].text, /escrow is funded/);
  assert.match(sent[0].text, /https:\/\/a\.com/);
});

test('changeDetected names the target, the diff, and the delivery action', async () => {
  const { messenger, sent } = fakeMessenger();
  await createComms(messenger).changeDetected('contract-1', 'https://a.com', 'price rose 5%');

  assert.match(sent[0].text, /https:\/\/a\.com/);
  assert.match(sent[0].text, /price rose 5%/);
  assert.match(sent[0].text, /Delivering milestone now/);
  assert.equal(sent[0].type, 'progress_update');
});

test('weeklyMilestoneReady and firstCheckComplete embed their summaries', async () => {
  const { messenger, sent } = fakeMessenger();
  const comms = createComms(messenger);
  await comms.weeklyMilestoneReady('contract-1', 'all green');
  await comms.firstCheckComplete('contract-1', job, 'baseline captured');

  assert.match(sent[0].text, /Weekly report ready: all green/);
  assert.match(sent[1].text, /First check complete\. baseline captured/);
});
