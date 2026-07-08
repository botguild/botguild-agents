import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import type { AssertionOutcome } from './assertPlan.js';
import {
  JOB_WALL_CLOCK_MINUTES,
  MAX_REPAIR_ROUNDS,
  MAX_SPEND_USD,
  PSI_ACCESSIBILITY_MIN,
  PSI_PERFORMANCE_MIN,
} from './config.js';
import {
  buildDeliveryNote,
  buildEjectReadme,
  buildEjectWranglerConfig,
  buildEvidenceReport,
  ejectZipEntries,
  REQUIRED_EJECT_PATHS,
  sha256HexBytes,
  type EvidenceInputs,
} from './evidence.js';
import { extractToolId } from './brief.js';
import type { BuildCheckpoint } from './jobs.js';
import { MODERATION_MODEL, MODERATION_VENDOR } from './moderation.js';
import type { FileSet } from './types.js';
import { buildEjectZip, verifyEjectZip } from './zip.js';

const FIXED_NOW = new Date('2026-07-07T12:00:00.000Z');

function outcome(overrides: Partial<AssertionOutcome> = {}): AssertionOutcome {
  const base: AssertionOutcome = {
    goldenTitle: 'Loads the homepage',
    pass: true,
    checks: [{ description: 'title equals', pass: true, expected: 'Acme', actual: 'Acme' }],
  };
  return { ...base, ...overrides };
}

function checkpoint(overrides: Partial<BuildCheckpoint> = {}): BuildCheckpoint {
  return {
    slotValues: null,
    round: 1,
    spendUsd: 0.12,
    activeMs: 60_000,
    staged: true,
    lastFailures: [],
    ...overrides,
  };
}

function baseInputs(overrides: Partial<EvidenceInputs> = {}): EvidenceInputs {
  return {
    contractId: 'contract-1',
    gigId: 'gig-1',
    toolId: '3f2c9d84-6a1b-4e9f-8c3d-2b7a5e901234',
    slug: 'acme-widget',
    liveUrl: 'https://acme-widget.jiffyapp.dev',
    template: { id: 'landing', version: '1' },
    models: { codegen: 'workers-ai-qwen2.5-coder-32b', goldensCompiler: 'claude-haiku-4-5' },
    goldenOutcomes: [outcome({ screenshotKey: 'shot-0.png' })],
    screenshotHashes: { 'shot-0.png': 'abc123' },
    reachabilityStatus: 200,
    censusMissing: [],
    psi: { ok: true, performance: 96, accessibility: 98 },
    moderationPass: true,
    ejectZipCheck: { ok: true, errors: [] },
    checkpoint: checkpoint(),
    jobKey: 'deadbeef:build',
    buildLogUrl: 'https://jiffyapp-bot.example.workers.dev/build-log/tok',
    now: () => FIXED_NOW,
    ...overrides,
  };
}

// ---- buildEvidenceReport ------------------------------------------------------------------

test('report assembly happy path: goldens carry checks + screenshot keyed by basename', () => {
  const report = buildEvidenceReport(baseInputs());

  assert.equal(report.reportVersion, 1);
  assert.equal(report.generatedAt, FIXED_NOW.toISOString());
  assert.equal(report.contractId, 'contract-1');
  assert.equal(report.idempotencyKey, 'deadbeef:build');
  assert.deepEqual(report.goldens, [
    {
      title: 'Loads the homepage',
      pass: true,
      checks: [{ description: 'title equals', pass: true, expected: 'Acme', actual: 'Acme' }],
      screenshot: { key: 'shot-0.png', sha256: 'abc123' },
    },
  ]);
});

test('screenshot omitted when the outcome has no screenshotKey, or no hash matches it', () => {
  const noKey = buildEvidenceReport(
    baseInputs({ goldenOutcomes: [outcome({ screenshotKey: undefined })] }),
  );
  assert.equal(noKey.goldens[0].screenshot, undefined);

  const noHash = buildEvidenceReport(
    baseInputs({
      goldenOutcomes: [outcome({ screenshotKey: 'shot-9.png' })],
      screenshotHashes: {},
    }),
  );
  assert.equal(noHash.goldens[0].screenshot, undefined);
});

test('psi.pass true at 96/98 against the config thresholds (embedded in the report)', () => {
  const report = buildEvidenceReport(
    baseInputs({ psi: { ok: true, performance: 96, accessibility: 98 } }),
  );
  assert.deepEqual(report.liveGates.psi, {
    performance: 96,
    accessibility: 98,
    thresholds: { performance: PSI_PERFORMANCE_MIN, accessibility: PSI_ACCESSIBILITY_MIN },
    pass: true,
  });
});

test('psi.pass false at 89 accessibility (below threshold), thresholds still embedded', () => {
  const report = buildEvidenceReport(
    baseInputs({ psi: { ok: true, performance: 96, accessibility: 89 } }),
  );
  assert.equal(report.liveGates.psi.pass, false);
  assert.deepEqual(report.liveGates.psi.thresholds, {
    performance: PSI_PERFORMANCE_MIN,
    accessibility: PSI_ACCESSIBILITY_MIN,
  });
});

