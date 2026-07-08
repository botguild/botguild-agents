// Evidence report assembly + eject-ZIP artifact generators + delivery note (FR-9/FR-10,
// PRD §12). Everything here is pure/deterministic: `now`/inputs are injected, there is no
// I/O, no fetch, no crypto beyond WebCrypto's synchronous digest. The pipeline (Task 18)
// gathers the raw gate results (reachability status, element census, PSI, moderation,
// eject-zip verify, checkpoint) and hands them to `buildEvidenceReport`; it separately
// hands `ejectZipEntries`'s output to `buildEjectZip`/`verifyEjectZip` (zip.ts) before
// delivery.

import type { AssertionOutcome } from './assertPlan.js';
import {
  JOB_WALL_CLOCK_MINUTES,
  MAX_REPAIR_ROUNDS,
  MAX_SPEND_USD,
  PSI_ACCESSIBILITY_MIN,
  PSI_PERFORMANCE_MIN,
} from './config.js';
import type { BuildCheckpoint } from './jobs.js';
import { MODERATION_MODEL, MODERATION_VENDOR } from './moderation.js';
import type { PsiResult } from './psi.js';
import type { FileSet, TemplateId } from './types.js';

export interface EvidenceReport {
  reportVersion: 1;
  generatedAt: string;
  contractId: string;
  gigId: string | null;
  toolId: string;
  slug: string;
  liveUrl: string;
  template: { id: TemplateId; version: string };
  models: { codegen: string; escalation?: string; goldensCompiler: string };
  goldens: Array<{
    title: string;
    pass: boolean;
    checks: Array<{ description: string; pass: boolean; expected: string; actual: string }>;
    screenshot?: { key: string; sha256: string };
  }>;
  liveGates: {
    reachability: { status: number; pass: boolean };
    elementContract: { missing: string[]; pass: boolean };
    psi: {
      performance: number | null;
      accessibility: number | null;
      thresholds: { performance: number; accessibility: number };
      pass: boolean;
      advisory?: unknown;
    };
    moderation: { pass: boolean; vendor: string; model: string };
    relayProof?: { messageId: string | null; pass: boolean }; // form-family only
    ejectZip: { pass: boolean; errors: string[] };
  };
  capsConsumed: {
    repairRounds: number;
    roundCap: number;
    spendUsd: number;
    spendCapUsd: number;
    wallClockCapMinutes: number;
  };
  idempotencyKey: string; // jobKey (hash:stage — safe to show, not used in URLs)
  buildLogUrl: string;
}

export interface EvidenceInputs {
  contractId: string;
  gigId: string | null;
  toolId: string;
  slug: string;
  liveUrl: string;
  template: { id: TemplateId; version: string };
  models: EvidenceReport['models'];
  goldenOutcomes: AssertionOutcome[];
  screenshotHashes: Record<string, string>; // screenshotKey (basename) → sha256
  reachabilityStatus: number;
  censusMissing: string[];
  psi: PsiResult;
  moderationPass: boolean;
  relayProof?: { messageId: string | null };
  ejectZipCheck: { ok: boolean; errors: string[] };
  checkpoint: BuildCheckpoint;
  jobKey: string;
  buildLogUrl: string;
  now: () => Date;
}

/** Lightly extracts the advisory (non-gating) Lighthouse categories from PSI's raw
 *  `lighthouseResult`, when present. `runPagespeed` is only asked for PERFORMANCE +
 *  ACCESSIBILITY (psi.ts), so best-practices/seo are often simply absent — tolerated, not
 *  an error. */
function extractPsiAdvisory(raw: unknown): { bestPractices?: number; seo?: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const categories = (raw as { categories?: Record<string, { score?: number } | undefined> })
    .categories;
  if (typeof categories !== 'object' || categories === null) return undefined;

  const advisory: { bestPractices?: number; seo?: number } = {};
  const bestPractices = categories.bestPractices?.score;
  if (typeof bestPractices === 'number') advisory.bestPractices = Math.round(bestPractices * 100);
  const seo = categories.seo?.score;
  if (typeof seo === 'number') advisory.seo = Math.round(seo * 100);

  return Object.keys(advisory).length > 0 ? advisory : undefined;
}

/** Assembles the FR-9 evidence report from the raw gate results. Pure pass computations:
 *  reachability passes on exactly HTTP 200; the element contract passes when nothing is
 *  missing; PSI passes only when the API call itself succeeded AND both scores clear their
 *  (embedded) thresholds; a golden's screenshot is attached only when both a
 *  `screenshotKey` and a matching hash are present. */
