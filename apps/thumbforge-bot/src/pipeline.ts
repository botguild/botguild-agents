// ---------------------------------------------------------------------------
// Async render pipeline (§6, §9) — the RENDER_QUEUE consumer core.
//
// Default: one queue message per graphic (§7/§12), so a pack fans out. A `plan`
// message resolves the gig into a per-graphic RenderPlan and fans out `graphic`
// messages; each `graphic` message renders → runs the §9 in-process gates → PUTs
// to R2 → reads back for byte-equality, then records the output. When every
// planned graphic has an output, the completion step reconciles (FR-13), runs
// the A/B distinctness gate for thumbnails, invokes the PROBE service binding to
// verify each URL (blocking `deliverMilestone` on async paths, §9), and delivers
// the URLs + the editable-template artifact.
//
// Storage and the URL probe are structural seams so the pipeline stays free of
// Workers globals; index.ts binds them to R2 + the PROBE service binding.
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import type { AgentClient, Contract } from '@botguild/agent-core';
import { renderLayout, type RenderOutput } from './render/index.js';
import type { EncodeResult } from './render/encodeTypes.js';
import type { WasmSources } from './render/wasm.js';
import type { FontSet } from './fonts/index.js';
import { LAYOUTS } from './layouts/index.js';
import { pHash, hammingDistance } from './gates/phash.js';
import { reconcile } from './gates/reconcile.js';
import { serializeTemplate, checkTemplate } from './gates/template.js';
import { runGates, type GateReport } from './gateRun.js';
import { headlineRejectionMessage } from './headline.js';
import type { Moderator } from './moderation.js';
import {
  AB_MIN_PHASH_DISTANCE,
  ASYNC_MODERATION_BUDGET_MS,
  MAX_FILE_BYTES,
  JPEG_QUALITY_FLOOR,
} from './config.js';
import {
  buildSocialPackPlan,
  buildThumbnailPlan,
  parseBrief,
} from './brief.js';
import type {
  AuditStore,
  GraphicSpec,
  OutputStore,
  RenderJobStore,
  RenderPlan,
} from './jobs.js';

/** Injected wasm + fonts for the render core (§7). */
export interface RenderContext {
  fonts: FontSet;
  wasm: WasmSources;
}

/** R2 seam: write, and read back for the §9 byte-equality reachability leg. */
export interface DeliverableStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getBytes(key: string): Promise<Uint8Array | null>;
}

/** The URL-probe leg (§9) — bound to the PROBE service binding in index.ts. */
export interface UrlProbe {
  probe(url: string): Promise<{ status: number; byteLength: number; ok: boolean }>;
}

/** Re-enqueue seam so the plan step can fan out graphic messages. */
export interface RenderQueueLike {
  send(message: RenderMessage): Promise<unknown>;
}

export type RenderMessage =
  | { kind: 'plan'; contractId: string; jobKey: string }
  | { kind: 'graphic'; jobKey: string; graphicId: string };

export interface PipelineConfig {
  renderJobs: RenderJobStore;
  outputs: OutputStore;
  audit: AuditStore;
  client: AgentClient;
  render: RenderContext;
  storage: DeliverableStorage;
  probe: UrlProbe;
  /** Blocking moderation (FR-14) over the resolved headline/copy before any render. */
  moderator: Moderator;
  queue: RenderQueueLike;
  /** YouTube headline resolver (FR-4); returns a headline or null. */
  resolveHeadline?: (videoId: string) => Promise<string | null>;
  /** Public base URL of this Worker — deliverable URLs are Worker-served (FR-11). */
  publicBaseUrl: string;
  logger: Logger;
  now?: () => Date;
}

const contentTypeFor = (format: 'png' | 'jpeg'): string => (format === 'png' ? 'image/png' : 'image/jpeg');
const extFor = (format: 'png' | 'jpeg'): string => (format === 'png' ? 'png' : 'jpg');

// --- Message dispatch --------------------------------------------------------

export async function processRenderMessage(cfg: PipelineConfig, msg: RenderMessage): Promise<void> {
  if (msg.kind === 'plan') return processPlanMessage(cfg, msg);
  return processGraphicMessage(cfg, msg);
}

