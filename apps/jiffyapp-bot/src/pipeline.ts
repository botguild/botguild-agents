// Build pipeline — the queue consumer's brain (Task 17: stages 1-6, to GREEN STAGING).
//
// `processJobMessage` dispatches a `JobMessage` by kind: a `build` job runs the full
// codegen → stage → assert → repair loop here; `cycle`/`edit` jobs are logged and skipped
// until Tasks 21/22 wire them (their typed stubs `processCycleJob`/`processEditJob` are
// exported for those tasks to replace).
//
// The build job is CHECKPOINTED and CAPPED: every stage transition appends to the public
// build log and records a gate-audit row, and every controlled exit (park, re-enqueue
// continuation, hand-off to promote, abort) first folds this invocation's ACTIVE time into
// `checkpoint.activeMs` and saves the checkpoint. Parked/waiting time (a buyer verifying
// their email the next day, a moderation-vendor outage) is FREE — only in-invocation active
// time counts toward the FR-6 25-minute wall-clock cap. A THROWN error (a deploy failure, a
// non-serving staging script) is deliberately NOT a controlled exit: it propagates so the
// queue retries the whole message, and no active time is banked for the aborted attempt.
//
// Stages 7-9 (promote → live gates → package/deliver) and the abort leg are Task 18's; this
// module ends by calling the typed stubs `promoteAndDeliver` (on green staging) and
// `abortJob` (on cap/deadline exhaustion), both of which throw `not implemented` for now.

import type { Logger } from 'pino';
import { gigFromContract, type AgentClient, type Contract, type Gig } from '@botguild/agent-core';
import {
  ASSERTION_TIMEOUT_MS,
  CONSUMER_SOFT_BUDGET_MS,
  JOB_WALL_CLOCK_MINUTES,
  MAX_REPAIR_ROUNDS,
  MAX_SPEND_USD,
  MODERATION_ATTEMPTS_BEFORE_NOTICE,
} from './config.js';
import {
  runGoldens,
  type AssertionOutcome,
  type PageDriver,
  type ScreenshotStore,
} from './assertPlan.js';
import type { Codegen } from './codegen.js';
import type { ToolDeployer } from './deploy.js';
import type { ModerationClient } from './moderation.js';
import type { PsiResult } from './psi.js';
import { proposalBindable, type GoldenCompiler } from './goldenCompiler.js';
import { formatBriefErrors } from './brief.js';
import { classifyGig } from './proposer.js';
import { candidateSlugs, stagingSlug } from './slug.js';
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

/** The pipeline only ever reads three things off the platform client; a Pick keeps test
 *  fakes (plain objects) assignable without the class's private fields. */
export type PipelineClient = Pick<AgentClient, 'getContract' | 'getGig' | 'sendMessage'>;

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
}

// --- Constants + copy --------------------------------------------------------

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;
const CAP_MS = JOB_WALL_CLOCK_MINUTES * 60_000;

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
  if (!contentType.startsWith('image/')) return { ok: false, reason: `not an image (${contentType})` };

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

/** Stages 7-9: promote the green-staging build to its live slug, run the live gates, package
 *  the eject ZIP + evidence report, and deliver. Task 18 implements this. */
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
  void cfg;
  void args;
  throw new Error('not implemented: promote');
}

/** The abort leg: tear down staging, refund/close, and message the buyer. Task 18 implements. */
export async function abortJob(
  cfg: PipelineConfig,
  args: {
    job: JobRow;
    tool: ToolRow | null;
    reason: 'caps-exhausted' | 'deadline';
    checkpoint: BuildCheckpoint;
  },
): Promise<void> {
  void cfg;
  void args;
  throw new Error('not implemented: abort');
}

/** Hosting-cycle service report (Task 21). */
export async function processCycleJob(cfg: PipelineConfig, msg: JobMessage): Promise<void> {
  void cfg;
  void msg;
  throw new Error('not implemented: cycle job (Task 21)');
}

/** Thread-driven edit re-gate (Task 22). */
export async function processEditJob(cfg: PipelineConfig, msg: JobMessage): Promise<void> {
  void cfg;
  void msg;
  throw new Error('not implemented: edit job (Task 22)');
}

// --- Dispatch ----------------------------------------------------------------

