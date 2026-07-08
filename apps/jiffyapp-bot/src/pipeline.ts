// Build pipeline — the queue consumer's brain (Tasks 17/18: the full FR-4→FR-10 path).
//
// `processJobMessage` dispatches a `build` `JobMessage` through the full codegen → stage →
// assert → repair loop to GREEN STAGING, then `promoteAndDeliver` (stages 7-9: promote → live
// gates → package → deliver) or `abortJob` (the non-convergence leg). `cycle` jobs are handled
// by `hosting.processCycleJob` instead — the queue consumer (index.ts) routes them there
// directly rather than through this file, to avoid a runtime import cycle between pipeline.ts
// and hosting.ts (hosting.ts only needs `PipelineConfig`'s *type*, which is erased at compile
// time either way, but keeping the dependency one-directional keeps the layering honest).
// `edit` jobs are logged and skipped until Task 22 wires them (its typed stub `processEditJob`
// is exported for that task to replace).
//
// The build job is CHECKPOINTED and CAPPED: every stage transition appends to the public
// build log and records a gate-audit row, and every controlled exit (park, re-enqueue
// continuation, abort) first folds this invocation's ACTIVE time into `checkpoint.activeMs`
// and saves the checkpoint. Parked/waiting time (a buyer verifying their email the next day, a
// moderation-vendor or PSI outage) is FREE — only in-invocation active time counts toward the
// FR-6 25-minute wall-clock cap. A THROWN error (a deploy failure, a live-gate failure) is
// deliberately NOT a controlled exit: it propagates so the queue retries the whole message,
// and no active time is banked for the aborted attempt. Two resume mechanisms keep those
// retries cheap: a `bankedRound` records slots + spend persisted BEFORE render/deploy so a
// retry never re-generates the same round, and a `staged` short-circuit re-enters directly at
// promote once green staging was reached, skipping moderation + the whole repair loop.

import type { Logger } from 'pino';
import { gigFromContract, type AgentClient, type Contract, type Gig } from '@botguild/agent-core';
import {
  ASSERTION_TIMEOUT_MS,
  CODEGEN_MODEL_ID,
  CONSUMER_SOFT_BUDGET_MS,
  HAIKU_MODEL_ID,
  HOSTING_PRICE_USD,
  HOSTING_WINDOW_DAYS,
  JOB_WALL_CLOCK_MINUTES,
  MAX_REPAIR_ROUNDS,
  MAX_SPEND_USD,
  MODERATION_ATTEMPTS_BEFORE_NOTICE,
  PSI_ACCESSIBILITY_MIN,
  PSI_PERFORMANCE_MIN,
} from './config.js';
import {
  censusMissing,
  runGoldens,
  type AssertionOutcome,
  type PageDriver,
  type ScreenshotStore,
} from './assertPlan.js';
import {
  buildDeliveryNote,
  buildEjectReadme,
  buildEjectWranglerConfig,
  buildEvidenceReport,
  ejectZipEntries,
  REQUIRED_EJECT_PATHS,
  sha256HexBytes,
} from './evidence.js';
import { buildEjectZip, verifyEjectZip } from './zip.js';
import { CHARTJS_VERSION } from './templates/vendor/chartjs.js';
import { PAPAPARSE_VERSION } from './templates/vendor/papaparse.js';
import type { Codegen } from './codegen.js';
import type { ToolDeployer } from './deploy.js';
import type { ModerationClient } from './moderation.js';
import type { PsiResult } from './psi.js';
import { proposalBindable, type GoldenCompiler } from './goldenCompiler.js';
import { formatBriefErrors } from './brief.js';
import { classifyGig } from './proposer.js';
import { candidateSlugs, slugPolicyErrors, stagingSlug } from './slug.js';
import { getTemplate } from './templates/registry.js';
import {
  buildToolWorkerScript,
  cspFor,
  SlotError,
  type RenderContext,
  type TemplateDefinition,
} from './templates/engine.js';
import type { GigStore } from './gigStore.js';
import type {
  AuditStore,
  BuildCheckpoint,
  BuildLogStore,
  CycleStore,
  EditRequestRow,
  EditRequestStore,
  JobRow,
  JobStore,
  RelayStore,
  ToolRow,
  ToolStore,
  UsageStore,
} from './jobs.js';
import type {
  FileSet,
  GoldenSet,
  JiffyBrief,
  JobMessage,
  SlotValues,
  TemplateId,
} from './types.js';

// --- Config seams ------------------------------------------------------------

/** Task 19 supplies the real Cloudflare Email Sending mailer; the type lives here. */
export interface RelayMailer {
  send(msg: {
    to: string;
    from: string;
    subject: string;
    text: string;
  }): Promise<{ messageId: string | null }>;
}

/** Cloudflare Email Routing destination-address verification (Task 19 implements it). */
export interface EmailRoutingClient {
  ensureDestination(email: string): Promise<void>;
  isDestinationVerified(email: string): Promise<boolean>;
}

export interface QueueLike {
  send(msg: JobMessage): Promise<unknown>;
}

export interface DeliverableStore {
  put(key: string, value: string | Uint8Array, contentType: string): Promise<void>;
}

/** The pipeline only ever touches these four methods on the platform client; a Pick keeps test
 *  fakes (plain objects) assignable without the class's private fields. */
export type PipelineClient = Pick<
  AgentClient,
  'getContract' | 'getGig' | 'sendMessage' | 'deliverMilestone'
>;