/** Resolve the gig into a RenderPlan and fan out one `graphic` message each. */
async function processPlanMessage(
  cfg: PipelineConfig,
  msg: Extract<RenderMessage, { kind: 'plan' }>,
): Promise<void> {
  const logger = cfg.logger.child({ contractId: msg.contractId, jobKey: msg.jobKey });
  const job = await cfg.renderJobs.get(msg.jobKey);
  if (!job) {
    logger.warn('plan message for unknown job, dropping');
    return;
  }
  if (job.plan) {
    logger.info('job already planned, re-enqueueing any missing graphics');
    await fanOut(cfg, msg.jobKey, job.plan);
    return;
  }

  const contract = await cfg.client.getContract(msg.contractId);
  const gig = await cfg.client.getGig(contract.gigId);
  const brief = parseBrief(gig.description ?? '');
  if (!brief) {
    await cfg.client.sendMessage(
      msg.contractId,
      'I could not find a job brief in this gig description. Please post the JSON brief (brand kit + job inputs) ' +
        'per the ThumbForge onboarding template so I can render your graphics.',
    );
    await cfg.renderJobs.reject(msg.jobKey, 'brief_missing');
    return;
  }

  const milestone = findFundedMilestone(contract);

  let plan: RenderPlan;
  if (brief.jobType === 'thumbnail') {
    let headline = brief.thumbnail?.headline ?? '';
    if (!headline && brief.thumbnail?.videoId && cfg.resolveHeadline) {
      headline = (await cfg.resolveHeadline(brief.thumbnail.videoId)) ?? '';
    }
    plan = buildThumbnailPlan(brief.brandKit, headline || 'Watch now');
  } else {
    const pack = brief.socialPack ?? { copy: [], count: 10, formats: ['feed', 'story'] };
    plan = buildSocialPackPlan(brief.brandKit, pack);
  }

  // FR-14 (blocking, fail-closed): moderate the resolved copy — for thumbnails
  // this is exactly the auto-pulled YouTube title (FR-4) — before any render or
  // delivery. Never deliver unmoderated content. `flagged` rejects the job;
  // `unavailable` throws so the queue retries (and DLQs if persistent) rather
  // than delivering unscreened or discarding a paid job on a transient outage.
  if (!(await moderatePlanOrReject(cfg, logger, msg.contractId, msg.jobKey, brief.jobType, plan))) return;

  await cfg.renderJobs.savePlan(msg.jobKey, { kind: plan.kind, milestoneId: milestone.id, plan });
  await cfg.audit.record({ scope: msg.jobKey, gate: 'plan', result: 'ok', detail: { kind: plan.kind, count: plan.graphics.length } });
  logger.info({ kind: plan.kind, graphics: plan.graphics.length }, 'render plan built, fanning out');
  await fanOut(cfg, msg.jobKey, plan);
}

async function fanOut(cfg: PipelineConfig, jobKey: string, plan: RenderPlan): Promise<void> {
  const done = new Set((await cfg.outputs.list(jobKey)).map((o) => o.graphicId));
  for (const graphic of plan.graphics) {
    if (done.has(graphic.graphicId)) continue;
    await cfg.queue.send({ kind: 'graphic', jobKey, graphicId: graphic.graphicId });
  }
}

/**
 * FR-14 blocking moderation for the async gig paths. Screens the distinct copy
 * lines the plan will render (headlines / social-pack copy — the auto-pulled
 * YouTube title on thumbnail jobs). Returns false when the caller must stop:
 * `flagged` rejects the job and messages the buyer; `unavailable` throws (fail
 * closed — the queue retries, then DLQs, never delivering unmoderated content).
 */
async function moderatePlanOrReject(
  cfg: PipelineConfig,
  logger: Logger,
  contractId: string,
  jobKey: string,
  jobType: string,
  plan: RenderPlan,
): Promise<boolean> {
  const copy = [...new Set(plan.graphics.map((g) => g.inputs.headline).filter((h): h is string => !!h))].join('\n');
  if (!copy) return true;

  const moderation = await cfg.moderator.moderate(copy, ASYNC_MODERATION_BUDGET_MS);
  await cfg.audit.record({ scope: jobKey, gate: 'moderation', result: moderation.status });

  if (moderation.status === 'flagged') {
    await cfg.client.sendMessage(
      contractId,
      `I stopped before rendering: the ${jobType === 'thumbnail' ? 'headline' : 'copy'} was flagged by my ` +
        `content-safety review (${moderation.reason}). I never deliver unmoderated or flagged content. ` +
        'Please revise the brief and re-fund, or cancel this contract to release escrow.',
    );
    await cfg.renderJobs.reject(jobKey, 'moderation_flagged');
    logger.warn({ reason: moderation.reason }, 'copy flagged by moderation — job rejected (FR-14)');
    return false;
  }

  if (moderation.status === 'unavailable') {
    // Fail closed: never deliver unmoderated. Throwing lets the queue retry a
    // transient outage (DLQ if persistent) instead of discarding a paid job.
    throw new Error(`moderation unavailable at plan time: ${moderation.detail}`);
  }
  return true;
}