export function buildEvidenceReport(args: EvidenceInputs): EvidenceReport {
  const goldens: EvidenceReport['goldens'] = args.goldenOutcomes.map((outcome) => {
    const golden: EvidenceReport['goldens'][number] = {
      title: outcome.goldenTitle,
      pass: outcome.pass,
      checks: outcome.checks,
    };
    const sha256 =
      outcome.screenshotKey !== undefined
        ? args.screenshotHashes[outcome.screenshotKey]
        : undefined;
    if (outcome.screenshotKey !== undefined && sha256 !== undefined) {
      golden.screenshot = { key: outcome.screenshotKey, sha256 };
    }
    return golden;
  });

  const performance = args.psi.performance ?? null;
  const accessibility = args.psi.accessibility ?? null;
  const psiPass =
    args.psi.ok &&
    performance !== null &&
    accessibility !== null &&
    performance >= PSI_PERFORMANCE_MIN &&
    accessibility >= PSI_ACCESSIBILITY_MIN;

  const psiGate: EvidenceReport['liveGates']['psi'] = {
    performance,
    accessibility,
    thresholds: { performance: PSI_PERFORMANCE_MIN, accessibility: PSI_ACCESSIBILITY_MIN },
    pass: psiPass,
  };
  const advisory = extractPsiAdvisory(args.psi.raw);
  if (advisory !== undefined) psiGate.advisory = advisory;

  const liveGates: EvidenceReport['liveGates'] = {
    reachability: { status: args.reachabilityStatus, pass: args.reachabilityStatus === 200 },
    elementContract: { missing: args.censusMissing, pass: args.censusMissing.length === 0 },
    psi: psiGate,
    moderation: { pass: args.moderationPass, vendor: MODERATION_VENDOR, model: MODERATION_MODEL },
    ejectZip: { pass: args.ejectZipCheck.ok, errors: args.ejectZipCheck.errors },
  };
  if (args.relayProof !== undefined) {
    liveGates.relayProof = {
      messageId: args.relayProof.messageId,
      pass: args.relayProof.messageId !== null,
    };
  }

  return {
    reportVersion: 1,
    generatedAt: args.now().toISOString(),
    contractId: args.contractId,
    gigId: args.gigId,
    toolId: args.toolId,
    slug: args.slug,
    liveUrl: args.liveUrl,
    template: args.template,
    models: args.models,
    goldens,
    liveGates,
    capsConsumed: {
      repairRounds: args.checkpoint.round,
      roundCap: MAX_REPAIR_ROUNDS,
      spendUsd: args.checkpoint.spendUsd,
      spendCapUsd: MAX_SPEND_USD,
      wallClockCapMinutes: JOB_WALL_CLOCK_MINUTES,
    },
    idempotencyKey: args.jobKey,
    buildLogUrl: args.buildLogUrl,
  };
}

/** WebCrypto SHA-256 hex of raw bytes (screenshot hashing for the evidence report). Copies
 *  into a fresh `Uint8Array` first: an incoming view's buffer is typed `ArrayBufferLike`
 *  (which admits `SharedArrayBuffer`), while `crypto.subtle.digest`'s `BufferSource` typing
 *  requires a plain `ArrayBuffer` — the copy always backs onto a fresh, non-shared one. */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Eject-ZIP artifacts (FR-9) ---------------------------------------------------------

/** Every path `verifyEjectZip` treats as required for an eject archive. */
export const REQUIRED_EJECT_PATHS = [
  'README.md',
  'wrangler.jsonc',
  'index.mjs',
  'public/index.html',
];

/** Self-host README: what this is, the file map, self-host steps, the vendored-deps
 *  license table, licensing (PRD §12), and the hosting/eject explanation. */