export interface PipelineConfig {
  jobs: JobStore;
  tools: ToolStore;
  gigs: GigStore;
  cycles: CycleStore;
  usage: UsageStore;
  edits: EditRequestStore;
  relay: RelayStore;
  buildLog: BuildLogStore;
  audit: AuditStore;
  client: PipelineClient;
  codegen: Codegen;
  deployer: ToolDeployer;
  compiler: GoldenCompiler;
  emailRouting: EmailRoutingClient;
  openPage: () => Promise<PageDriver>;
  closeBrowser: () => Promise<void>;
  psi: { run(url: string): Promise<PsiResult> };
  moderation: ModerationClient;
  mailer: RelayMailer;
  deliverables: DeliverableStore;
  queue: QueueLike;
  /** ALL ad-hoc HTTP (live reachability, image re-hosting) — never the global fetch. */
  fetchImpl: typeof fetch;
  publicBaseUrl: string;
  toolHostSuffix: string;
  /** From address for the bot-side relay verification email (env.RELAY_FROM_ADDRESS). */
  relayFromAddress: string;
  logger: Logger;
  now?: () => Date;
  /** Injectable backoff for the live-reachability propagation retry; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

// --- Constants + copy --------------------------------------------------------

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;
const CAP_MS = JOB_WALL_CLOCK_MINUTES * 60_000;
/** Cross-zone propagation can lag the promote by a beat; retry the live reachability probe once. */
const REACHABILITY_RETRY_MS = 3_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The vendored, version-pinned third-party deps a template actually SHIPS (README license
 *  table + eject ZIP). Only csv-dashboard ships any; everything else is dependency-free. */
function vendoredDepsFor(
  templateId: TemplateId,
): Array<{ name: string; version: string; license: string }> {
  if (templateId === 'csv-dashboard') {
    return [
      { name: 'PapaParse', version: PAPAPARSE_VERSION, license: 'MIT' },
      { name: 'Chart.js', version: CHARTJS_VERSION, license: 'MIT' },
    ];
  }
  return [];
}

/** True for the form-family templates that carry a real submission relay (FR-8). */
function isRelayTemplate(def: TemplateDefinition, brief: JiffyBrief): boolean {
  return (
    def.id === 'form' || def.id === 'waitlist' || (def.id === 'quiz' && brief.relayResult === true)
  );
}

const MODERATION_OUTAGE_NOTICE =
  'Heads up: our automated content-safety check is briefly unavailable, so we paused your ' +
  'build. No action needed — we retry automatically and your build resumes as soon as the ' +
  'check is back.';

const BRIEF_FLAGGED_MESSAGE =
  "Our automated content-safety review flagged this gig's brief, so we can't build it as " +
  'written. If you believe this is a mistake, please cancel this contract — a human operator ' +
  'reviews flagged content.';

function relayConfirmMessage(email: string, name: string): string {
  return (
    `Almost ready for "${name}". To start receiving submissions we need to confirm delivery ` +
    `to ${email}. You'll get TWO emails there: one from Cloudflare Email Routing (which makes ` +
    `delivery possible at all) and one from JiffyApp. Confirm BOTH, and your build resumes ` +
    `automatically — no need to reply here.`
  );
}

// --- Image re-hosting (exported for tests) -----------------------------------

/** Base64-encode raw bytes without Buffer (btoa is global in Node and Workers). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Fetch an http(s) image URL and return it as a `data:` URL, HTTPS-only, ≤2 MB, content-type
 * `image/*`, with a 10 s timeout. Every failure mode is a soft `{ ok: false, reason }` — the
 * caller drops the image slot rather than failing the build over an unreachable asset.
 */
export async function fetchImageAsset(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ ok: true; dataUrl: string } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not https' };

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, reason: `fetch failed: ${(err as Error).message}` };
  }
  if (!res.ok) return { ok: false, reason: `status ${res.status}` };

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/'))
    return { ok: false, reason: `not an image (${contentType})` };

  const declaredLength = res.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_IMAGE_BYTES) {
    return { ok: false, reason: 'declared size exceeds 2MB' };
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: 'size exceeds 2MB' };

  const mime = contentType.split(';')[0].trim();
  return { ok: true, dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}` };
}

// --- Stubs (Task 18 implements) ----------------------------------------------

/**
 * Stages 7-9: promote the green-staging build to its live slug, run the live gates, package the
 * eject ZIP + evidence report, and deliver.
 *
 * Time accounting mirrors Task 17's pattern but is self-contained: `checkpoint.activeMs` was
 * already banked by the caller right before hand-off, so we take it as our baseline and fold in
 * only THIS function's own active time — the single controlled exit (a PSI outage park) persists
 * it. Every other failure path THROWS (transient): the queue retries the whole message and the
 * `checkpoint.staged` short-circuit in `runBuildJob` re-enters here cheaply without regenerating.
 *
 * That retry re-runs stage (d) and stage 9 from scratch, so both real-world side effects there are
 * made idempotent: the relay test send is skipped (and its prior messageId reused) if a `'test'`
 * relay event was already recorded, and a `deliverMilestone` throw is followed by a contract
 * re-fetch — if the platform already accepted a prior attempt (milestone now delivered/accepted),
 * we continue to the tail steps instead of dead-lettering an already-delivered job.
 */
export async function promoteAndDeliver(
  cfg: PipelineConfig,
  args: {
    job: JobRow;
    tool: ToolRow;
    def: TemplateDefinition;
    brief: JiffyBrief;
    goldens: GoldenSet;
    slots: SlotValues;
    script: string;
    contract: Contract;
    checkpoint: BuildCheckpoint;
  },
): Promise<void> {
  const { job, tool, def, brief, goldens, slots, script, contract, checkpoint } = args;
  const now = cfg.now ?? ((): Date => new Date());
  const sleep = cfg.sleep ?? defaultSleep;
  const scope = job.contractId;
  const token = job.deliverableToken;
  const liveUrl = `https://${tool.slug}.${cfg.toolHostSuffix}`;
  const reportUrl = `${cfg.publicBaseUrl}/deliverables/${token}/report.json`;
  const zipUrl = `${cfg.publicBaseUrl}/deliverables/${token}/source.zip`;
  const buildLogUrl = `${cfg.publicBaseUrl}/p/${token}`;

  // Self-contained active-time banking for the one controlled exit (PSI outage park).
  const baseActiveMs = checkpoint.activeMs;
  const startMs = now().getTime();
  const persist = async (): Promise<void> => {
    checkpoint.activeMs = baseActiveMs + (now().getTime() - startMs);
    await cfg.jobs.saveCheckpoint(job.jobKey, checkpoint);
  };

  // Re-render the deployed FileSet deterministically from the banked slots (the eject ZIP ships
  // these files; the worker script itself is carried in from the green-staging attempt).
  const relay = isRelayTemplate(def, brief) ? await cfg.relay.get(tool.toolId) : null;
  const ctx: RenderContext = {
    slug: tool.slug,
    toolUrl: liveUrl,
    publicBaseUrl: cfg.publicBaseUrl,
    relay: relay ? { toolId: tool.toolId, token: relay.token } : null,
  };
  const files = def.render(slots, ctx);

  // ---- Stage 7: promote ------------------------------------------------------
  await cfg.deployer.putScript(tool.slug, script);
  const hostedUntil = new Date(now().getTime() + HOSTING_WINDOW_DAYS * 86_400_000).toISOString();
  // Promote FIRST — the dispatcher only routes public traffic to a serving (live) row.
  await cfg.tools.promote(tool.toolId, { slots, hostedUntil });

  let reach = await cfg.fetchImpl(liveUrl);
  if (reach.status !== 200) {
    await sleep(REACHABILITY_RETRY_MS);
    reach = await cfg.fetchImpl(liveUrl);
  }
  if (reach.status !== 200) {
    await cfg.audit.record({
      scope,
      gate: 'reachability',
      result: 'unreachable',
      detail: { status: reach.status },
    });
    throw new Error(`live reachability: ${liveUrl} returned ${reach.status}`);
  }
  const reachabilityStatus = reach.status;

  // Staging cleanup is best-effort: an already-gone script is fine, and any other teardown error
  // must NOT fail an otherwise-delivered job (the slug stays reserved either way).
  try {
    await cfg.deployer.deleteScript(stagingSlug(token));
  } catch (err) {
    cfg.logger.warn({ err, token }, 'promote: staging teardown failed; continuing');
  }
  await cfg.buildLog.append(token, 'promote', `promoted ${tool.slug} to live`, {
    slug: tool.slug,
    hostedUntil,
  });
  await cfg.audit.record({
    scope,
    gate: 'promotion',
    result: 'live',
    detail: { slug: tool.slug, hostedUntil },
  });

  // ---- Stage 8: live gates (every one BLOCKING) ------------------------------
  // (a) goldens on the LIVE url (test mode on so relay goldens don't email).
  const liveShots = deliverablesAsScreenshotStore(cfg.deliverables);
  const liveResult = await runGoldens({
    url: `${liveUrl}/?jiffytest=1`,
    set: goldens,
    openPage: cfg.openPage,
    timeoutMs: ASSERTION_TIMEOUT_MS,
    screenshots: { store: liveShots.store, keyPrefix: `${token}/` },
  });
  if (!liveResult.pass) {
    const failures = compactFailures(liveResult.outcomes);
    await cfg.buildLog.append(token, 'live-assert', 'goldens failed on the live url', { failures });
    await cfg.audit.record({ scope, gate: 'live-assert', result: 'fail', detail: { failures } });
    throw new Error(`live goldens failed on ${liveUrl}`);
  }
  await cfg.buildLog.append(token, 'live-assert', 'all goldens passed on the live url');
  await cfg.audit.record({ scope, gate: 'live-assert', result: 'pass' });

  // (b) element census on a CLEAN load of the live url.
  const censusPage = await cfg.openPage();
  let missing: string[];
  try {
    await censusPage.goto(liveUrl);
    missing = await censusMissing(censusPage, def.elementContract(slots));
  } finally {
    await censusPage.close();
  }
  if (missing.length > 0) {
    await cfg.buildLog.append(token, 'element-contract', 'required elements missing', { missing });
    await cfg.audit.record({
      scope,
      gate: 'element-contract',
      result: 'fail',
      detail: { missing },
    });
    throw new Error(`element-contract: missing ${missing.join(', ')}`);
  }
  await cfg.audit.record({ scope, gate: 'element-contract', result: 'pass' });

  // (c) PSI on the CLEAN live url. An outage parks (cron re-enqueues; the staged short-circuit
  // resumes cheaply); scores below the thresholds throw to retry once via the queue.
  const psiResult = await cfg.psi.run(liveUrl);
  if (!psiResult.ok) {
    await cfg.buildLog.append(token, 'psi', 'PSI outage; parking (cron re-enqueues)');
    await cfg.audit.record({
      scope,
      gate: 'psi',
      result: 'outage',
      detail: { error: psiResult.error },
    });
    await persist();
    await cfg.jobs.park(job.jobKey, 'psi_outage');
    return;
  }
  const performance = psiResult.performance ?? 0;
  const accessibility = psiResult.accessibility ?? 0;
  if (performance < PSI_PERFORMANCE_MIN || accessibility < PSI_ACCESSIBILITY_MIN) {
    await cfg.buildLog.append(token, 'psi', 'PSI below thresholds', { performance, accessibility });
    await cfg.audit.record({
      scope,
      gate: 'psi',
      result: 'below-threshold',
      detail: { performance, accessibility },
    });
    throw new Error(`PSI below thresholds (perf ${performance}, a11y ${accessibility})`);
  }
  await cfg.audit.record({
    scope,
    gate: 'psi',
    result: 'pass',
    detail: { performance, accessibility },
  });

  // (d) relay-family: THE one deliberate real delivery — a test submission proving the relay works.
  // Exactly-once across a promote retry: a prior invocation may already have sent this and then
  // thrown on a LATER step (a live gate, packaging, deliverMilestone) — the queue retries the
  // whole message and we re-enter here via the staged short-circuit. Check the relay_events table
  // for a prior 'test' send before mailing the buyer again.
  let relayProof: { messageId: string | null } | undefined;
  if (isRelayTemplate(def, brief)) {
    const recipient = brief.notifyEmail as string;
    const priorTest = await cfg.relay.latestEvent(tool.toolId, 'test');
    if (priorTest) {
      relayProof = { messageId: priorTest.messageId };
      await cfg.buildLog.append(
        token,
        'relay',
        'reusing prior live relay test submission (promote retry); not re-sending',
        { messageId: priorTest.messageId },
      );
      await cfg.audit.record({
        scope,
        gate: 'relay',
        result: 'reused',
        detail: { messageId: priorTest.messageId },
      });
    } else {
      const sent = await cfg.mailer.send({
        to: recipient,
        from: cfg.relayFromAddress,
        subject: 'JiffyApp delivery verification — test submission',
        text:
          `This is an automated test submission from JiffyApp, sent once at delivery to prove your ` +
          `form relay delivers to ${recipient}. It is the FR-8 relay-delivery proof recorded in your ` +
          `evidence report — no action needed.\n`,
      });
      await cfg.relay.recordEvent({
        toolId: tool.toolId,
        kind: 'test',
        status: 'sent',
        messageId: sent.messageId ?? undefined,
      });
      relayProof = { messageId: sent.messageId };
      await cfg.buildLog.append(token, 'relay', 'sent the live relay test submission');
      await cfg.audit.record({
        scope,
        gate: 'relay',
        result: 'sent',
        detail: { messageId: sent.messageId },
      });
    }
  }

  // ---- Stage 9: package + deliver --------------------------------------------
  const readme = buildEjectReadme({
    name: brief.name,
    slug: tool.slug,
    templateId: def.id,
    templateVersion: def.version,
    vendored: vendoredDepsFor(def.id),
    toolUrl: liveUrl,
  });
  const zipEntries = ejectZipEntries({
    files,
    workerScript: script,
    readme,
    wranglerJsonc: buildEjectWranglerConfig(tool.slug),
  });
  const zip = buildEjectZip(zipEntries);
  const zipCheck = verifyEjectZip(zip, REQUIRED_EJECT_PATHS);
  if (!zipCheck.ok) {
    await cfg.buildLog.append(token, 'package', 'eject ZIP failed verification', {
      errors: zipCheck.errors,
    });
    await cfg.audit.record({
      scope,
      gate: 'eject-zip',
      result: 'fail',
      detail: { errors: zipCheck.errors },
    });
    throw new Error(`eject-zip verification failed: ${zipCheck.errors.join('; ')}`);
  }
  await cfg.audit.record({ scope, gate: 'eject-zip', result: 'pass' });

  const report = buildEvidenceReport({
    contractId: job.contractId,
    gigId: job.gigId,
    toolId: tool.toolId,
    slug: tool.slug,
    liveUrl,
    template: { id: def.id, version: def.version },
    models: {
      codegen: CODEGEN_MODEL_ID,
      ...(checkpoint.round === MAX_REPAIR_ROUNDS ? { escalation: HAIKU_MODEL_ID } : {}),
      goldensCompiler: HAIKU_MODEL_ID,
    },
    goldenOutcomes: liveResult.outcomes,
    screenshotHashes: liveShots.hashes,
    reachabilityStatus,
    censusMissing: [],
    psi: psiResult,
    moderationPass: true,
    ...(relayProof ? { relayProof } : {}),
    ejectZipCheck: zipCheck,
    checkpoint,
    jobKey: job.jobKey,
    buildLogUrl,
    now,
  });

  await cfg.deliverables.put(
    `${token}/report.json`,
    JSON.stringify(report, null, 2),
    'application/json',
  );
  await cfg.deliverables.put(`${token}/psi.json`, JSON.stringify(psiResult), 'application/json');
  await cfg.deliverables.put(`${token}/source.zip`, zip, 'application/zip');

  const funded = contract.milestones.find((m) => m.status === 'funded');
  if (!funded) throw new Error(`promote: no funded milestone on contract ${job.contractId}`);

  try {
    await cfg.client.deliverMilestone(job.contractId, funded.id, {
      note: buildDeliveryNote({
        name: brief.name,
        liveUrl,
        reportUrl,
        zipUrl,
        buildLogUrl,
        toolId: tool.toolId,
        hostingPriceUsd: HOSTING_PRICE_USD,
        goldenCount: goldens.goldens.length,
      }),
      attachments: [liveUrl, reportUrl, zipUrl, buildLogUrl],
    });
  } catch (deliverErr) {
    // Idempotency across a promote retry: this deliverMilestone call may have already reached
    // and been accepted by the platform on a PRIOR attempt, with the failure actually coming
    // from a tail step after it (setGoldens/markDelivered/a local write). Re-fetch the contract
    // to check — if the platform already marked this milestone delivered/accepted, treat this
    // attempt as done rather than dead-lettering an otherwise successfully-delivered job.
    let refetched: Contract;
    try {
      refetched = await cfg.client.getContract(job.contractId);
    } catch {
      throw deliverErr; // can't confirm either way — surface the ORIGINAL deliver error
    }
    const refunded = refetched.milestones.find((m) => m.id === funded.id);
    if (refunded && (refunded.status === 'delivered' || refunded.status === 'accepted')) {
      await cfg.buildLog.append(
        token,
        'delivery',
        'deliverMilestone failed locally, but the platform already accepted a prior attempt',
        { milestoneId: funded.id, status: refunded.status },
      );
      await cfg.audit.record({
        scope,
        gate: 'delivery',
        result: 'delivery-already-accepted',
        detail: { toolId: tool.toolId, milestoneId: funded.id, status: refunded.status },
      });
    } else {
      throw deliverErr; // genuine failure — the queue retries the whole message
    }
  }

  await cfg.tools.setGoldens(tool.toolId, goldens);
  await cfg.jobs.markDelivered(job.jobKey, 'delivered');
  await cfg.buildLog.append(token, 'delivered', 'tool delivered', { liveUrl, reportUrl, zipUrl });
  await cfg.audit.record({
    scope,
    gate: 'delivery',
    result: 'delivered',
    detail: { toolId: tool.toolId },
  });
}