/** Render one graphic, gate it, PUT + read-back, record the output, then try completion. */
async function processGraphicMessage(
  cfg: PipelineConfig,
  msg: Extract<RenderMessage, { kind: 'graphic' }>,
): Promise<void> {
  const logger = cfg.logger.child({ jobKey: msg.jobKey, graphicId: msg.graphicId });
  const job = await cfg.renderJobs.get(msg.jobKey);
  if (!job?.plan) {
    logger.warn('graphic message before plan, dropping (plan step will re-fan-out)');
    return;
  }
  if (job.status === 'delivered' || job.status === 'rejected') {
    logger.info({ status: job.status }, 'job already terminal, acking graphic replay');
    return;
  }

  const spec = job.plan.graphics.find((g) => g.graphicId === msg.graphicId);
  if (!spec) {
    logger.warn('graphic id not in plan, dropping');
    return;
  }

  const existing = await cfg.outputs.list(msg.jobKey);
  if (existing.some((o) => o.graphicId === msg.graphicId)) {
    logger.info('graphic already rendered, proceeding to completion check');
    await tryComplete(cfg, msg.jobKey);
    return;
  }

  const rendered = await renderGraphic(cfg, spec);

  // FR-6: a headline that cannot fit at/above the floor rejects the whole job —
  // never shrink below the floor.
  if (!rendered.gates.headline.accept) {
    await cfg.audit.record({
      scope: msg.jobKey,
      graphicId: msg.graphicId,
      gate: 'headline-fit',
      result: 'reject',
      detail: rendered.gates.headline,
    });
    await cfg.client.sendMessage(job.contractId, headlineRejectionMessage(rendered.gates.headline));
    await cfg.renderJobs.reject(msg.jobKey, 'headline_min_font');
    logger.warn({ headline: rendered.gates.headline }, 'headline below min font — job rejected (FR-6)');
    return;
  }

  await cfg.audit.record({
    scope: msg.jobKey,
    graphicId: msg.graphicId,
    gate: 'render-gates',
    result: rendered.gates.pass ? 'pass' : 'fail',
    detail: gateSummary(rendered.gates),
  });

  if (!rendered.gates.pass) {
    // A blocking gate other than headline fit failed — abort honestly (the
    // 14-day warranty covers a re-render); do not ship a sub-spec image.
    await cfg.client.sendMessage(
      job.contractId,
      `I stopped before delivering graphic ${msg.graphicId}: it failed a blocking spec gate ` +
        `(${JSON.stringify(gateSummary(rendered.gates))}). I never ship an image that misses a declared gate. ` +
        'Please cancel this contract to release escrow, or adjust the brief and re-fund.',
    );
    await cfg.renderJobs.reject(msg.jobKey, 'gate_fail');
    return;
  }

  // §9 reachability (a): PUT then read back and byte-compare via the binding.
  const r2Key = `${msg.jobKey}/${msg.graphicId}.${extFor(rendered.format)}`;
  await cfg.storage.put(r2Key, rendered.bytes, contentTypeFor(rendered.format));
  const readBack = await cfg.storage.getBytes(r2Key);
  if (!readBack || !bytesEqual(readBack, rendered.bytes)) {
    // A failed read-back is an infra fault, not a job state — throw so the queue
    // retries (and, if persistent, the DLQ alerts).
    throw new Error(`R2 read-back byte-equality failed for ${r2Key}`);
  }

  const url = `${cfg.publicBaseUrl.replace(/\/$/, '')}/a/${r2Key}`;
  await cfg.outputs.save({
    jobKey: msg.jobKey,
    graphicId: msg.graphicId,
    templateId: spec.templateId,
    format: spec.format,
    r2Key,
    url,
    byteLength: rendered.bytes.byteLength,
    phash: rendered.phash.toString(),
    gatePass: true,
  });
  logger.info({ url, bytes: rendered.bytes.byteLength, format: rendered.format }, 'graphic rendered + stored + verified');

  await tryComplete(cfg, msg.jobKey);
}