export async function processJobMessage(cfg: PipelineConfig, msg: JobMessage): Promise<void> {
  if (msg.kind === 'build') return runBuildJob(cfg, msg);
  if (msg.kind === 'cycle') {
    cfg.logger.info({ jobKey: msg.jobKey }, 'cycle job not yet wired (Task 21); skipping');
    return;
  }
  cfg.logger.info({ jobKey: msg.jobKey }, 'edit job not yet wired (Task 22); skipping');
}

// --- Helpers -----------------------------------------------------------------

function screenshotStoreFor(deliverables: DeliverableStore): ScreenshotStore {
  return {
    async put(key, bytes) {
      await deliverables.put(key, bytes, 'image/png');
    },
  };
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
  };
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
    await cfg.buildLog.append(token, 'brief', 'brief could not be validated; parked for correction');
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
    await cfg.audit.record({ scope, gate: 'moderation', result: 'flagged', detail: { stage: 'brief' } });
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
          'every candidate slug was flagged by content-safety; please suggest a different slugPreference',
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
    await cfg.buildLog.append(token, 'tool', 'tool created and slug reserved', { slug: tool?.slug });
    await cfg.audit.record({ scope, gate: 'slug', result: 'reserved', detail: { slug: tool?.slug } });
  }
  if (!tool) throw new Error('build job: tools row missing immediately after create');

  let relayCtx: { toolId: string; token: string } | null = null;
  const isRelayTemplate =
    def.id === 'form' || def.id === 'waitlist' || (def.id === 'quiz' && brief.relayResult === true);
  if (isRelayTemplate) {
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

  // ---- Stage 5: codegen / repair loop ----------------------------------------
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
      await abortJob(cfg, { job, tool, reason: 'deadline', checkpoint });
      return;
    }

    // Soft per-invocation budget ⇒ checkpoint + re-enqueue continuation (designed, not abort).
    if (elapsed() > CONSUMER_SOFT_BUDGET_MS) {
      await cfg.buildLog.append(token, 'continuation', 'soft budget reached; re-enqueuing', { round });
      await persist();
      await cfg.queue.send(msg);
      return;
    }

    // Spend cap ⇒ break to abort.
    if (checkpoint.spendUsd >= MAX_SPEND_USD) break;

    const gen = await cfg.codegen.generate({
      def,
      brief,
      goldens,
      priorSlots: slotValues ?? undefined,
      failures: lastFailures.length > 0 ? lastFailures : undefined,
      escalate: round === MAX_REPAIR_ROUNDS,
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
      lastFailures = gen.errors && gen.errors.length > 0 ? gen.errors : ['codegen produced no valid slots'];
      checkpoint.lastFailures = lastFailures;
      round += 1;
      checkpoint.round = round;
      await persist();
      continue;
    }

    slotValues = gen.slots ?? {};
    checkpoint.slotValues = slotValues;

    // Image re-hosting (link-in-bio avatar / OG images carried as URLs).
    const rehost = await rehostImages(cfg, def, slotValues, scope);
    if (rehost === 'outage') {
      await parkModerationOutage('image');
      return;
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
        return;
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
    await cfg.audit.record({ scope, gate: 'stage', result: 'deployed', detail: { slug: stgSlug, round } });

    // Assert the goldens against the browser-reachable staging URL (test mode on).
    const result = await runGoldens({
      url: `https://${stgSlug}.${cfg.toolHostSuffix}/?jiffytest=1`,
      set: goldens,
      openPage: cfg.openPage,
      timeoutMs: ASSERTION_TIMEOUT_MS,
      screenshots: {
        store: screenshotStoreFor(cfg.deliverables),
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
      await promoteAndDeliver(cfg, {
        job,
        tool,
        def,
        brief,
        goldens,
        slots: slotValues,
        script,
        contract,
        checkpoint,
      });
      return;
    }

    lastFailures = compactFailures(result.outcomes);
    checkpoint.lastFailures = lastFailures;
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

  // ---- Stage 6: caps exhausted ⇒ abort ---------------------------------------
  await cfg.buildLog.append(token, 'caps', 'repair budget exhausted without green staging');
  await cfg.audit.record({
    scope,
    gate: 'caps',
    result: 'cap-exhausted',
    detail: { round, spendUsd: checkpoint.spendUsd },
  });
  await persist();
  await abortJob(cfg, { job, tool, reason: 'caps-exhausted', checkpoint });
}