/**
 * The FR-6/§9 non-convergence leg: we could not reach green staging within the caps (or the
 * active-time deadline was hit). Tear down staging, tell the buyer exactly what still failed with
 * links to the final attempt's screenshots and the build log, and ask them to cancel the contract
 * (cancellation/refund is payer-side). We deliver nothing.
 */
export async function abortJob(
  cfg: PipelineConfig,
  args: {
    job: JobRow;
    tool: ToolRow | null;
    reason: 'caps-exhausted' | 'deadline';
    checkpoint: BuildCheckpoint;
  },
): Promise<void> {
  const { job, tool, reason, checkpoint } = args;
  const scope = job.contractId;
  const token = job.deliverableToken;
  const name = tool?.name ?? 'your tool';

  // Staging teardown is tolerant — a job with no staged script yet (deadline on entry) simply has
  // nothing to delete, and a teardown error must not block the abort.
  try {
    await cfg.deployer.deleteScript(stagingSlug(token));
  } catch (err) {
    cfg.logger.warn({ err, token }, 'abort: staging teardown failed; continuing');
  }

  const buildLogUrl = `${cfg.publicBaseUrl}/p/${token}`;
  const lines: string[] = [
    `We weren't able to get "${name}" to pass its accepted golden assertions within our build ` +
      `budget, so we're stopping here rather than shipping something that doesn't meet the bar.`,
  ];
  if (checkpoint.lastFailures.length > 0) {
    lines.push('', 'The assertions still failing on the final attempt were:');
    for (const failure of checkpoint.lastFailures) lines.push(`- ${failure}`);
  }

  // Screenshots exist only for rounds that actually staged; the loop increments `round` AFTER a
  // failed assert, so the last staged round is `checkpoint.round - 1`.
  const goldenCount = (tool?.goldens ?? job.goldens)?.goldens.length ?? 0;
  if (checkpoint.round >= 1 && goldenCount > 0) {
    const lastRound = checkpoint.round - 1;
    lines.push('', 'Screenshots from that final attempt:');
    for (let i = 0; i < goldenCount; i++) {
      lines.push(`- ${cfg.publicBaseUrl}/deliverables/${token}/stg-r${lastRound}-shot-${i}.png`);
    }
  }
  lines.push('', `Full build log: ${buildLogUrl}`);
  lines.push(
    '',
    'We deliver nothing, and we have torn down the staging build. Please cancel this contract — ' +
      'cancellation and any refund are handled on your side (payer-side).',
  );
  await cfg.client.sendMessage(scope, lines.join('\n'));

  await cfg.buildLog.append(token, 'aborted', `non-convergence (${reason}); staging torn down`);
  await cfg.audit.record({
    scope,
    gate: 'non-convergence',
    result: reason,
    detail: { round: checkpoint.round, spendUsd: checkpoint.spendUsd },
  });
  await cfg.jobs.markDelivered(job.jobKey, 'aborted');
  // A tool row was reserved but never went live — kill it (the slug stays reserved, acceptable).
  if (tool && tool.status === 'building') {
    await cfg.tools.setStatus(tool.toolId, 'killed');
  }
}

// --- Thread-driven bounded edits (Task 22 / FR-14) ---------------------------

function editToolMissingMessage(toolId: string | undefined): string {
  return (
    `We couldn't apply your edit: the tool (toolId ${toolId ?? '(none)'}) is not currently live, ` +
    'so there is nothing to edit. Fund a new hosting gig to bring it back, then re-post the edit — ' +
    'this request was NOT counted against your included edits.'
  );
}

function editRephraseMessage(errors: string[]): string {
  return [
    "We couldn't turn your edit request into updated acceptance checks for this tool, so we " +
      "haven't changed anything and this edit did NOT use one of your included edits.",
    '',
    'Please re-post it (starting with "edit:") describing the change in terms of what should be ' +
      `visible or should happen on the page. Details: ${errors.join('; ')}`,
  ].join('\n');
}

function editTemplateMismatchMessage(): string {
  return (
    "We couldn't apply your edit right now: this tool is pinned to a template version that no " +
    'longer matches our current catalog, so re-rendering it safely needs a human operator. Your ' +
    'edit was NOT counted against your included edits — reply here and an operator will look into it.'
  );
}

function editAbortMessage(buildLogUrl: string): string {
  return [
    'We tried to apply your edit but could not get it to pass its acceptance checks within our ' +
      'build budget, so we stopped. The live tool is UNCHANGED and keeps serving, and this edit ' +
      'did NOT consume one of your included edits.',
    '',
    `Full build log: ${buildLogUrl}`,
    '',
    'Try re-posting the edit with a more specific description of the change you want.',
  ].join('\n');
}

