import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  esc,
  pageShell,
  footerHtml,
  cspFor,
  buildToolWorkerScript,
  validateSlots,
  type RenderContext,
  type TemplateDefinition,
} from './engine.js';

const ctx: RenderContext = {
  slug: 'acme',
  toolUrl: 'https://acme.jiffyapp.dev',
  publicBaseUrl: 'https://bot.example.com',
  relay: null,
};

test('esc escapes HTML metacharacters', () => {
  assert.equal(esc(`<a b="c">&'`), '&lt;a b=&quot;c&quot;&gt;&amp;&#39;');
});

test('pageShell wraps body with chrome and the attribution footer', () => {
  const html = pageShell({ title: 'T', body: '<main>x</main>', ctx });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /data-testid="footer"/);
  assert.match(html, /Report abuse/);
  assert.match(html, /https:\/\/bot\.example\.com\/abuse\?slug=acme/);
  assert.equal(html.includes(footerHtml(ctx)), true); // shell embeds footerHtml verbatim
});

test('cspFor allows only self by default and adds the bot origin for relay tools', () => {
  assert.equal(cspFor(ctx).includes('bot.example.com'), false);
  const relayCsp = cspFor({ ...ctx, relay: { toolId: 't', token: 'k' } });
  assert.match(relayCsp, /connect-src 'self' https:\/\/bot\.example\.com/);
  assert.match(cspFor(ctx, { frameable: true }), /frame-ancestors \*/);
  assert.match(cspFor(ctx), /frame-ancestors 'none'/);
});

test('buildToolWorkerScript produces an importable module worker that serves files + CSP', async () => {
  const script = buildToolWorkerScript(
    {
      '/index.html': { content: '<h1>hi</h1>', contentType: 'text/html; charset=utf-8' },
      '/styles.css': { content: 'body{}', contentType: 'text/css' },
    },
    "default-src 'none'",
  );
  const mod = await import(`data:text/javascript;base64,${Buffer.from(script).toString('base64')}`);
  const res: Response = await mod.default.fetch(new Request('https://acme.jiffyapp.dev/'));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>hi</h1>');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'");
  const css: Response = await mod.default.fetch(
    new Request('https://acme.jiffyapp.dev/styles.css'),
  );
  assert.equal(css.headers.get('content-security-policy'), null);
  const miss: Response = await mod.default.fetch(new Request('https://acme.jiffyapp.dev/nope'));
  assert.equal(miss.status, 404);
});

test('buildToolWorkerScript is deterministic regardless of insertion order', () => {
  const a = buildToolWorkerScript(
    { '/b': { content: '1', contentType: 't' }, '/a': { content: '2', contentType: 't' } },
    'c',
  );
  const b = buildToolWorkerScript(
    { '/a': { content: '2', contentType: 't' }, '/b': { content: '1', contentType: 't' } },
    'c',
  );
  assert.equal(a, b);
});

test('validateSlots enforces kinds and function deny-tokens', () => {
  const def = {
    slots: [
      { name: 'headline', kind: 'copy', required: true, description: '', example: 'x' },
      { name: 'compute', kind: 'function', required: true, description: '', example: '(i) => i' },
    ],
  } as unknown as TemplateDefinition;
  assert.deepEqual(
    validateSlots(def, { headline: 'Hi', compute: '(inputs) => ({ total: 1 })' }),
    [],
  );
  assert.ok(validateSlots(def, { compute: '(i) => i' }).length > 0); // missing required
  assert.ok(validateSlots(def, { headline: 'Hi', compute: '(i) => fetch("x")' }).length > 0); // deny token

  // Deny-token matching is identifier-boundary, not substring: benign identifiers that merely
  // contain a deny token as a substring must be accepted (issue: false positives on ordinary
  // codegen-model identifiers like `requiredAmount`, `evaluateTotal`, `fetching`, etc).
  assert.deepEqual(
    validateSlots(def, {
      headline: 'Hi',
      compute: '(inputs) => ({ total: inputs.requiredAmount, note: "evaluate allocation" })',
    }),
    [],
  );
  assert.deepEqual(
    validateSlots(def, {
      headline: 'Hi',
      compute:
        '(inputs) => ({ isImportant: true, geolocation: inputs.geolocation, fetching: inputs.fetching, prefetchHint: 1 })',
    }),
    [],
  );
  // `sessionStorageKeyName` contains "sessionStorage" followed by an identifier char ("K"), so
  // the lookahead boundary means it is NOT a standalone "sessionStorage" token — must pass.
  assert.deepEqual(
    validateSlots(def, {
      headline: 'Hi',
      compute: '(inputs) => ({ sessionStorageKeyName: inputs.sessionStorageKeyName })',
    }),
    [],
  );

  // Each deny token must still be rejected when used as a standalone identifier/expression.
  assert.ok(validateSlots(def, { headline: 'Hi', compute: '(i) => eval(i)' }).length > 0);
  assert.ok(validateSlots(def, { headline: 'Hi', compute: '() => location.href' }).length > 0);
  assert.ok(
    validateSlots(def, { headline: 'Hi', compute: '() => new Function("return 1")()' }).length > 0,
  );
  assert.ok(validateSlots(def, { headline: 'Hi', compute: '() => document.cookie' }).length > 0);
  assert.ok(validateSlots(def, { headline: 'Hi', compute: '() => window.open("u")' }).length > 0);
  assert.ok(validateSlots(def, { headline: 'Hi', compute: '() => require("x")' }).length > 0);
  assert.ok(validateSlots(def, { headline: 'Hi', compute: '() => import("m")' }).length > 0);
});
