// Proposal-time gig classification + the goldens-embedding proposer wrapper (templates
// PRD §2/§3/§8/§12). Sits on top of agent-core's generic `Proposer` (cover note + hybrid
// cost-plus pricing) and adds two JiffyApp-specific things: (1) deciding whether a gig is
// a fresh build, a hosting-cycle renewal, or off-catalog/incomplete and should be skipped,
// and (2) for builds, compiling the golden examples BEFORE the proposal goes out and
// embedding them as the buyer-visible acceptance criteria (§12) — a build never gets
// proposed without goldens the buyer can read and accept.

import type { Gig, ProposalDraft, Proposer } from '@botguild/agent-core';
import type { Logger } from 'pino';
import { briefErrorsForTemplate, extractToolId, matchTemplate, parseJiffyBrief } from './brief.js';
import { EDITS_PER_CYCLE, GRACE_DAYS, HOSTING_WINDOW_DAYS } from './config.js';
import type { GoldenCompiler } from './goldenCompiler.js';
import { proposalBindable } from './goldenCompiler.js';
import { formatGoldenBlock } from './goldens.js';
import type { GigStore } from './gigStore.js';
import { getTemplate } from './templates/registry.js';
import { TEMPLATE_IDS } from './types.js';
import type { JiffyBrief, TemplateId } from './types.js';

function isValidTemplateId(value: string): value is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(value);
}

/** briefErrorsForTemplate's generic checks (name/description/notifyEmail) plus this
 *  template's own `briefErrors` (currently identical for every catalog template, but
 *  kept as two calls per the template contract's "beyond brief.ts basics" intent —
 *  deduped so a template that only delegates doesn't double-report the same error). */
function briefCompletenessErrors(templateId: TemplateId, brief: JiffyBrief): string[] {
  const def = getTemplate(templateId);
  return [...new Set([...briefErrorsForTemplate(templateId, brief), ...def.briefErrors(brief)])];
}

export type ClassifiedGig =
  | { kind: 'cycle'; toolId: string }
  | {
      kind: 'build';
      templateId: TemplateId;
      via: 'explicit' | 'keywords' | 'prose';
      brief: JiffyBrief;
    };

/**
 * Classify a gig for proposal-time handling. Order matters (matches FR-3 / §8 / §13):
 * a `toolId` reference always means a hosting-cycle renewal, checked before anything
 * else parses the description as a fresh brief. Absent that, a fenced JSON brief is
 * preferred; when none parses, PROSE gigs (title/description alone, no JSON at all)
 * still get a shot via keyword matching against synthesized `{ name, description }` —
 * relay templates (form/waitlist) fall out of this naturally as incomplete, since a
 * prose brief can never carry a `notifyEmail`.
 */
export function classifyGig(gig: Gig): ClassifiedGig | { kind: 'skip'; reason: string } {
  const toolId = extractToolId(gig.description);
  if (toolId) return { kind: 'cycle', toolId };

  const gigText = `${gig.title} ${gig.description}`;
  const parsed = parseJiffyBrief(gig.description);

  if (!parsed.ok) {
    const match = matchTemplate(null, gigText);
    if (!match) return { kind: 'skip', reason: 'no-brief' };

    const brief: JiffyBrief = { name: gig.title, description: gig.description };
    const errors = briefCompletenessErrors(match.templateId, brief);
    if (errors.length > 0) {
      return { kind: 'skip', reason: `incomplete-brief: ${errors.join('; ')}` };
    }
    return { kind: 'build', templateId: match.templateId, via: 'prose', brief };
  }

  const brief = parsed.brief;
  if (brief.template !== undefined && !isValidTemplateId(brief.template)) {
    return { kind: 'skip', reason: `invalid-template: ${brief.template}` };
  }

  const match = matchTemplate(brief, gigText);
  if (!match) return { kind: 'skip', reason: 'off-catalog' };

  const errors = briefCompletenessErrors(match.templateId, brief);
  if (errors.length > 0) {
    return { kind: 'skip', reason: `incomplete-brief: ${errors.join('; ')}` };
  }
  return { kind: 'build', templateId: match.templateId, via: match.via, brief };
}

export interface JiffyProposerDeps {
  base: Proposer; // agent-core createProposer output (with costEstimator wired)
  compiler: GoldenCompiler;
  gigs: GigStore;
  logger: Logger;
}

const HOSTING_TERMS =
  `Hosting terms for this cycle: the tool is served on its jiffyapp.dev URL for a ` +
  `${HOSTING_WINDOW_DAYS}-day service window while this cycle stays funded, with up to ` +
  `${EDITS_PER_CYCLE} re-gated edits included. If a new cycle isn't funded before the window ` +
  `ends, there is a ${GRACE_DAYS}-day grace period; after that the URL serves a 410 with eject ` +
  `instructions (the full source ZIP was already delivered at build time). Revive service any ` +
  `time by funding a new hosting cycle with the same toolId.`;

export function createJiffyProposer(deps: JiffyProposerDeps): {
  proposeBuild(
    gig: Gig,
    classified: Extract<ClassifiedGig, { kind: 'build' }>,
  ): Promise<ProposalDraft | null>;
  proposeCycle(
    gig: Gig,
    classified: Extract<ClassifiedGig, { kind: 'cycle' }>,
  ): Promise<ProposalDraft>;
} {
  return {
    async proposeBuild(gig, classified): Promise<ProposalDraft | null> {
      const def = getTemplate(classified.templateId);
      const bindable = proposalBindable(def, classified.brief);
      const compiled = await deps.compiler.compile(classified.brief, def, bindable);

      if (!compiled.ok) {
        deps.logger.warn(
          {
            gigId: gig.id,
            templateId: classified.templateId,
            errors: compiled.errors,
            costUsd: compiled.costUsd,
          },
          'golden compiler could not produce a valid golden set; skipping proposal',
        );
        return null;
      }

      const draft = await deps.base.generateProposal(gig);
      const goldenBlock = formatGoldenBlock({
        templateId: classified.templateId,
        templateVersion: def.version,
        set: compiled.set,
      });
      draft.assumptions = [...(draft.assumptions ?? []), goldenBlock];

      await deps.gigs.saveBuild({
        gigId: gig.id,
        templateId: classified.templateId,
        templateVersion: def.version,
        brief: classified.brief,
        goldens: compiled.set,
      });

      return draft;
    },

    async proposeCycle(gig, classified): Promise<ProposalDraft> {
      const draft = await deps.base.generateProposal(gig);
      draft.assumptions = [...(draft.assumptions ?? []), HOSTING_TERMS];
      await deps.gigs.saveCycle({ gigId: gig.id, toolId: classified.toolId });
      return draft;
    },
  };
}