function editRestoredMessage(buildLogUrl: string): string {
  return [
    'We tried to apply your edit, but the updated tool could not pass its live acceptance checks, ' +
      'so we restored your tool to its previous working version. Your live tool is UNCHANGED and ' +
      'still serving, and this edit did NOT consume one of your included edits.',
    '',
    `Full build log: ${buildLogUrl}`,
    '',
    'Try re-posting the edit with a more specific description of the change you want.',
  ].join('\n');
}

function editDeliveredMessage(args: {
  name: string;
  liveUrl: string;
  goldenCount: number;
  buildLogUrl: string;
}): string {
  return [
    `Your edit to "${args.name}" is live: ${args.liveUrl}`,
    '',
    `It re-passed all ${args.goldenCount} golden assertions on the live URL, so the updated set is ` +
      'now the acceptance and warranty scope for this tool. Fresh screenshots and the full gate ' +
      `log are on the build-log page: ${args.buildLogUrl}`,
  ].join('\n');
}

/**
 * Quota-release invariant (FR-14): a FAILED / rejected / aborted edit releases exactly the
 * (scope, period) pair it reserved, and only while the request is still in its reserved
 * `claimed` state — so a redelivery whose request already went `failed`/`done` never
 * double-releases (usage.release floors at 0, but an over-release would still corrupt the count).
 */
async function releaseEditQuota(cfg: PipelineConfig, request: EditRequestRow): Promise<void> {
  if (request.status !== 'claimed') return;
  if (!request.quotaScope || !request.quotaPeriod) return;
  await cfg.usage.release(request.quotaScope, request.quotaPeriod);
}

/**
 * Edit promote + live gates: deploy the green-staging script over the LIVE slug, re-run the full
 * §9 live-gate suite (goldens on the live url + element census + PSI) against the UPDATED golden
 * set, then flip the tool's slots + goldens, mark the request done, and tell the buyer. The
 * relay-family test submission is intentionally SKIPPED (the recipient was already proven at build
 * time). A PSI outage parks (`psi_outage`) resumably; any other gate failure THROWS so the queue
 * retries and the edit staged short-circuit (in `processEditJob`) resumes cheaply.
 */
async function promoteEdit(
  cfg: PipelineConfig,
  args: {
    job: JobRow;
    tool: ToolRow;
    def: TemplateDefinition;
    request: EditRequestRow;
    requestId: string;
    goldens: GoldenSet;
    slots: SlotValues;
    script: string;
    checkpoint: BuildCheckpoint;
    /** For rendering the prior-good script on an F2 restore (same ctx the staged short-circuit uses). */
    relayCtx: { toolId: string; token: string } | null;
  },
): Promise<void> {
  const { job, tool, def, request, requestId, goldens, slots, script, checkpoint, relayCtx } = args;
  const now = cfg.now ?? ((): Date => new Date());
  const sleep = cfg.sleep ?? defaultSleep;
  const scope = job.contractId;
  const token = job.deliverableToken;
  const liveUrl = `https://${tool.slug}.${cfg.toolHostSuffix}`;
  const buildLogUrl = `${cfg.publicBaseUrl}/p/${token}`;

  // Self-contained active-time banking for the one controlled exit (PSI outage park).
  const baseActiveMs = checkpoint.activeMs;
  const startMs = now().getTime();
  const persist = async (): Promise<void> => {
    checkpoint.activeMs = baseActiveMs + (now().getTime() - startMs);
    await cfg.jobs.saveCheckpoint(job.jobKey, checkpoint);
  };

  // ---- Promote over the live slug --------------------------------------------
  await cfg.deployer.putScript(tool.slug, script);
  let reach = await cfg.fetchImpl(liveUrl);
  if (reach.status !== 200) {
    await sleep(REACHABILITY_RETRY_MS);
    reach = await cfg.fetchImpl(liveUrl);
  }
  if (reach.status !== 200) {
    await cfg.audit.record({
      scope,
      gate: 'reachability',
      result: 'unreachable',
      detail: { status: reach.status },
    });
    throw new Error(`edit live reachability: ${liveUrl} returned ${reach.status}`);
  }
  const reachabilityStatus = reach.status;

  try {
    await cfg.deployer.deleteScript(stagingSlug(token));
  } catch (err) {
    cfg.logger.warn({ err, token }, 'edit promote: staging teardown failed; continuing');
  }

  // hostedUntil is unchanged — an edit never extends (or resets) the paid hosting window.
  const hostedUntil =
    tool.hostedUntil ?? new Date(now().getTime() + HOSTING_WINDOW_DAYS * 86_400_000).toISOString();

  // F2 restore-last-good: capture the tool's PRIOR-good live slots BEFORE the promote overwrites
  // them, and persist so a retry can still restore. Guarded by `??` — on a promote retry `tool.slots`
  // is already the NEW slots, so only the FIRST capture (the original live slots) is authoritative.
  checkpoint.priorSlots = checkpoint.priorSlots ?? tool.slots;
  await cfg.jobs.saveCheckpoint(job.jobKey, checkpoint);

  await cfg.tools.promote(tool.toolId, { slots, hostedUntil });
  await cfg.buildLog.append(token, 'promote', `edit promoted ${tool.slug} to live`, {
    slug: tool.slug,
  });
  await cfg.audit.record({
    scope,
    gate: 'promotion',
    result: 'live',
    detail: { slug: tool.slug, edit: request.instruction },
  });

  // A LIVE-gate failure on an edit must NOT leave the gate-failing version serving (the tool was
  // ALREADY live before this edit). Restore the prior-good render — rendered exactly as the staged
  // short-circuit does — make the DB slots consistent with what is now served, then TERMINALLY abort
  // the edit: release the reserved quota, tell the buyer, and mark the job aborted. No re-throw, so
  // the queue does not retry and the staged short-circuit does not re-promote the failing script. A
  // PSI *outage* (couldn't measure) is NOT a failure — it parks/retries below, unchanged.
  const restoreLastGood = async (reason: string): Promise<void> => {
    const priorSlots = checkpoint.priorSlots;
    if (!priorSlots) {
      // Captured before the first promote, so this is unreachable in practice; if it ever happens
      // there is nothing to restore to — surface as transient so the queue retries rather than
      // silently leaving the gate-failing version live.
      throw new Error(`edit restore: no prior slots captured for ${tool.toolId} (${reason})`);
    }
    const ctx: RenderContext = {
      slug: tool.slug,
      toolUrl: liveUrl,
      publicBaseUrl: cfg.publicBaseUrl,
      relay: relayCtx,
    };
    const priorFiles = def.render(priorSlots, ctx);
    const priorScript = buildToolWorkerScript(
      priorFiles,
      cspFor(ctx, { frameable: def.id === 'widget' }),
    );
    await cfg.deployer.putScript(tool.slug, priorScript);
    await cfg.tools.promote(tool.toolId, { slots: priorSlots, hostedUntil });
    await releaseEditQuota(cfg, request);
    await cfg.edits.setStatus(requestId, 'failed');
    await cfg.client.sendMessage(scope, editRestoredMessage(buildLogUrl));
    await cfg.buildLog.append(
      token,
      'restore',
      'edit failed a live gate; restored the previous working version',
      { reason },
    );
    await cfg.audit.record({
      scope,
      gate: 'edit',
      result: 'restored',
      detail: { toolId: tool.toolId, reason },
    });
    await cfg.jobs.markDelivered(job.jobKey, 'aborted');
  };

  // ---- Live gates (goldens + census + PSI), same suite as a build ------------
  const liveShots = deliverablesAsScreenshotStore(cfg.deliverables);
  const liveResult = await runGoldens({
    url: `${liveUrl}/?jiffytest=1`,
    set: goldens,
    openPage: cfg.openPage,
    timeoutMs: ASSERTION_TIMEOUT_MS,
    screenshots: { store: liveShots.store, keyPrefix: `${token}/` },
  });
  if (!liveResult.pass) {
    const failures = compactFailures(liveResult.outcomes);
    await cfg.buildLog.append(token, 'live-assert', 'edit goldens failed on the live url', {
      failures,
    });
    await cfg.audit.record({ scope, gate: 'live-assert', result: 'fail', detail: { failures } });
    return restoreLastGood('live-goldens');
  }
  await cfg.buildLog.append(token, 'live-assert', 'all goldens passed on the live url');
  await cfg.audit.record({ scope, gate: 'live-assert', result: 'pass' });

  const censusPage = await cfg.openPage();
  let missing: string[];
  try {
    await censusPage.goto(liveUrl);
    missing = await censusMissing(censusPage, def.elementContract(slots));
  } finally {
    await censusPage.close();
  }
  if (missing.length > 0) {
    await cfg.buildLog.append(token, 'element-contract', 'required elements missing', { missing });
    await cfg.audit.record({
      scope,
      gate: 'element-contract',
      result: 'fail',
      detail: { missing },
    });
    return restoreLastGood('element-contract');
  }
  await cfg.audit.record({ scope, gate: 'element-contract', result: 'pass' });

  const psiResult = await cfg.psi.run(liveUrl);
  if (!psiResult.ok) {
    await cfg.buildLog.append(token, 'psi', 'PSI outage; parking (cron re-enqueues)');
    await cfg.audit.record({
      scope,
      gate: 'psi',
      result: 'outage',
      detail: { error: psiResult.error },
    });
    await persist();
    await cfg.jobs.park(job.jobKey, 'psi_outage');
    return;
  }
  const performance = psiResult.performance ?? 0;
  const accessibility = psiResult.accessibility ?? 0;
  if (performance < PSI_PERFORMANCE_MIN || accessibility < PSI_ACCESSIBILITY_MIN) {
    await cfg.buildLog.append(token, 'psi', 'PSI below thresholds', { performance, accessibility });
    await cfg.audit.record({
      scope,
      gate: 'psi',
      result: 'below-threshold',
      detail: { performance, accessibility },
    });
    return restoreLastGood('psi-below-threshold');
  }
  await cfg.audit.record({
    scope,
    gate: 'psi',
    result: 'pass',
    detail: { performance, accessibility },
  });

  // Relay-family: SKIP the test delivery — the recipient was already proven at build time (FR-14).

  // ---- Finalize: the updated goldens ARE the new warranty scope --------------
  await cfg.tools.setGoldens(tool.toolId, goldens);
  await cfg.edits.setStatus(requestId, 'done');
  await cfg.client.sendMessage(
    scope,
    editDeliveredMessage({
      name: tool.name,
      liveUrl,
      goldenCount: goldens.goldens.length,
      buildLogUrl,
    }),
  );
  await cfg.jobs.markDelivered(job.jobKey, 'delivered');
  await cfg.buildLog.append(token, 'delivered', 'edit delivered', {
    liveUrl,
    reachabilityStatus,
  });
  await cfg.audit.record({
    scope,
    gate: 'delivery',
    result: 'delivered',
    detail: { toolId: tool.toolId, edit: request.instruction },
  });
}