test('psi.pass false when the PSI call itself failed, even if scores happen to be present', () => {
  const report = buildEvidenceReport(
    baseInputs({ psi: { ok: false, error: 'PSI API responded 500' } }),
  );
  assert.equal(report.liveGates.psi.pass, false);
  assert.equal(report.liveGates.psi.performance, null);
  assert.equal(report.liveGates.psi.accessibility, null);
});

test('psi advisory: absent when raw is absent, lightly extracted when present', () => {
  const withoutRaw = buildEvidenceReport(baseInputs());
  assert.equal(withoutRaw.liveGates.psi.advisory, undefined);

  const withRaw = buildEvidenceReport(
    baseInputs({
      psi: {
        ok: true,
        performance: 96,
        accessibility: 98,
        raw: { categories: { bestPractices: { score: 0.92 }, seo: { score: 1 } } },
      },
    }),
  );
  assert.deepEqual(withRaw.liveGates.psi.advisory, { bestPractices: 92, seo: 100 });

  // tolerate a raw shape missing categories entirely
  const withEmptyRaw = buildEvidenceReport(
    baseInputs({ psi: { ok: true, performance: 96, accessibility: 98, raw: {} } }),
  );
  assert.equal(withEmptyRaw.liveGates.psi.advisory, undefined);
});

test('relayProof only appears when provided, with pass derived from messageId', () => {
  const withProof = buildEvidenceReport(baseInputs({ relayProof: { messageId: 'msg-1' } }));
  assert.deepEqual(withProof.liveGates.relayProof, { messageId: 'msg-1', pass: true });

  const withNullId = buildEvidenceReport(baseInputs({ relayProof: { messageId: null } }));
  assert.deepEqual(withNullId.liveGates.relayProof, { messageId: null, pass: false });

  const without = buildEvidenceReport(baseInputs());
  assert.ok(!('relayProof' in without.liveGates));
});

test('reachability 404 fails the gate', () => {
  const report = buildEvidenceReport(baseInputs({ reachabilityStatus: 404 }));
  assert.deepEqual(report.liveGates.reachability, { status: 404, pass: false });
});

test('reachability 200 passes the gate', () => {
  const report = buildEvidenceReport(baseInputs({ reachabilityStatus: 200 }));
  assert.deepEqual(report.liveGates.reachability, { status: 200, pass: true });
});

test('non-empty censusMissing fails the element-contract gate', () => {
  const report = buildEvidenceReport(baseInputs({ censusMissing: ['footer'] }));
  assert.deepEqual(report.liveGates.elementContract, { missing: ['footer'], pass: false });
});

test('empty censusMissing passes the element-contract gate', () => {
  const report = buildEvidenceReport(baseInputs({ censusMissing: [] }));
  assert.deepEqual(report.liveGates.elementContract, { missing: [], pass: true });
});

test('moderation gate reports the pinned vendor/model alongside the pass flag', () => {
  const report = buildEvidenceReport(baseInputs({ moderationPass: false }));
  assert.deepEqual(report.liveGates.moderation, {
    pass: false,
    vendor: MODERATION_VENDOR,
    model: MODERATION_MODEL,
  });
});

test('ejectZip gate passes through ok/errors from the check result', () => {
  const report = buildEvidenceReport(
    baseInputs({ ejectZipCheck: { ok: false, errors: ['missing index.mjs'] } }),
  );
  assert.deepEqual(report.liveGates.ejectZip, { pass: false, errors: ['missing index.mjs'] });
});

test('capsConsumed reflects the checkpoint round/spend plus the config caps', () => {
  const report = buildEvidenceReport(
    baseInputs({ checkpoint: checkpoint({ round: 2, spendUsd: 0.37 }) }),
  );
  assert.deepEqual(report.capsConsumed, {
    repairRounds: 2,
    roundCap: MAX_REPAIR_ROUNDS,
    spendUsd: 0.37,
    spendCapUsd: MAX_SPEND_USD,
    wallClockCapMinutes: JOB_WALL_CLOCK_MINUTES,
  });
});

// ---- sha256HexBytes ------------------------------------------------------------------------

test('sha256HexBytes matches node:crypto sha256 hex digest of the same bytes', async () => {
  const bytes = new TextEncoder().encode('hello evidence report');
  const expected = createHash('sha256').update(bytes).digest('hex');
  const actual = await sha256HexBytes(bytes);
  assert.equal(actual, expected);
});

// ---- Eject artifacts -----------------------------------------------------------------------

const VENDORED = [
  { name: 'papaparse', version: '5.5.3', license: 'MIT' },
  { name: 'chart.js', version: '4.5.1', license: 'MIT' },
];

test('README includes vendored license rows, the deploy command, and the rights-attestation line', () => {
  const readme = buildEjectReadme({
    name: 'Acme Widget',
    slug: 'acme-widget',
    templateId: 'landing',
    templateVersion: '1',
    vendored: VENDORED,
    toolUrl: 'https://acme-widget.jiffyapp.dev',
  });

  assert.ok(readme.includes('| papaparse | 5.5.3 | MIT |'));
  assert.ok(readme.includes('| chart.js | 4.5.1 | MIT |'));
  assert.ok(readme.includes('npx wrangler deploy'));
  assert.ok(readme.includes('account_id'));
  assert.ok(readme.includes('you attest that you hold the rights'));
  assert.ok(readme.toLowerCase().includes('mit'));
});

