// Live reference-check probe (Task 23 / PART B): the Phase-2 calibration + CI-on-live tool.
//
// `runReferenceCheck` renders ONE template's `referenceSlots`, stages the built worker to a
// fixed `stg-ref-<templateId>` slug (which the dispatcher routes via its `stg-` path), runs that
// template's reference goldens through the REAL Playwright factory against the staging URL, runs
// PSI on the clean staging URL, then deletes the staging script. It returns the full JSON —
// per-assertion outcomes, PSI scores, and per-phase timings — so an operator can record the
// numbers for all ten templates and freeze the §9 gate thresholds (README post-deploy loop).
//
// It reuses the pipeline seams (`cfg.deployer` / `cfg.openPage` / `cfg.psi`) rather than
// re-plumbing bindings, so a run here exercises the exact adapters the build pipeline uses.
//
// Relay-family templates (form/waitlist/quiz) run a REDUCED golden set: with `?jiffytest=1` the
// rendered form still POSTs to `/relay/ref-<templateId>`, which 404s (there is no real relay row
// for a reference tool), so the app's happy-path handler shows the error message and the golden
// that expects `success-msg` to become VISIBLE fails through no fault of the template. Those
// success-submission goldens are filtered out (the count is reported as `goldensFiltered`); the
// load-only golden (asserting `success-msg` stays HIDDEN) and the client-side error-path golden
// are kept, since both hold under a 404 relay. Non-relay templates run the full set.

import { ASSERTION_TIMEOUT_MS } from './config.js';
import { runGoldens, type AssertionOutcome } from './assertPlan.js';
import type { PipelineConfig } from './pipeline.js';
import type { PsiResult } from './psi.js';
import { getTemplate } from './templates/registry.js';
import {
  buildToolWorkerScript,
  cspFor,
  type RenderContext,
  type TemplateDefinition,
} from './templates/engine.js';
import type { GoldenExample, GoldenSet, TemplateId } from './types.js';

export interface ReferenceCheckResult {
  templateId: TemplateId;
  templateVersion: string;
  stagingSlug: string;
  render: { files: string[] };
  goldens: { pass: boolean; outcomes: AssertionOutcome[] };
  /** Number of reference goldens skipped for relay templates (success-submission goldens). */
  goldensFiltered: number;
  psi: PsiResult;
  timings: { renderMs: number; deployMs: number; assertMs: number; psiMs: number };
  teardown: 'deleted' | 'failed';
}

/** The form-family templates whose reference render carries a submission relay ctx. */
const RELAY_FAMILY: readonly TemplateId[] = ['form', 'waitlist', 'quiz'];

function isRelayFamily(id: TemplateId): boolean {
  return RELAY_FAMILY.includes(id);
}

/** Fixed staging slug for a template's reference probe. Carries the `stg-` prefix so the
 *  dispatcher's staging path routes it, and is derived from the template id (not a job token)
 *  so a stuck probe is trivially cleaned up by hand. */
export function referenceStagingSlug(templateId: TemplateId): string {
  return `stg-ref-${templateId}`;
}

/** A golden that expects `success-msg` to become VISIBLE — the relay happy-path submission the
 *  reference check can't prove (its 404 relay makes the app show the error path instead). */
function assertsSuccessVisible(golden: GoldenExample): boolean {
  return golden.expect.some(
    (exp) =>
      'visible' in exp && exp.visible === true && 'testid' in exp && exp.testid === 'success-msg',
  );
}

/** For relay templates, drop the success-submission goldens; keep load + error-path goldens.
 *  Non-relay templates run the full set unchanged. */
function filterReferenceGoldens(def: TemplateDefinition): { set: GoldenSet; filtered: number } {
  if (!isRelayFamily(def.id)) {
    return { set: def.referenceGoldens, filtered: 0 };
  }
  const kept = def.referenceGoldens.goldens.filter((g) => !assertsSuccessVisible(g));
  const filtered = def.referenceGoldens.goldens.length - kept.length;
  return { set: { ...def.referenceGoldens, goldens: kept }, filtered };
}

export async function runReferenceCheck(
  cfg: PipelineConfig,
  templateId: TemplateId,
  opts: { now?: () => number } = {},
): Promise<ReferenceCheckResult> {
  const clock = opts.now ?? (cfg.now ? (): number => cfg.now!().getTime() : Date.now);
  const def = getTemplate(templateId);
  const stagingSlug = referenceStagingSlug(templateId);
  const suffix = cfg.toolHostSuffix;
  const cleanUrl = `https://${stagingSlug}.${suffix}`;
  const testUrl = `${cleanUrl}/?jiffytest=1`;

  const ctx: RenderContext = {
    slug: stagingSlug,
    toolUrl: cleanUrl,
    publicBaseUrl: cfg.publicBaseUrl,
    relay: isRelayFamily(templateId)
      ? { toolId: `ref-${templateId}`, token: 'reference-token' }
      : null,
  };

  const logger = cfg.logger.child({ templateId, stagingSlug });

  // Best-effort teardown; captures its own status without masking a thrown probe error.
  let teardown: 'deleted' | 'failed' = 'deleted';
  const teardownStaging = async (): Promise<void> => {
    try {
      await cfg.deployer.deleteScript(stagingSlug);
    } catch (err) {
      teardown = 'failed';
      logger.warn({ err }, 'reference check: staging teardown failed');
    }
  };

  try {
    // ---- Render + build the worker script ------------------------------------
    const renderStart = clock();
    const files = def.render(def.referenceSlots, ctx);
    const script = buildToolWorkerScript(
      files,
      cspFor(ctx, { frameable: templateId === 'widget' }),
    );
    const renderMs = clock() - renderStart;

    // ---- Deploy to staging + confirm it serves -------------------------------
    const deployStart = clock();
    await cfg.deployer.putScript(stagingSlug, script);
    const serves = await cfg.deployer.checkServes(stagingSlug);
    const deployMs = clock() - deployStart;
    if (!serves.ok) {
      throw new Error(
        `reference check: staging ${stagingSlug} did not serve (status ${serves.status})`,
      );
    }

    // ---- Reference goldens against the browser-reachable staging URL ---------
    const { set: goldenSet, filtered: goldensFiltered } = filterReferenceGoldens(def);
    const assertStart = clock();
    const goldenResult = await runGoldens({
      url: testUrl,
      set: goldenSet,
      openPage: cfg.openPage,
      timeoutMs: ASSERTION_TIMEOUT_MS,
    });
    const assertMs = clock() - assertStart;

    // ---- PSI on the clean staging URL ----------------------------------------
    const psiStart = clock();
    const psi = await cfg.psi.run(cleanUrl);
    const psiMs = clock() - psiStart;

    // ---- Teardown + audit ----------------------------------------------------
    await teardownStaging();
    await cfg.audit.record({
      scope: `reference:${templateId}`,
      gate: 'reference-check',
      result: goldenResult.pass ? 'pass' : 'fail',
      detail: {
        goldensFiltered,
        psi: { ok: psi.ok, performance: psi.performance, accessibility: psi.accessibility },
        teardown,
      },
    });

    return {
      templateId,
      templateVersion: def.version,
      stagingSlug,
      render: { files: Object.keys(files) },
      goldens: { pass: goldenResult.pass, outcomes: goldenResult.outcomes },
      goldensFiltered,
      psi,
      timings: { renderMs, deployMs, assertMs, psiMs },
      teardown,
    };
  } catch (err) {
    // Tear down the staging script even when the probe throws (deploy failure, etc.) so a failed
    // run never leaves an orphan script behind, then propagate for the route's 500 branch.
    await teardownStaging();
    throw err;
  }
}