export function buildEjectReadme(args: {
  name: string;
  slug: string;
  templateId: TemplateId;
  templateVersion: string;
  vendored: Array<{ name: string; version: string; license: string }>;
  toolUrl: string;
}): string {
  const { name, slug, templateId, templateVersion, vendored, toolUrl } = args;

  const vendoredTable =
    vendored.length > 0
      ? [
          '| Name | Version | License |',
          '| --- | --- | --- |',
          ...vendored.map((v) => `| ${v.name} | ${v.version} | ${v.license} |`),
        ].join('\n')
      : '_No vendored third-party dependencies are used by this template._';

  return `# ${name} — self-host package

This is the complete, self-contained source for **${name}** (built from the \`${templateId}\`
template, v${templateVersion}). While your JiffyApp hosting is funded, the same tool is served
live at ${toolUrl}; this ZIP is your **permanent exit** — it runs entirely on infrastructure you
control, with no dependency on JiffyApp continuing to exist or on hosting payments continuing.

## What's in this ZIP

- \`public/\` — the static site: HTML, CSS, JS, and any vendored assets, exactly as served
- \`index.mjs\` — the Cloudflare Worker entrypoint that serves everything under \`public/\`
- \`wrangler.jsonc\` — Wrangler configuration for deploying this Worker under your own
  Cloudflare account
- \`README.md\` — this file

## Self-hosting (Cloudflare Workers)

1. (Optional) install the Wrangler CLI: \`npm i -g wrangler\`.
2. Open \`wrangler.jsonc\` and replace the \`account_id\` placeholder with your own Cloudflare
   account id (Wrangler will also prompt for one on first deploy if you'd rather not edit the
   file).
3. From this directory, deploy with the included config:

   \`\`\`
   npx wrangler deploy
   \`\`\`

   No other setup is required — \`wrangler.jsonc\` already points at \`index.mjs\` and pins the
   worker name to \`${slug}\`.

## Vendored dependencies

${vendoredTable}

Every dependency above ships as vendored, version-pinned source inside \`public/\` — nothing is
fetched from a third-party origin at runtime, and each has been license-audited at build time.

## Licensing

The template scaffold is MIT-licensed. The code generated specifically for **${name}** is
assigned to you as the buyer. By accepting delivery, you attest that you hold the rights to any
copy, images, or brand assets you supplied for this build, per the gig terms.

## Hosting vs. ejecting

JiffyApp keeps ${slug}.jiffyapp.dev live for as long as hosting stays funded. This ZIP does not
depend on that in any way — it is the permanent, no-lock-in exit, usable whether or not you ever
renew hosting.
`;
}

/** Self-host Wrangler config as JSONC — a `//` comment header (survives
 *  `verifyEjectZip`'s comment-strip) over the minimal JSON body Wrangler needs. */
export function buildEjectWranglerConfig(slug: string): string {
  const body = { name: slug, main: 'index.mjs', compatibility_date: '2026-06-01' };
  return `// Self-host config generated by JiffyApp — replace account_id\n${JSON.stringify(body, null, 2)}\n`;
}

/** Decodes a base64 `FileEntry.content` to raw bytes without `Buffer` (Workers-safe: `atob`
 *  is a global in both the Workers runtime and Node). */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Lays out the eject-ZIP entry map: `README.md`, `wrangler.jsonc`, `index.mjs` (the worker
 *  script), and one `public/<path>` entry per `FileSet` member (leading slash stripped;
 *  base64-encoded entries are decoded to raw bytes so the ZIP holds real binary content). */
export function ejectZipEntries(args: {
  files: FileSet;
  workerScript: string;
  readme: string;
  wranglerJsonc: string;
}): Record<string, Uint8Array | string> {
  const entries: Record<string, Uint8Array | string> = {
    'README.md': args.readme,
    'wrangler.jsonc': args.wranglerJsonc,
    'index.mjs': args.workerScript,
  };

  for (const [path, entry] of Object.entries(args.files)) {
    const relPath = path.startsWith('/') ? path.slice(1) : path;
    entries[`public/${relPath}`] =
      entry.encoding === 'base64' ? base64ToBytes(entry.content) : entry.content;
  }

  return entries;
}

// ---- Delivery note (FR-10) ---------------------------------------------------------------

/** Buyer-facing delivery note: live URL first, what passed, links, the warranty-scope
 *  sentence, and the hosting upsell — including the `toolId: <id>` linkage line a future
 *  hosting gig's description must carry so the sweep can match it back to this tool. */
export function buildDeliveryNote(args: {
  name: string;
  liveUrl: string;
  reportUrl: string;
  zipUrl: string;
  buildLogUrl: string;
  toolId: string;
  hostingPriceUsd: number;
  goldenCount: number;
}): string {
  const { name, liveUrl, reportUrl, zipUrl, buildLogUrl, toolId, hostingPriceUsd, goldenCount } =
    args;

  return `# ${name} is live

**Live URL:** ${liveUrl}

## What passed

${goldenCount} golden assertions passed against the live URL in a real headless-browser run,
alongside the Lighthouse performance and accessibility gates — full per-assertion results,
screenshots, and scores are in the evidence report linked below.

## Links

- Evidence report: ${reportUrl}
- Eject ZIP (full source, self-host README): ${zipUrl}
- Build log: ${buildLogUrl}

## Warranty scope

The warranty covers exactly the ${goldenCount} golden assertions accepted in this proposal and
listed in the evidence report; any functionality beyond those assertions is explicitly excluded.

## Keep it live

The first month of hosting is included with this delivery. To keep **${name}** live after that
hosting window lapses, post a $${hostingPriceUsd}/mo hosting gig whose description includes this
line, so we can match it back to the right tool:

\`\`\`
toolId: ${toolId}
\`\`\`
`;
}