test('README with no vendored deps still renders (no dangling table)', () => {
  const readme = buildEjectReadme({
    name: 'Acme Widget',
    slug: 'acme-widget',
    templateId: 'landing',
    templateVersion: '1',
    vendored: [],
    toolUrl: 'https://acme-widget.jiffyapp.dev',
  });
  assert.ok(readme.includes('npx wrangler deploy'));
  assert.ok(!readme.includes('| undefined |'));
});

test('buildEjectWranglerConfig parses standalone after manually stripping the comment header', () => {
  const jsonc = buildEjectWranglerConfig('acme-widget');
  const withoutComments = jsonc
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const parsed = JSON.parse(withoutComments) as Record<string, unknown>;
  assert.deepEqual(parsed, {
    name: 'acme-widget',
    main: 'index.mjs',
    compatibility_date: '2026-06-01',
  });
});

test('ejectZipEntries + buildEjectZip + verifyEjectZip round-trip green, including a base64 entry', () => {
  const files: FileSet = {
    '/index.html': {
      content: '<!doctype html><html><body>hi</body></html>',
      contentType: 'text/html',
    },
    '/styles.css': { content: 'body { color: red; }', contentType: 'text/css' },
    '/assets/logo.png': {
      content: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
      contentType: 'image/png',
      encoding: 'base64',
    },
  };
  const readme = buildEjectReadme({
    name: 'Acme Widget',
    slug: 'acme-widget',
    templateId: 'landing',
    templateVersion: '1',
    vendored: VENDORED,
    toolUrl: 'https://acme-widget.jiffyapp.dev',
  });
  const wranglerJsonc = buildEjectWranglerConfig('acme-widget');
  const workerScript = 'export default { fetch() { return new Response("ok"); } };';

  const entries = ejectZipEntries({ files, workerScript, readme, wranglerJsonc });
  const zip = buildEjectZip(entries);
  const result = verifyEjectZip(zip, REQUIRED_EJECT_PATHS);
  assert.deepEqual(result, { ok: true, errors: [] });

  const unzipped = unzipSync(zip);
  assert.deepEqual(
    Array.from(unzipped['public/assets/logo.png']),
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.equal(strFromU8(unzipped['public/index.html']), files['/index.html'].content);
  assert.equal(strFromU8(unzipped['public/styles.css']), files['/styles.css'].content);
  assert.equal(strFromU8(unzipped['index.mjs']), workerScript);
  assert.equal(strFromU8(unzipped['README.md']), readme);
  assert.equal(strFromU8(unzipped['wrangler.jsonc']), wranglerJsonc);
});

test('a missing required eject path fails verifyEjectZip (e.g. no public/index.html)', () => {
  const entries = ejectZipEntries({
    files: { '/other.html': { content: '<p>x</p>', contentType: 'text/html' } },
    workerScript: 'export default { fetch() { return new Response("ok"); } };',
    readme: buildEjectReadme({
      name: 'Acme Widget',
      slug: 'acme-widget',
      templateId: 'landing',
      templateVersion: '1',
      vendored: VENDORED,
      toolUrl: 'https://acme-widget.jiffyapp.dev',
    }),
    wranglerJsonc: buildEjectWranglerConfig('acme-widget'),
  });
  const zip = buildEjectZip(entries);
  const result = verifyEjectZip(zip, REQUIRED_EJECT_PATHS);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('public/index.html')));
});

// ---- Delivery note --------------------------------------------------------------------------

test('delivery note contains the toolId linkage line, live URL, warranty exclusion sentence, and golden count', () => {
  const expectedToolId = '3f2c9d84-6a1b-4e9f-8c3d-2b7a5e901234';
  const note = buildDeliveryNote({
    name: 'Acme Widget',
    liveUrl: 'https://acme-widget.jiffyapp.dev',
    reportUrl: 'https://jiffyapp-bot.example.workers.dev/deliverables/tok/report.json',
    zipUrl: 'https://jiffyapp-bot.example.workers.dev/deliverables/tok/source.zip',
    buildLogUrl: 'https://jiffyapp-bot.example.workers.dev/build-log/tok',
    toolId: expectedToolId,
    hostingPriceUsd: 5,
    goldenCount: 4,
  });

  const linkageLine = note.split('\n').find((line) => line.trim() === `toolId: ${expectedToolId}`);
  assert.ok(linkageLine, `expected an exact 'toolId: ${expectedToolId}' line`);
  assert.equal(extractToolId(note), expectedToolId);
  assert.ok(note.startsWith('# Acme Widget is live'));
  assert.ok(note.includes('https://acme-widget.jiffyapp.dev'));
  assert.ok(note.includes('explicitly excluded'));
  assert.ok(note.includes('4 golden assertions'));
  assert.ok(note.includes('$5/mo'));
  assert.ok(note.includes('https://jiffyapp-bot.example.workers.dev/deliverables/tok/report.json'));
});