/**
 * A thread-posted `edit:` request (Task 22 / FR-14): re-compile only the invalidated goldens,
 * regenerate constrained from the CURRENT live slots through the shared repair loop, and — on
 * green — promote over the live slug and re-run the full live-gate suite. The live tool is left
 * UNCHANGED (and the reserved edit quota released) on any pre-promote failure; the quota is
 * consumed only by a delivered edit.
 */
export async function processEditJob(
  cfg: PipelineConfig,
  msg: JobMessage & { kind: 'edit' },
): Promise<void> {
  const now = cfg.now ?? ((): Date => new Date());
  const startMs = now().getTime();
  const { requestId } = msg;

  // ---- Load + guard ----------------------------------------------------------
  const job = await cfg.jobs.get(msg.jobKey);
  if (!job) {
    cfg.logger.warn({ jobKey: msg.jobKey }, 'edit job: no such job row; dropping');
    return;
  }
  if (job.status === 'delivered') {
    cfg.logger.info({ jobKey: msg.jobKey }, 'edit job: already delivered; replay ignored');
    return;
  }
  if (job.status === 'parked') {
    cfg.logger.info(
      { jobKey: msg.jobKey, parkReason: job.parkReason },
      'edit job: parked; a sweep re-enqueues it',
    );
    return;
  }

  const token = job.deliverableToken;
  const scope = msg.contractId;

  const checkpoint: BuildCheckpoint = job.checkpoint ?? {
    slotValues: null,
    round: 0,
    spendUsd: job.spentUsd ?? 0,
    activeMs: 0,
    staged: false,
    lastFailures: [],
    bankedRound: null,
  };
  checkpoint.bankedRound = checkpoint.bankedRound ?? null;
  const baselineActiveMs = checkpoint.activeMs;
  const firstEntry = job.checkpoint === null;
  if (firstEntry) await cfg.jobs.setInProgress(msg.jobKey, {});

  // ---- Edit request row (a null row is inconsistent state, not a rejection) --
  const request = requestId ? await cfg.edits.get(requestId) : null;
  if (!request || !requestId) {
    cfg.logger.warn({ jobKey: msg.jobKey, requestId }, 'edit job: no edit_requests row; parking');
    await cfg.audit.record({
      scope,
      gate: 'edit',
      result: 'request-missing',
      detail: { requestId: requestId ?? null },
    });
    await cfg.jobs.park(msg.jobKey, 'edit_request_missing');
    return;
  }

  // ---- Tool must be live/grace (else park; quota released, request failed) ----
  const tool = msg.toolId ? await cfg.tools.get(msg.toolId) : null;
  if (!tool || (tool.status !== 'live' && tool.status !== 'grace')) {
    await cfg.client.sendMessage(scope, editToolMissingMessage(msg.toolId));
    await cfg.audit.record({
      scope,
      gate: 'edit',
      result: 'tool-missing',
      detail: { toolId: msg.toolId ?? null, status: tool?.status ?? null },
    });
    await releaseEditQuota(cfg, request);
    await cfg.edits.setStatus(requestId, 'failed');
    await cfg.jobs.park(msg.jobKey, 'tool_missing');
    return;
  }

  const def = getTemplate(tool.templateId);

  // ---- Template-version pin (templates PRD §4): a registry bump must never silently
  //      re-render a delivered tool. Quota is NOT consumed — release it. --------
  if (def.version !== tool.templateVersion) {
    cfg.logger.warn(
      {
        jobKey: msg.jobKey,
        toolId: tool.toolId,
        pinned: tool.templateVersion,
        current: def.version,
      },
      'edit job: template version mismatch; parking',
    );
    await cfg.client.sendMessage(scope, editTemplateMismatchMessage());
    await cfg.audit.record({
      scope,
      gate: 'edit',
      result: 'template-version-mismatch',
      detail: { pinned: tool.templateVersion, current: def.version },
    });
    await releaseEditQuota(cfg, request);
    await cfg.edits.setStatus(requestId, 'failed');
    await cfg.jobs.park(msg.jobKey, 'template_version_mismatch');
    return;
  }

  const relay = isRelayTemplate(def, tool.brief) ? await cfg.relay.get(tool.toolId) : null;
  const relayCtx = relay ? { toolId: tool.toolId, token: relay.token } : null;

  // ---- Staged short-circuit (mirror the build resume): green staging already reached, a
  //      transient promote/live-gate throw is being retried — re-render from the banked slots
  //      and jump straight back to promote. -------------------------------------
  if (checkpoint.staged && checkpoint.slotValues && job.goldens) {
    const ctx: RenderContext = {
      slug: tool.slug,
      toolUrl: `https://${tool.slug}.${cfg.toolHostSuffix}`,
      publicBaseUrl: cfg.publicBaseUrl,
      relay: relayCtx,
    };
    const files = def.render(checkpoint.slotValues, ctx);
    const script = buildToolWorkerScript(files, cspFor(ctx, { frameable: def.id === 'widget' }));
    await cfg.buildLog.append(
      token,
      'resume',
      'edit green staging already reached; resuming at promote',
    );
    await promoteEdit(cfg, {
      job,
      tool,
      def,
      request,
      requestId,
      goldens: job.goldens,
      slots: checkpoint.slotValues,
      script,
      checkpoint,
      relayCtx,
    });
    return;
  }

  // ---- Recompile the goldens ONCE (persisted on the job row so a resume never re-spends) ----
  let updatedSet: GoldenSet;
  if (job.goldens) {
    updatedSet = job.goldens;
  } else {
    const recompiled = await cfg.compiler.recompileForEdit({
      brief: tool.brief,
      instruction: request.instruction,
      currentGoldens: tool.goldens,
      def,
      bindable: proposalBindable(def, tool.brief),
    });
    checkpoint.spendUsd += recompiled.costUsd;
    if (!recompiled.ok) {
      await cfg.buildLog.append(token, 'edit-goldens', 'could not recompile goldens for the edit', {
        errors: recompiled.errors,
      });
      await cfg.audit.record({
        scope,
        gate: 'edit-goldens',
        result: 'invalid',
        detail: { errors: recompiled.errors },
      });
      await releaseEditQuota(cfg, request);
      await cfg.edits.setStatus(requestId, 'failed');
      await cfg.client.sendMessage(scope, editRephraseMessage(recompiled.errors));
      await cfg.jobs.markDelivered(msg.jobKey, 'rejected');
      return;
    }
    updatedSet = recompiled.set;
    await cfg.jobs.setInProgress(msg.jobKey, { goldensJson: JSON.stringify(updatedSet) });
    await cfg.buildLog.append(token, 'edit-goldens', 'recompiled goldens for the edit', {
      count: updatedSet.goldens.length,
    });
    await cfg.audit.record({
      scope,
      gate: 'edit-goldens',
      result: 'ok',
      detail: { count: updatedSet.goldens.length },
    });
  }

  // Seed the repair loop from the CURRENT live slots — an edit MODIFIES, it doesn't regenerate.
  if (firstEntry) checkpoint.slotValues = tool.slots;

  // ---- Constrained codegen / repair loop (shared with the build path) --------
  const loopResult = await runBuildLoop(cfg, {
    job,
    tool,
    def,
    brief: tool.brief,
    goldens: updatedSet,
    checkpoint,
    msg,
    relayCtx,
    instruction: request.instruction,
    invocationStart: startMs,
    baselineActiveMs,
  });

  if (loopResult.outcome === 'green') {
    await promoteEdit(cfg, {
      job,
      tool,
      def,
      request,
      requestId,
      goldens: updatedSet,
      slots: loopResult.slots,
      script: loopResult.script,
      checkpoint,
      relayCtx,
    });
    return;
  }
  if (loopResult.outcome === 'caps-exhausted') {
    // Edit abort: the live tool is UNCHANGED (never promoted). Tear down staging, release the
    // reserved quota, and tell the buyer nothing changed.
    try {
      await cfg.deployer.deleteScript(stagingSlug(token));
    } catch (err) {
      cfg.logger.warn({ err, token }, 'edit abort: staging teardown failed; continuing');
    }
    await releaseEditQuota(cfg, request);
    await cfg.edits.setStatus(requestId, 'failed');
    await cfg.client.sendMessage(scope, editAbortMessage(`${cfg.publicBaseUrl}/p/${token}`));
    await cfg.jobs.markDelivered(msg.jobKey, 'aborted');
    await cfg.audit.record({
      scope,
      gate: 'edit',
      result: 'aborted',
      detail: { toolId: tool.toolId, reason: loopResult.reason },
    });
    return;
  }
  // 'continuation' | 'parked' — runBuildLoop already re-enqueued or parked; nothing more to do.
}

