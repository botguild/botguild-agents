// Catalog-wide invariants: every registered template must satisfy the same eight
// structural rules (Task 8 brief). Each test below loops over Object.values(TEMPLATES)
// so a future eleventh template is covered automatically. Task 9 EXTENDS this file
// with a ninth check: every reference golden set schema-validates via `validateGoldenSet`
// (the full §1.4 vocabulary + fixture-reference checks) — here we only assert the
// structural parts that don't require that module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATCHER_KEYWORDS } from '../brief.js';
import { TEMPLATE_IDS } from '../types.js';
import { validateSlots } from './engine.js';
import { getTemplate, renderReference, TEMPLATES } from './registry.js';

test('all ten TEMPLATE_IDS are registered, and getTemplate resolves each one', () => {
  assert.equal(Object.keys(TEMPLATES).length, TEMPLATE_IDS.length);
  for (const id of TEMPLATE_IDS) {
    assert.ok(TEMPLATES[id], `missing template registration for "${id}"`);
    assert.equal(getTemplate(id).id, id);
  }
});

test("every definition's matcherKeywords is a non-empty subset of MATCHER_KEYWORDS[id]", () => {
  for (const def of Object.values(TEMPLATES)) {
    assert.ok(def.matcherKeywords.length > 0, `${def.id}: matcherKeywords must be non-empty`);
    const allowed = new Set(MATCHER_KEYWORDS[def.id]);
    for (const keyword of def.matcherKeywords) {
      assert.ok(allowed.has(keyword), `${def.id}: keyword "${keyword}" not in MATCHER_KEYWORDS`);
    }
  }
});

test('every reference render passes its own load-time element-contract census', () => {
  for (const def of Object.values(TEMPLATES)) {
    const { html } = renderReference(def);
    for (const tid of def.elementContract(def.referenceSlots)) {
      assert.match(
        html,
        new RegExp(`data-testid="${tid}"`),
        `${def.id}: missing census testid "${tid}"`,
      );
    }
  }
});

test('every census testid is covered by bindableTestids (exact set, per FR-8)', () => {
  for (const def of Object.values(TEMPLATES)) {
    const census = def.elementContract(def.referenceSlots);
    const { exact, prefixes } = def.bindableTestids(def.referenceSlots);
    const covered = (tid: string) => exact.includes(tid) || prefixes.some((p) => tid.startsWith(p));
    for (const tid of census) {
      assert.ok(covered(tid), `${def.id}: census testid "${tid}" is not bindable`);
    }
  }
});

test('every reference golden set has 3-7 goldens with unique titles, asserting only bindable testids', () => {
  for (const def of Object.values(TEMPLATES)) {
    const goldens = def.referenceGoldens.goldens;
    assert.ok(
      goldens.length >= 3 && goldens.length <= 7,
      `${def.id}: must have 3-7 goldens, has ${goldens.length}`,
    );

    const titles = new Set<string>();
    for (const g of goldens) {
      assert.ok(g.title.trim().length > 0, `${def.id}: golden title must be non-empty`);
      assert.ok(!titles.has(g.title), `${def.id}: duplicate golden title "${g.title}"`);
      titles.add(g.title);
    }

    const { exact, prefixes } = def.bindableTestids(def.referenceSlots);
    const ok = (tid: string) => exact.includes(tid) || prefixes.some((p) => tid.startsWith(p));
    for (const g of goldens) {
      for (const e of g.expect) {
        if ('testid' in e) {
          assert.ok(
            ok(e.testid),
            `${def.id}: golden "${g.title}" asserts unbindable testid "${e.testid}"`,
          );
        }
      }
    }
  }
});

test('every reference slots set validates cleanly (validateSlots -> [])', () => {
  for (const def of Object.values(TEMPLATES)) {
    assert.deepEqual(
      validateSlots(def, def.referenceSlots),
      [],
      `${def.id}: referenceSlots must validate`,
    );
  }
});

test('every app.js-bearing template emits <script src="/app.js"> in its rendered HTML', () => {
  for (const def of Object.values(TEMPLATES)) {
    const { files, html } = renderReference(def);
    if (files['/app.js']) {
      assert.match(html, /<script src="\/app\.js">/, `${def.id}: missing app.js script tag`);
    }
  }
});

test('every rendered file set includes /index.html and /styles.css', () => {
  for (const def of Object.values(TEMPLATES)) {
    const { files } = renderReference(def);
    assert.ok(files['/index.html'], `${def.id}: missing /index.html`);
    assert.equal(files['/index.html'].contentType, 'text/html; charset=utf-8');
    assert.ok(files['/styles.css'], `${def.id}: missing /styles.css`);
    assert.equal(files['/styles.css'].contentType, 'text/css; charset=utf-8');
  }
});

test('every template has a positive priceUsd and a semver version', () => {
  for (const def of Object.values(TEMPLATES)) {
    assert.ok(def.priceUsd > 0, `${def.id}: priceUsd must be positive`);
    assert.match(def.version, /^\d+\.\d+\.\d+$/, `${def.id}: version must be semver`);
  }
});
