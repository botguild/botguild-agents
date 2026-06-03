import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNegotiationMemory } from './negotiationStore.js';

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'negotiation-store-test-'));
}

test('starts empty when no file exists', () => {
  const dataDir = freshTempDir();
  try {
    const mem = createNegotiationMemory({ dataDir });
    assert.equal(mem.hasCountered('p1'), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('markCountered persists across a reload', () => {
  const dataDir = freshTempDir();
  try {
    const a = createNegotiationMemory({ dataDir });
    a.markCountered('p1');
    a.markCountered('p2');

    // Fresh instance reads the same file — simulates a restart.
    const b = createNegotiationMemory({ dataDir });
    assert.equal(b.hasCountered('p1'), true);
    assert.equal(b.hasCountered('p2'), true);
    assert.equal(b.hasCountered('p3'), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('clear removes an id and persists the removal', () => {
  const dataDir = freshTempDir();
  try {
    const a = createNegotiationMemory({ dataDir });
    a.markCountered('p1');
    a.clear('p1');

    const b = createNegotiationMemory({ dataDir });
    assert.equal(b.hasCountered('p1'), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a corrupt file is tolerated and starts empty', () => {
  const dataDir = freshTempDir();
  try {
    writeFileSync(join(dataDir, 'negotiation.json'), '{ not valid json', 'utf-8');
    const mem = createNegotiationMemory({ dataDir });
    assert.equal(mem.hasCountered('p1'), false);
    // and is still usable
    mem.markCountered('p1');
    assert.equal(mem.hasCountered('p1'), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