// --- Dispatch ----------------------------------------------------------------

export async function processJobMessage(cfg: PipelineConfig, msg: JobMessage): Promise<void> {
  if (msg.kind === 'build') return runBuildJob(cfg, msg);
  if (msg.kind === 'cycle') {
    // Cycle jobs are routed straight to hosting.processCycleJob by the queue consumer
    // (index.ts) — reaching this branch means that routing was bypassed.
    cfg.logger.warn(
      { jobKey: msg.jobKey },
      'cycle job reached processJobMessage; the queue consumer should route it to ' +
        'hosting.processCycleJob directly',
    );
    return;
  }
  return processEditJob(cfg, msg as JobMessage & { kind: 'edit' });
}

// --- Helpers -----------------------------------------------------------------

/** Wraps an R2 DeliverableStore as a `ScreenshotStore`, and — as each screenshot is stored —
 *  records its SHA-256 keyed by BASENAME (the trailing path segment, e.g. `shot-0.png`) in a
 *  `hashes` map the caller keeps for the evidence report. The digest runs on a fresh copy of the
 *  bytes (sha256HexBytes copies internally) so a later reuse of the source view can't perturb it. */
function deliverablesAsScreenshotStore(deliverables: DeliverableStore): {
  store: ScreenshotStore;
  hashes: Record<string, string>;
} {
  const hashes: Record<string, string> = {};
  const store: ScreenshotStore = {
    async put(key, bytes) {
      await deliverables.put(key, bytes, 'image/png');
      const basename = key.slice(key.lastIndexOf('/') + 1);
      hashes[basename] = await sha256HexBytes(bytes);
    },
  };
  return { store, hashes };
}

/** Turn a failed golden run into concise repair feedback: per failed golden, its title plus
 *  the first failed check (expected vs actual) or the driver/timeout error. */
function compactFailures(outcomes: AssertionOutcome[]): string[] {
  const failures: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.pass) continue;
    if (outcome.error) {
      failures.push(`${outcome.goldenTitle}: ${outcome.error}`);
      continue;
    }
    const firstFailed = outcome.checks.find((check) => !check.pass);
    failures.push(
      firstFailed
        ? `${outcome.goldenTitle}: ${firstFailed.description} — expected ${firstFailed.expected}, ` +
            `actual ${firstFailed.actual}`
        : `${outcome.goldenTitle}: failed`,
    );
  }
  return failures;
}

/** Re-host any `*DataUrl` slot that the model left as an http(s) URL (link-in-bio avatar, …).
 *  A fetch/size/type failure or a flagged image DROPS the slot (never parks); a moderation
 *  OUTAGE returns 'outage' so the caller parks fail-closed. */
async function rehostImages(
  cfg: PipelineConfig,
  def: TemplateDefinition,
  slots: SlotValues,
  scope: string,
): Promise<'ok' | 'outage'> {
  for (const spec of def.slots) {
    if (!/dataurl$/i.test(spec.name)) continue;
    const value = slots[spec.name];
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) continue;

    const fetched = await fetchImageAsset(cfg.fetchImpl, value);
    if (!fetched.ok) {
      delete slots[spec.name];
      await cfg.audit.record({
        scope,
        gate: 'image',
        result: 'dropped',
        detail: { slot: spec.name, reason: fetched.reason },
      });
      continue;
    }
    const moderated = await cfg.moderation.moderateImage(fetched.dataUrl);
    if (!moderated.ok) return 'outage';
    if (moderated.verdict.flagged) {
      delete slots[spec.name];
      await cfg.audit.record({
        scope,
        gate: 'image',
        result: 'dropped',
        detail: { slot: spec.name, reason: 'flagged' },
      });
      continue;
    }
    slots[spec.name] = fetched.dataUrl;
  }
  return 'ok';
}

// --- Shared codegen / repair loop (build + edit) -----------------------------

interface RunBuildLoopArgs {
  job: JobRow;
  tool: ToolRow;
  def: TemplateDefinition;
  brief: JiffyBrief;
  goldens: GoldenSet;
  checkpoint: BuildCheckpoint;
  msg: JobMessage;
  relayCtx: { toolId: string; token: string } | null;
  /** Threaded into codegen for edit jobs; absent for a build. */
  instruction?: string;
  /** Wall-clock start of THIS invocation (soft-budget continuation basis). */
  invocationStart: number;
  /** Persisted ACTIVE ms from prior invocations (FR-6 cap basis; recomputed additively here). */
  baselineActiveMs: number;
}

type RunBuildLoopResult =
  | { outcome: 'green'; script: string; slots: SlotValues }
  | { outcome: 'continuation' }
  | { outcome: 'parked' }
  | { outcome: 'caps-exhausted'; reason: 'deadline' | 'caps-exhausted' };

/**
 * The FR-4→FR-6 core: codegen → moderate → render → stage → assert, repaired up to
 * MAX_REPAIR_ROUNDS and capped by spend + active-time budgets. Shared by `runBuildJob` (from a
 * blank slate) and `processEditJob` (seeded from the tool's current slots, with the edit
 * instruction threaded into codegen). Returns the CONTROL DECISION rather than acting on it:
 * `green` (with the staged script + slots — the caller promotes), `continuation` (already
 * checkpointed + re-enqueued past the soft budget), `parked` (a moderation/image outage already
 * parked the job), or `caps-exhausted` (the caller aborts). A transient deploy/serve throw
 * propagates so the queue retries the whole message.
 */
