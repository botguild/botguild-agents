import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeliverable } from './index.js';

describe('resolveDeliverable', () => {
  it('maps a whitelisted file to its R2 key and content type', () => {
    const token = 'a'.repeat(64);
    assert.deepEqual(resolveDeliverable(token, 'pack.zip'), {
      key: `${token}/pack.zip`,
      contentType: 'application/zip',
    });
    assert.equal(resolveDeliverable(token, 'report.json')?.contentType, 'application/json');
    assert.equal(resolveDeliverable(token, 'concept-1.png')?.contentType, 'image/png');
  });

  it('rejects a file that is not whitelisted', () => {
    assert.equal(resolveDeliverable('a'.repeat(64), 'secrets.env'), null);
    assert.equal(resolveDeliverable('a'.repeat(64), '../../etc/passwd'), null);
  });

  it('rejects a token that is not 64 hex characters', () => {
    assert.equal(resolveDeliverable('short', 'pack.zip'), null);
    assert.equal(resolveDeliverable('g'.repeat(64), 'pack.zip'), null);
  });

  it('accepts only the three concept slots', () => {
    const token = 'a'.repeat(64);
    assert.ok(resolveDeliverable(token, 'concept-3.png'));
    assert.equal(resolveDeliverable(token, 'concept-4.png'), null);
  });

  it('rejects Object.prototype-inherited property names, not just absent ones', () => {
    // DELIVERABLE_TYPES is a plain object literal used as a lookup map; a
    // bracket-access lookup returns a truthy inherited value for these names
    // instead of undefined, bypassing a falsy-check guard. None of these are
    // ever whitelisted files, so every one must resolve to null.
    const token = 'a'.repeat(64);
    const inheritedNames = [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'valueOf',
      'toLocaleString',
      'isPrototypeOf',
      'propertyIsEnumerable',
    ];
    for (const file of inheritedNames) {
      assert.equal(resolveDeliverable(token, file), null, `expected null for file=${file}`);
    }
  });
});
