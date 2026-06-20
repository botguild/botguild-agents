import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOwnContract, gigFromContract } from './ownership.js';
import type { Contract } from './client.js';

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 'c1',
    gigId: 'g1',
    gigTitle: 'QA smoke test of example.com',
    botId: 'bot-self',
    botName: 'VerifierBot',
    botAvatar: '',
    payerId: 'payer-1',
    payerName: 'Dave',
    handlerId: 'handler-1',
    status: 'active',
    totalAmount: 0.15,
    escrowFunded: 0.15,
    warrantyHoldback: 0.015,
    milestones: [],
    events: [],
    startDate: '2026-06-06T00:00:00.000Z',
    warrantyExpires: '',
    humanCheckpoints: false,
    ...overrides,
  } as Contract;
}

test('isOwnContract: true only when botId matches', () => {
  assert.equal(isOwnContract(makeContract({ botId: 'bot-self' }), 'bot-self'), true);
  assert.equal(isOwnContract(makeContract({ botId: 'bot-other' }), 'bot-self'), false);
});

test('isOwnContract: false for empty botId on either side', () => {
  assert.equal(isOwnContract(makeContract({ botId: '' }), 'bot-self'), false);
  assert.equal(isOwnContract(makeContract({ botId: 'bot-self' }), ''), false);
});

test('gigFromContract: carries title, payer, budget and deliverables', () => {
  const contract = makeContract({
    milestones: [
      { deliverables: ['Run the checks'] },
      { deliverables: ['Deliver the report'] },
    ] as Contract['milestones'],
  });
  const gig = gigFromContract(contract);
  assert.equal(gig.id, 'g1');
  assert.equal(gig.title, 'QA smoke test of example.com');
  assert.equal(gig.payerId, 'payer-1');
  assert.equal(gig.budget, 0.15);
  assert.deepEqual(gig.deliverables, ['Run the checks', 'Deliver the report']);
  // description falls back to the joined deliverables when present
  assert.match(gig.description, /Run the checks/);
});

test('gigFromContract: parses gigAcceptanceCriteria JSON when present', () => {
  const contract = makeContract();
  (contract as { gigAcceptanceCriteria?: string }).gigAcceptanceCriteria = JSON.stringify([
    { kind: 'http', url: 'https://example.com', status: 200 },
  ]);
  const gig = gigFromContract(contract);
  assert.equal(gig.acceptanceCriteria.length, 1);
  assert.deepEqual(gig.acceptanceCriteria[0], {
    kind: 'http',
    url: 'https://example.com',
    status: 200,
  });
});

test('gigFromContract: tolerates missing or malformed criteria', () => {
  assert.deepEqual(gigFromContract(makeContract()).acceptanceCriteria, []);

  const bad = makeContract();
  (bad as { gigAcceptanceCriteria?: string }).gigAcceptanceCriteria = 'not json{';
  assert.deepEqual(gigFromContract(bad).acceptanceCriteria, []);

  const notArray = makeContract();
  (notArray as { gigAcceptanceCriteria?: string }).gigAcceptanceCriteria = '{"kind":"http"}';
  assert.deepEqual(gigFromContract(notArray).acceptanceCriteria, []);
});

test('gigFromContract: description falls back to title with no deliverables', () => {
  const gig = gigFromContract(makeContract({ milestones: [] }));
  assert.equal(gig.description, 'QA smoke test of example.com');
  assert.deepEqual(gig.deliverables, []);
});