async function runBuildLoop(
  cfg: PipelineConfig,
  args: RunBuildLoopArgs,
): Promise<RunBuildLoopResult> {
  const { job, tool, def, brief, goldens, checkpoint, msg, relayCtx, instruction } = args;
  const now = cfg.now ?? ((): Date => new Date());
  const elapsed = (): number => now().getTime() - args.invocationStart;
  const token = job.deliverableToken;
  const scope = msg.contractId;

  const refreshActive = (): void => {
    checkpoint.activeMs = args.baselineActiveMs + elapsed();
  };
  const persist = async (): Promise<void> => {
    refreshActive();
    await cfg.jobs.saveCheckpoint(msg.jobKey, checkpoint);
  };
  const parkModerationOutage = async (stage: string): Promise<void> => {
    const attempts = await cfg.jobs.incrementModerationAttempts(msg.jobKey);
    await cfg.buildLog.append(token, stage, 'content-safety vendor outage; parked (fail-closed)');
    await cfg.audit.record({
      scope,
      gate: 'moderation',
      result: 'outage',
      detail: { stage, attempts },
    });
    if (attempts === MODERATION_ATTEMPTS_BEFORE_NOTICE) {
      await cfg.client.sendMessage(scope, MODERATION_OUTAGE_NOTICE);
    }
    await persist();
    await cfg.jobs.park(msg.jobKey, 'moderation_outage');
  };

  const stgSlug = stagingSlug(job.deliverableToken);
  const ctx: RenderContext = {
    slug: tool.slug,
    toolUrl: `https://${tool.slug}.${cfg.toolHostSuffix}`,
    publicBaseUrl: cfg.publicBaseUrl,
    relay: relayCtx,
  };

  let round = checkpoint.round;
  let slotValues: SlotValues | null = checkpoint.slotValues;
  let lastFailures: string[] = checkpoint.lastFailures;

  while (round <= MAX_REPAIR_ROUNDS) {
    // Hard active-time cap between rounds ⇒ abort.
    refreshActive();
    if (checkpoint.activeMs > CAP_MS) {
      await cfg.buildLog.append(token, 'deadline', 'active-time cap exceeded between rounds');
      await cfg.audit.record({
        scope,
        gate: 'deadline',
        result: 'exceeded',
        detail: { activeMs: checkpoint.activeMs, round },
      });
      await persist();
      return { outcome: 'caps-exhausted', reason: 'deadline' };
    }

    // Soft per-invocation budget ⇒ checkpoint + re-enqueue continuation (designed, not abort).
    if (elapsed() > CONSUMER_SOFT_BUDGET_MS) {
      await cfg.buildLog.append(token, 'continuation', 'soft budget reached; re-enqueuing', {
        round,
      });
      await persist();
      await cfg.queue.send(msg);
      return { outcome: 'continuation' };
    }

    // Spend cap ⇒ break to abort.
    if (checkpoint.spendUsd >= MAX_SPEND_USD) break;

    // Codegen — UNLESS this round's slots + spend were already banked (a queue retry after a
    // transient stage/deploy/moderation-outage throw re-enters here; re-generating would
    // double-spend the FR-6 budget). A banked round re-uses `slotValues` and does NOT re-spend.
    if (checkpoint.bankedRound === round && slotValues !== null) {
      cfg.logger.info(
        { jobKey: msg.jobKey, round },
        'build job: re-using banked slots (no re-spend)',
      );
    } else {
      const gen = await cfg.codegen.generate({
        def,
        brief,
        goldens,
        priorSlots: slotValues ?? undefined,
        failures: lastFailures.length > 0 ? lastFailures : undefined,
        escalate: round === MAX_REPAIR_ROUNDS,
        instruction,
      });
      checkpoint.spendUsd += gen.costUsd;
      await cfg.buildLog.append(token, 'codegen', `codegen round ${round} via ${gen.model}`, {
        ok: gen.ok,
        costUsd: gen.costUsd,
      });
      await cfg.audit.record({
        scope,
        gate: 'codegen',
        result: gen.ok ? 'ok' : 'invalid',
        detail: { round, model: gen.model },
      });

      if (!gen.ok) {
        lastFailures =
          gen.errors && gen.errors.length > 0 ? gen.errors : ['codegen produced no valid slots'];
        checkpoint.lastFailures = lastFailures;
        round += 1;
        checkpoint.round = round;
        await persist();
        continue;
      }

      // BANK the spend + slots BEFORE render/deploy so a transient throw below doesn't lose them.
      slotValues = gen.slots ?? {};
      checkpoint.slotValues = slotValues;
      checkpoint.bankedRound = round;
      await persist();
    }

    // Image re-hosting (link-in-bio avatar / OG images carried as URLs).
    const rehost = await rehostImages(cfg, def, slotValues, scope);
    if (rehost === 'outage') {
      await parkModerationOutage('image');
      return { outcome: 'parked' };
    }

    // Generated visible copy moderation (fail-closed).
    const copyText = def.slots
      .filter((spec) => spec.kind === 'copy')
      .map((spec) => slotValues?.[spec.name])
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
    if (copyText.length > 0) {
      const copyMod = await cfg.moderation.moderate(copyText);
      if (!copyMod.ok) {
        await parkModerationOutage('copy');
        return { outcome: 'parked' };
      }
      if (copyMod.verdict.flagged) {
        lastFailures = ['generated copy flagged by moderation — rewrite the flagged copy'];
        checkpoint.lastFailures = lastFailures;
        round += 1;
        checkpoint.round = round;
        await persist();
        continue;
      }
    }

    // Render.
    let files: FileSet;
    try {
      files = def.render(slotValues, ctx);
    } catch (err) {
      if (err instanceof SlotError) {
        lastFailures = err.errors;
        checkpoint.lastFailures = lastFailures;
        round += 1;
        checkpoint.round = round;
        await persist();
        continue;
      }
      throw err;
    }

    // Build the worker script and stage it (a throw here is a transient deploy failure — let
    // the queue retry the whole message; do NOT bank active time for the failed attempt).
    const script = buildToolWorkerScript(files, cspFor(ctx, { frameable: def.id === 'widget' }));
    await cfg.deployer.putScript(stgSlug, script);
    const serves = await cfg.deployer.checkServes(stgSlug);
    if (!serves.ok) {
      throw new Error(`build job: staging slug ${stgSlug} did not serve (status ${serves.status})`);
    }
    await cfg.buildLog.append(token, 'stage', `staged round ${round} to ${stgSlug}`);
    await cfg.audit.record({
      scope,
      gate: 'stage',
      result: 'deployed',
      detail: { slug: stgSlug, round },
    });

    // Assert the goldens against the browser-reachable staging URL (test mode on).
    const result = await runGoldens({
      url: `https://${stgSlug}.${cfg.toolHostSuffix}/?jiffytest=1`,
      set: goldens,
      openPage: cfg.openPage,
      timeoutMs: ASSERTION_TIMEOUT_MS,
      screenshots: {
        store: deliverablesAsScreenshotStore(cfg.deliverables).store,
        keyPrefix: `${token}/stg-r${round}-`,
      },
    });
    const shots = result.outcomes
      .map((outcome) => outcome.screenshotKey)
      .filter((key): key is string => key !== undefined);

    if (result.pass) {
      checkpoint.slotValues = slotValues;
      checkpoint.round = round;
      checkpoint.staged = true;
      checkpoint.lastFailures = [];
      // Assertions ran for this round; the banked-round guard is spent (a re-entry now uses the
      // staged short-circuit, not the codegen loop).
      checkpoint.bankedRound = null;
      await persist();
      await cfg.buildLog.append(token, 'assert', `all goldens passed on round ${round}`, {
        screenshots: shots,
      });
      await cfg.audit.record({
        scope,
        gate: 'assert',
        result: 'staging-green',
        detail: { round, screenshots: shots },
      });
      return { outcome: 'green', script, slots: slotValues };
    }

    lastFailures = compactFailures(result.outcomes);
    checkpoint.lastFailures = lastFailures;
    // Assertions ran (and failed) for this round; repair regenerates, so clear the banked guard.
    checkpoint.bankedRound = null;
    round += 1;
    checkpoint.round = round;
    await persist();
    await cfg.buildLog.append(token, 'assert', `goldens failed on round ${round - 1}`, {
      screenshots: shots,
      failures: lastFailures,
    });
    await cfg.audit.record({
      scope,
      gate: 'assert',
      result: 'failed',
      detail: { round: round - 1, failures: lastFailures },
    });
  }

  // Caps exhausted (spend cap or repair rounds) ⇒ abort.
  await cfg.buildLog.append(token, 'caps', 'repair budget exhausted without green staging');
  await cfg.audit.record({
    scope,
    gate: 'caps',
    result: 'cap-exhausted',
    detail: { round, spendUsd: checkpoint.spendUsd },
  });
  await persist();
  return { outcome: 'caps-exhausted', reason: 'caps-exhausted' };
}

// --- Build job ---------------------------------------------------------------