export interface RenderedGraphic {
  out: RenderOutput;
  gates: GateReport;
  encoded: EncodeResult;
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
  phash: bigint;
}

/** Render + encode + gate one graphic (no I/O — pure over the injected assets). */
export async function renderSpec(render: RenderContext, spec: GraphicSpec): Promise<RenderedGraphic> {
  const layout = LAYOUTS[spec.templateId];
  if (!layout) throw new Error(`unknown templateId: ${spec.templateId}`);

  const out = await renderLayout(layout, { brandKit: spec.brandKit, job: spec.inputs }, render);
  const encoded = await out.encode({ maxBytes: MAX_FILE_BYTES, jpegQualityFloor: JPEG_QUALITY_FLOOR });
  const gates = runGates(layout, spec.brandKit, out, encoded);
  return { out, gates, encoded, bytes: encoded.bytes, format: encoded.format, phash: pHash(out.pixmap) };
}

/** Render one planned graphic using the pipeline's injected render context. */
export function renderGraphic(cfg: PipelineConfig, spec: GraphicSpec): Promise<RenderedGraphic> {
  return renderSpec(cfg.render, spec);
}

/** Deliver once every planned graphic has a verified output (§9 completion). */
async function tryComplete(cfg: PipelineConfig, jobKey: string): Promise<void> {
  const job = await cfg.renderJobs.get(jobKey);
  if (!job?.plan || job.status === 'delivered' || job.status === 'rejected') return;

  const outputs = await cfg.outputs.list(jobKey);
  const expected = job.plan.graphics.map((g) => g.graphicId);
  if (outputs.length < expected.length) return; // not all graphics done yet

  const logger = cfg.logger.child({ contractId: job.contractId, jobKey });

  // FR-13 reconciliation: exactly one output per planned graphic.
  const reconciliation = reconcile(
    expected,
    outputs.map((o) => ({ inputKey: o.graphicId })),
  );
  await cfg.audit.record({ scope: jobKey, gate: 'reconcile', result: reconciliation.pass ? 'pass' : 'fail', detail: reconciliation });
  if (!reconciliation.pass) throw new Error(`reconciliation failed: ${JSON.stringify(reconciliation)}`);

  // A/B distinctness (§9): the two thumbnail variants must clear the pHash
  // distance AND be distinct templates.
  if (job.kind === 'thumbnail' && outputs.length === 2) {
    const [a, b] = outputs as [(typeof outputs)[number], (typeof outputs)[number]];
    const distance = hammingDistance(BigInt(a.phash), BigInt(b.phash));
    const distinct = a.templateId !== b.templateId;
    const abPass = distance >= AB_MIN_PHASH_DISTANCE && distinct;
    await cfg.audit.record({
      scope: jobKey,
      gate: 'ab-distinct',
      result: abPass ? 'pass' : 'fail',
      detail: { distance, minDistance: AB_MIN_PHASH_DISTANCE, distinctTemplates: distinct },
    });
    if (!abPass) {
      await cfg.client.sendMessage(
        job.contractId,
        `The two thumbnail variants did not clear the declared A/B distinctness threshold ` +
          `(pHash distance ${distance}, need ≥ ${AB_MIN_PHASH_DISTANCE}; distinct templates: ${distinct}). ` +
          'Re-rendering under the 14-day warranty; I will not deliver near-identical variants.',
      );
      await cfg.renderJobs.reject(jobKey, 'ab_not_distinct');
      return;
    }
  }

  // Editable-template artifact (§9, US-1 AC3): the Satori JSON source of the
  // primary layout, gated on presence + parse, then PUT to R2 with a read-back
  // byte-equality check (same discipline as the images) and served on the
  // custom-domain /a/:key route so the buyer actually RECEIVES the openable
  // layout source — the delivery note's "attached" claim must be true (§6 step 9).
  const primary = job.plan.graphics[0] as GraphicSpec;
  const artifact = serializeTemplate(LAYOUTS[primary.templateId], primary.brandKit, primary.inputs);
  const templateCheck = checkTemplate(artifact);
  await cfg.audit.record({ scope: jobKey, gate: 'template', result: templateCheck.pass ? 'pass' : 'fail' });
  if (!templateCheck.pass) throw new Error(`template artifact failed its own gate: ${templateCheck.error}`);
  await cfg.renderJobs.saveTemplateArtifact(jobKey, artifact);

  const artifactKey = `${jobKey}/template.json`;
  const artifactBytes = new TextEncoder().encode(artifact);
  await cfg.storage.put(artifactKey, artifactBytes, 'application/json');
  const artifactReadBack = await cfg.storage.getBytes(artifactKey);
  if (!artifactReadBack || !bytesEqual(artifactReadBack, artifactBytes)) {
    throw new Error(`R2 read-back byte-equality failed for ${artifactKey}`);
  }
  const artifactUrl = `${cfg.publicBaseUrl.replace(/\/$/, '')}/a/${artifactKey}`;

  // §9 reachability (b): probe every delivered URL from the probe Worker — this
  // BLOCKS deliverMilestone on the async paths.
  for (const output of outputs) {
    const result = await cfg.probe.probe(output.url);
    await cfg.audit.record({ scope: jobKey, graphicId: output.graphicId, gate: 'url-probe', result: result.ok ? 'pass' : 'fail', detail: result });
    if (!result.ok) throw new Error(`URL probe failed for ${output.url}: status ${result.status}`);
  }

  // Atomically win the completion transition before delivering (§9): each
  // graphic is its own queue message, so two concurrent invocations can both
  // reach here — only the one that flips the row calls deliverMilestone.
  if (!(await cfg.renderJobs.claimForDelivery(jobKey))) {
    logger.info('completion already claimed by a concurrent invocation, acking');
    return;
  }

  const urls = outputs.map((o) => o.url);
  const attachments = [...urls, artifactUrl];
  const note = buildDeliveryNote(job.kind, outputs.length, urls, artifactUrl, artifact.length);
  try {
    const milestoneId = job.milestoneId ?? findFundedMilestone(await cfg.client.getContract(job.contractId)).id;
    await cfg.client.deliverMilestone(job.contractId, milestoneId, { note, attachments });
    await cfg.renderJobs.markDelivered(jobKey, 'delivered');
  } catch (err) {
    // Delivery threw after we won the claim — undo it so a queue retry can
    // re-attempt delivery instead of the job wedging as delivered-but-unsent.
    await cfg.renderJobs.reopenForDelivery(jobKey);
    throw err;
  }
  logger.info({ delivered: outputs.length, kind: job.kind }, 'render job delivered');
}