async function runBuildJob(cfg: PipelineConfig, msg: JobMessage): Promise<void> {
  const now = cfg.now ?? ((): Date => new Date());
  const startMs = now().getTime();
  const elapsed = (): number => now().getTime() - startMs;

  // ---- Stage 1: load + guard --------------------------------------------------
  const job = await cfg.jobs.get(msg.jobKey);
  if (!job) {
    cfg.logger.warn({ jobKey: msg.jobKey }, 'build job: no such job row; dropping');
    return;
  }
  if (job.status === 'delivered') {
    cfg.logger.info({ jobKey: msg.jobKey }, 'build job: already delivered; replay ignored');
    return;
  }
  if (job.status === 'parked') {
    cfg.logger.info(
      { jobKey: msg.jobKey, parkReason: job.parkReason },
      'build job: parked; the cron re-enqueues it',
    );
    return;
  }

  const token = job.deliverableToken;
  const scope = msg.contractId;

  const checkpoint: BuildCheckpoint = job.checkpoint ?? {
    slotValues: null,
    round: 0,
    spendUsd: job.spentUsd ?? 0,
    activeMs: 0,
    staged: false,
    lastFailures: [],
    bankedRound: null,
  };
  // Backward-compat: checkpoints written before `bankedRound` existed parse it as `undefined`.
  checkpoint.bankedRound = checkpoint.bankedRound ?? null;
  const baselineActiveMs = checkpoint.activeMs;
  const refreshActive = (): void => {
    checkpoint.activeMs = baselineActiveMs + elapsed();
  };
  const persist = async (): Promise<void> => {
    refreshActive();
    await cfg.jobs.saveCheckpoint(msg.jobKey, checkpoint);
  };

  const firstEntry = job.checkpoint === null;
  if (firstEntry) await cfg.jobs.setInProgress(msg.jobKey, {});

  // Active-time cap on entry (FR-6): pre-accrued time already over budget ⇒ abort.
  refreshActive();
  if (checkpoint.activeMs > CAP_MS) {
    await cfg.buildLog.append(token, 'deadline', 'active-time cap exceeded on entry');
    await cfg.audit.record({
      scope,
      gate: 'deadline',
      result: 'exceeded',
      detail: { activeMs: checkpoint.activeMs },
    });
    await persist();
    const priorTool = await cfg.tools.getByBuildContract(msg.contractId);
    await abortJob(cfg, { job, tool: priorTool, reason: 'deadline', checkpoint });
    return;
  }

  // ---- Shared controlled-exit helpers ----------------------------------------
  const parkBriefInvalid = async (message: string): Promise<void> => {
    await cfg.client.sendMessage(scope, message);
    await cfg.buildLog.append(
      token,
      'brief',
      'brief could not be validated; parked for correction',
    );
    await cfg.audit.record({ scope, gate: 'brief', result: 'invalid' });
    await persist();
    await cfg.jobs.park(msg.jobKey, 'brief_invalid');
  };

  const parkModerationOutage = async (stage: string): Promise<void> => {
    const attempts = await cfg.jobs.incrementModerationAttempts(msg.jobKey);
    await cfg.buildLog.append(token, stage, 'content-safety vendor outage; parked (fail-closed)');
    await cfg.audit.record({
      scope,
      gate: 'moderation',
      result: 'outage',
      detail: { stage, attempts },
    });
    if (attempts === MODERATION_ATTEMPTS_BEFORE_NOTICE) {
      await cfg.client.sendMessage(scope, MODERATION_OUTAGE_NOTICE);
    }
    await persist();
    await cfg.jobs.park(msg.jobKey, 'moderation_outage');
  };

  // ---- Stage 2: resolve brief + goldens --------------------------------------
  const contract = await cfg.client.getContract(msg.contractId);
  const gigRow = await cfg.gigs.get(job.gigId ?? '');

  let brief: JiffyBrief | undefined = job.brief ?? gigRow?.brief;
  let templateId: TemplateId | undefined = gigRow?.templateId;
  let goldens: GoldenSet | undefined = gigRow?.goldens ?? job.goldens ?? undefined;

  if (brief === undefined || templateId === undefined) {
    // Unknown gig (the poller lost its gig_briefs row, or the gig was deleted): re-parse the
    // brief straight from the gig/contract. Goldens are re-derivable here ONLY because none
    // were ever signed off (see below); a known gig's signed-off goldens are never recompiled.
    const gig: Gig = await cfg.client.getGig(contract.gigId).catch(() => gigFromContract(contract));
    const classified = classifyGig(gig);
    if (classified.kind !== 'build') {
      const reason = classified.kind === 'skip' ? classified.reason : 'gig is not a build request';
      await parkBriefInvalid(formatBriefErrors([reason]));
      return;
    }
    brief = brief ?? classified.brief;
    templateId = templateId ?? classified.templateId;
  }

  const def = getTemplate(templateId);

  if (goldens === undefined) {
    const compiled = await cfg.compiler.compile(brief, def, proposalBindable(def, brief));
    checkpoint.spendUsd += compiled.costUsd;
    if (!compiled.ok) {
      await parkBriefInvalid(formatBriefErrors(compiled.errors));
      return;
    }
    goldens = compiled.set;
  }

  // Persist the resolved brief/goldens so a resume doesn't re-resolve them.
  await cfg.jobs.setInProgress(msg.jobKey, {
    gigId: job.gigId ?? contract.gigId,
    briefJson: JSON.stringify(brief),
    goldensJson: JSON.stringify(goldens),
  });

  // ---- Staged short-circuit (Task 18) ----------------------------------------
  // A prior invocation already reached GREEN STAGING (and therefore already passed moderation,
  // relay verification, and the repair loop) but a transient failure in promote/live-gates threw.
  // Skip stages 3-5 entirely: re-render the deterministic script from the banked slots and jump
  // straight back to promoteAndDeliver (its own reachability + live gates are the retry surface).
  if (checkpoint.staged && checkpoint.slotValues) {
    const stagedTool = await cfg.tools.getByBuildContract(msg.contractId);
    if (stagedTool) {
      const relay = isRelayTemplate(def, brief) ? await cfg.relay.get(stagedTool.toolId) : null;
      const ctx: RenderContext = {
        slug: stagedTool.slug,
        toolUrl: `https://${stagedTool.slug}.${cfg.toolHostSuffix}`,
        publicBaseUrl: cfg.publicBaseUrl,
        relay: relay ? { toolId: stagedTool.toolId, token: relay.token } : null,
      };
      const files = def.render(checkpoint.slotValues, ctx);
      const script = buildToolWorkerScript(files, cspFor(ctx, { frameable: def.id === 'widget' }));
      await cfg.buildLog.append(
        token,
        'resume',
        'green staging already reached; resuming at promote',
      );
      await promoteAndDeliver(cfg, {
        job,
        tool: stagedTool,
        def,
        brief,
        goldens,
        slots: checkpoint.slotValues,
        script,
        contract,
        checkpoint,
      });
      return;
    }
  }

  // ---- Stage 3: brief moderation (fail-closed) -------------------------------
  const briefText = [brief.name, brief.description, JSON.stringify(brief.copy ?? {})].join('\n');
  const briefMod = await cfg.moderation.moderate(briefText);
  if (!briefMod.ok) {
    await parkModerationOutage('moderation');
    return;
  }
  if (briefMod.verdict.flagged) {
    await cfg.client.sendMessage(scope, BRIEF_FLAGGED_MESSAGE);
    await cfg.buildLog.append(token, 'moderation', 'brief content flagged');
    await cfg.audit.record({
      scope,
      gate: 'moderation',
      result: 'flagged',
      detail: { stage: 'brief' },
    });
    await persist();
    await cfg.jobs.markDelivered(msg.jobKey, 'rejected');
    return;
  }
  await cfg.buildLog.append(token, 'moderation', 'brief passed content-safety review');
  await cfg.audit.record({ scope, gate: 'moderation', result: 'pass', detail: { stage: 'brief' } });

  // ---- Stage 4: tool + slug + relay ------------------------------------------
  let tool = await cfg.tools.getByBuildContract(msg.contractId);
  if (!tool) {
    const candidates = candidateSlugs(brief.slugPreference, brief.name);
    let chosen: string | undefined;
    for (const candidate of candidates) {
      // Naming-policy gate (templates PRD §3) BEFORE content-safety: a candidate that starts
      // with the reserved `stg-` prefix, is a reserved word, or carries a phishing/brand
      // fragment can NEVER become a live slug. A `stg-` slug would defeat the dispatcher's
      // status gate (FR-17 kill-switch, hosting-expiry 410); a brand/phishing slug is a
      // phishing vector (paypal-login.jiffyapp.dev, …). `candidateSlugs` derives base + base-2..-9,
      // which all share the policy-relevant fragments, so a policy-bad base rejects the whole set.
      if (slugPolicyErrors(candidate).length > 0) continue;
      const slugMod = await cfg.moderation.moderate(candidate);
      if (!slugMod.ok) {
        await parkModerationOutage('slug');
        return;
      }
      if (slugMod.verdict.flagged) continue;
      chosen = candidate;
      break;
    }
    if (chosen === undefined) {
      await parkBriefInvalid(
        formatBriefErrors([
          'every candidate slug was rejected by naming policy or content-safety; please suggest a different slugPreference',
        ]),
      );
      return;
    }
    const ordered = [chosen, ...candidates.filter((candidate) => candidate !== chosen)];
    await cfg.tools.create({
      toolId: crypto.randomUUID(),
      slugCandidates: ordered,
      templateId,
      templateVersion: def.version,
      buildContractId: msg.contractId,
      buildGigId: job.gigId ?? undefined,
      name: brief.name,
      brief,
      goldens,
      notifyEmail: brief.notifyEmail,
    });
    tool = await cfg.tools.getByBuildContract(msg.contractId);
    await cfg.buildLog.append(token, 'tool', 'tool created and slug reserved', {
      slug: tool?.slug,
    });
    await cfg.audit.record({
      scope,
      gate: 'slug',
      result: 'reserved',
      detail: { slug: tool?.slug },
    });
  }
  if (!tool) throw new Error('build job: tools row missing immediately after create');

  let relayCtx: { toolId: string; token: string } | null = null;
  if (isRelayTemplate(def, brief)) {
    const email = brief.notifyEmail;
    if (typeof email !== 'string' || email.length === 0) {
      await parkBriefInvalid(formatBriefErrors(['notifyEmail: required for this template']));
      return;
    }
    const relay = await cfg.relay.ensure(tool.toolId, email);
    relayCtx = { toolId: tool.toolId, token: relay.token };
    if (relay.created) {
      // Cloudflare Email Routing must accept the destination before the send binding will
      // deliver to it — this registers it (it sends its own verification email too).
      await cfg.emailRouting.ensureDestination(email);
      const link = `${cfg.publicBaseUrl}/relay/verify/${relay.verifyToken}`;
      try {
        const sent = await cfg.mailer.send({
          to: email,
          from: cfg.relayFromAddress,
          subject: `Confirm form delivery for ${brief.name}`,
          text:
            `Confirm this address to start receiving form submissions from your JiffyApp tool.\n\n` +
            `Verify: ${link}\n`,
        });
        await cfg.relay.recordEvent({
          toolId: tool.toolId,
          kind: 'verification',
          status: 'sent',
          messageId: sent.messageId ?? undefined,
        });
      } catch (err) {
        // The destination may not be Cloudflare-verified yet, so this send can bounce; the
        // 15-min sweep re-sends once it is. Never fail the build over it.
        cfg.logger.warn({ err }, 'relay: verification email send failed; sweep will retry');
      }
      await cfg.client.sendMessage(scope, relayConfirmMessage(email, brief.name));
    }
    const verified = relay.verified && (await cfg.emailRouting.isDestinationVerified(email));
    if (!verified) {
      await cfg.buildLog.append(token, 'relay', 'awaiting double opt-in verification');
      await cfg.audit.record({ scope, gate: 'relay', result: 'awaiting_verification' });
      await persist();
      await cfg.jobs.park(msg.jobKey, 'awaiting_verification');
      return;
    }
  }

  // ---- Stage 5: codegen → stage → assert → repair loop -----------------------
  const loopResult = await runBuildLoop(cfg, {
    job,
    tool,
    def,
    brief,
    goldens,
    checkpoint,
    msg,
    relayCtx,
    invocationStart: startMs,
    baselineActiveMs,
  });

  if (loopResult.outcome === 'green') {
    await promoteAndDeliver(cfg, {
      job,
      tool,
      def,
      brief,
      goldens,
      slots: loopResult.slots,
      script: loopResult.script,
      contract,
      checkpoint,
    });
    return;
  }
  if (loopResult.outcome === 'caps-exhausted') {
    await abortJob(cfg, { job, tool, reason: loopResult.reason, checkpoint });
    return;
  }
  // 'continuation' | 'parked' — runBuildLoop already re-enqueued or parked; nothing more to do.
}