// --- helpers -----------------------------------------------------------------

function buildDeliveryNote(
  kind: string | null,
  count: number,
  urls: string[],
  artifactUrl: string,
  artifactBytes: number,
): string {
  const list = urls.map((u, i) => `- Graphic ${i + 1}: ${u}`).join('\n');
  return (
    `## ThumbForge delivery — ${count} ${kind === 'thumbnail' ? 'A/B thumbnail variant(s)' : 'graphic(s)'}\n\n` +
    `Every image is byte-verified: exact pixel dimensions, <2MB (PNG lossless, JPEG only if forced, ≥ the quality ` +
    `floor), brand color within ΔE at the declared swatch regions, headline at/above the minimum font size, and the ` +
    `logo present with a clear z-order.\n\n${list}\n\n` +
    `The editable Satori template artifact (JSON layout source, openable without any vendor account, ` +
    `${artifactBytes} bytes) is attached to this delivery:\n- Template: ${artifactUrl}`
  );
}

function gateSummary(gates: GateReport): Record<string, unknown> {
  return {
    dimensions: gates.dimensions.pass,
    fileSize: { pass: gates.fileSize.pass, reason: gates.fileSize.reason, bytes: gates.fileSize.byteLength },
    color: { pass: gates.color.pass, maxDeltaE: gates.color.maxDeltaE },
    logo: { pass: gates.logo.pass, similarity: gates.logo.similarity, zOrderClear: gates.logo.zOrderClear },
    headline: { accept: gates.headline.accept, fontPx: gates.headline.fontPx },
  };
}

/** Full byte comparison for R2 write-then-read byte-equality (§9). Exported so
 *  the sync OG path (ogSync.ts) asserts identical bytes, not just length. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function findFundedMilestone(contract: Contract): { id: string } {
  const milestone = contract.milestones.find((m) => m.status === 'funded');
  if (!milestone) throw new Error(`contract ${contract.id} has no funded milestone`);
  return milestone;
}
