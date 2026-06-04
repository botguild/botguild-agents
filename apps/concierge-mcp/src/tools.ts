// ---------------------------------------------------------------------------
// MCP tool surface for the payer concierge.
//
// The payer's own assistant (Claude) is the brain — it understands intent and
// writes/revises gig text. These tools supply the BotGuild-specific knowledge
// (the reference-bot catalog, deterministic budgets, the scorer run in reverse)
// and the platform actions (post a gig, fund escrow). The two write actions are
// gated on an explicit `confirm` flag so nothing is posted or funded without
// approval, on top of the MCP client's own tool-approval prompt.
// ---------------------------------------------------------------------------

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { ConciergeConfig } from './config.js';
import type { PayerClient } from './payerClient.js';
import { PayerError } from './payerClient.js';
import { CATALOG, getBot, rankBots, type BotProfile } from './catalog.js';
import { suggestBudget } from './budget.js';
import { draftGigShape, scoreDraft, DraftGigSchema, type DraftGig } from './draft.js';

export interface ToolContext {
  config: ConciergeConfig;
  payer: PayerClient | null;
  logger: Logger;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

function resolveBot(category: string | undefined, explicit?: string): BotProfile {
  if (explicit) {
    const b = getBot(explicit);
    if (b) return b;
  }
  if (category) {
    const byCat = CATALOG.find((b) => b.scorer.categories.includes(category));
    if (byCat) return byCat;
  }
  return CATALOG[0];
}

function renderScore(draft: DraftGig, bot: BotProfile): string {
  const s = scoreDraft(draft, bot.scorer, bot.name);
  const b = s.breakdown;
  const lines = [
    `Scored against ${bot.name} (bid threshold ${bot.scorer.proposalThreshold}/100):`,
    ``,
    `  category   ${b.category}/40`,
    `  budget     ${b.budget}/20`,
    `  warranty   ${b.warranty}/15`,
    `  clarity    ${b.clarity}/15`,
    `  timeline   ${b.timeline}/10`,
    `  ─────────────────`,
    `  TOTAL      ${b.total}/100`,
    ``,
    s.verdict,
  ];
  if (s.gaps.length) {
    lines.push(``, 'To improve the score:');
    s.gaps.forEach((g) => lines.push(`  • ${g}`));
  }
  return lines.join('\n');
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  // --- recommend_bot -------------------------------------------------------
  server.registerTool(
    'recommend_bot',
    {
      title: 'Recommend a bot',
      description:
        'Given a free-text description of what the payer needs done, recommend which BotGuild reference bot fits best, with what it can and cannot do.',
      inputSchema: { need: z.string().describe('What the payer wants done, in their own words') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ need }): Promise<ToolResult> => {
      const ranked = rankBots(need);
      const top = ranked[0];
      if (top.score === 0) {
        return ok(
          `No strong match among the reference bots for: "${need}".\n\n` +
            CATALOG.map((b) => `• ${b.name} — ${b.tagline}`).join('\n') +
            `\n\nAsk the payer which of these is closest, or whether they need a custom bot.`,
        );
      }
      const lines = [
        `Best fit: ${top.bot.name} — ${top.bot.tagline}`,
        ``,
        `Can do:`,
        ...top.bot.canDo.map((c) => `  ✓ ${c}`),
        `Not a fit for:`,
        ...top.bot.cantDo.map((c) => `  ✗ ${c}`),
        ``,
        `Suggested category for the gig: ${top.bot.scorer.categories[0]}`,
      ];
      const alts = ranked.slice(1).filter((m) => m.score > 0);
      if (alts.length) lines.push(``, `Alternatives: ${alts.map((m) => m.bot.name).join(', ')}`);
      return ok(lines.join('\n'));
    },
  );

  // --- suggest_budget ------------------------------------------------------
  server.registerTool(
    'suggest_budget',
    {
      title: 'Suggest a budget',
      description:
        'Suggest a deterministic budget and milestone split for a gig, based on the target bot’s pricing band. Pricing is never AI-generated. Returns guidance the payer can adjust.',
      inputSchema: {
        bot: z.string().describe('Target bot id or name (e.g. "sentinel-bot" or "FlowBot")'),
        scope: z.enum(['small', 'medium', 'large']).describe('Rough size of the job'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ bot, scope }): Promise<ToolResult> => {
      const profile = getBot(bot);
      if (!profile)
        return fail(`Unknown bot "${bot}". Known: ${CATALOG.map((b) => b.id).join(', ')}.`);
      const s = suggestBudget(profile, scope);
      const ms = s.milestones.map((m) => `  • ${m.title}`).join('\n');
      return ok(
        `Suggested total: $${s.total} (${s.scope})\n\nMilestone checkpoints:\n${ms}\n\n${s.rationale}`,
      );
    },
  );

  // --- score_gig (the scorer, run in reverse) ------------------------------
  server.registerTool(
    'score_gig',
    {
      title: 'Score a gig draft',
      description:
        'Run BotGuild’s 5-factor scorer over a gig draft and return the breakdown plus concrete gaps to fix. This is the same scorer the bots use to decide whether to bid — a high score means bots will compete and the spec is clear enough to avoid disputes. Iterate the draft until it is fundable, then call create_gig.',
      inputSchema: {
        ...draftGigShape,
        bot: z
          .string()
          .optional()
          .describe('Score against this bot (id/name); inferred from category if omitted'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args): Promise<ToolResult> => {
      const { bot, ...draftFields } = args;
      const parsed = DraftGigSchema.safeParse(draftFields);
      if (!parsed.success)
        return fail(`Invalid draft: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      const profile = resolveBot(parsed.data.category, bot);
      return ok(renderScore(parsed.data, profile));
    },
  );

  // --- create_gig (write — gated) ------------------------------------------
  server.registerTool(
    'create_gig',
    {
      title: 'Post a gig',
      description:
        'Post a gig to the BotGuild marketplace on the payer’s behalf. SAFETY: this only posts when confirm=true. Call it first WITHOUT confirm to preview the gig and its score, show that to the payer, get explicit approval, then call again with confirm=true.',
      inputSchema: {
        ...draftGigShape,
        bot: z.string().optional().describe('Bot to score against before posting (id/name)'),
        confirm: z
          .boolean()
          .optional()
          .describe('Must be true to actually post. Omit/false = preview only.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args): Promise<ToolResult> => {
      const { bot, confirm, ...draftFields } = args;
      const parsed = DraftGigSchema.safeParse(draftFields);
      if (!parsed.success)
        return fail(`Invalid draft: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      const draft = parsed.data;
      const profile = resolveBot(draft.category, bot);

      if (!confirm) {
        return ok(
          `PREVIEW — nothing posted yet.\n\n` +
            `Title: ${draft.title}\nCategory: ${draft.category}\nBudget: $${draft.budget}\nTimeline: ${draft.timeline}\n` +
            `Acceptance criteria:\n${draft.acceptanceCriteria.map((c) => `  • ${c}`).join('\n')}\n` +
            `Deliverables:\n${draft.deliverables.map((d) => `  • ${d}`).join('\n')}\n\n` +
            `${renderScore(draft, profile)}\n\n` +
            `→ Show this to the payer. To post it, call create_gig again with confirm: true.`,
        );
      }

      if (!ctx.payer) {
        return fail(
          'Cannot post: no BOTGUILD_API_KEY configured. Set a payer API key in the server env to enable posting. ' +
            '(Drafting and scoring work without a key.)',
        );
      }
      // Hard completeness gate — score_gig is lenient so it can critique early
      // drafts, but a gig this incomplete should never reach the marketplace.
      const missing: string[] = [];
      if (!draft.category.trim()) missing.push('category');
      if (!draft.timeline.trim()) missing.push('timeline');
      if (draft.acceptanceCriteria.length === 0) missing.push('acceptanceCriteria');
      if (draft.deliverables.length === 0) missing.push('deliverables');
      if (draft.budget <= 0) missing.push('budget');
      if (missing.length) {
        return fail(
          `Refusing to post — the gig is missing: ${missing.join(', ')}. Complete it, re-preview, then confirm.`,
        );
      }
      const score = scoreDraft(draft, profile.scorer, profile.name);
      try {
        const created = await ctx.payer.createGig(draft);
        ctx.logger.info({ gigId: created.id }, 'gig posted');
        const warn = score.fundable
          ? ''
          : `\n\n⚠️ Note: this scored ${score.breakdown.total}/100, below ${profile.name}'s bid threshold — bots may not pick it up. Consider improving it.`;
        return ok(
          `Posted ✅ Gig ${created.id}${created.status ? ` (status: ${created.status})` : ''}.${warn}\n\nNext: fund the first milestone's escrow so a bot can start. Use list_my_gigs / fund_milestone.`,
        );
      } catch (e) {
        return fail(toErr('post the gig', e));
      }
    },
  );

  // --- fund_milestone (write — gated) --------------------------------------
  server.registerTool(
    'fund_milestone',
    {
      title: 'Fund a milestone',
      description:
        'Fund a contract milestone’s escrow, which releases the bot to start that stage. SAFETY: this moves money and only runs when confirm=true. Preview first (confirm omitted), show the payer, then confirm.',
      inputSchema: {
        contractId: z.string().describe('Contract id'),
        milestoneId: z.string().describe('Milestone id to fund'),
        confirm: z
          .boolean()
          .optional()
          .describe('Must be true to actually fund. Omit/false = preview only.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ contractId, milestoneId, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return ok(
          `PREVIEW — no funds moved.\n\nWould fund milestone ${milestoneId} on contract ${contractId}, ` +
            `releasing the bot to start that stage.\n\n→ Confirm with the payer, then call again with confirm: true.`,
        );
      }
      if (!ctx.payer) return fail('Cannot fund: no BOTGUILD_API_KEY configured.');
      try {
        const res = await ctx.payer.fundMilestone(contractId, milestoneId);
        ctx.logger.info({ contractId, milestoneId }, 'milestone funded');
        return ok(
          `Funded ✅ Milestone ${milestoneId}${res.status ? ` (status: ${res.status})` : ''}. The bot can now start this stage.`,
        );
      } catch (e) {
        return fail(toErr('fund the milestone', e));
      }
    },
  );

  // --- submit_review (write — gated) ---------------------------------------
  server.registerTool(
    'submit_review',
    {
      title: 'Review a bot',
      description:
        'Leave a 1–5 star rating and short written review for the bot on a contract the payer has accepted. This is public reputation that other payers see, so it only posts when confirm=true. Preview first (confirm omitted), show the payer the rating + text, then confirm. One review per contract.',
      inputSchema: {
        contractId: z.string().describe('Contract id the payer accepted'),
        rating: z.number().int().min(1).max(5).describe('Star rating, 1 (worst) to 5 (best)'),
        text: z.string().min(1).describe('Short written review the payer wants to leave'),
        confirm: z
          .boolean()
          .optional()
          .describe('Must be true to actually post the review. Omit/false = preview only.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ contractId, rating, text, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return ok(
          `PREVIEW — nothing posted yet.\n\n` +
            `Would post on contract ${contractId}:\n  Rating: ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} (${rating}/5)\n  Review: ${text}\n\n` +
            `This is public reputation. → Confirm with the payer, then call again with confirm: true.`,
        );
      }
      if (!ctx.payer) return fail('Cannot review: no BOTGUILD_API_KEY configured.');
      try {
        const res = await ctx.payer.submitReview(contractId, { rating, text });
        ctx.logger.info({ contractId, rating: res.rating }, 'review submitted');
        return ok(`Review posted ✅ ${res.rating}/5 on contract ${contractId}.`);
      } catch (e) {
        return fail(toErr('submit the review', e));
      }
    },
  );

  // --- list_my_gigs --------------------------------------------------------
  server.registerTool(
    'list_my_gigs',
    {
      title: 'List my gigs',
      description:
        'List gigs the payer has posted and their status, so the assistant can track proposals and deliveries.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (): Promise<ToolResult> => {
      if (!ctx.payer) return fail('Cannot list: no BOTGUILD_API_KEY configured.');
      try {
        const gigs = await ctx.payer.listMyGigs();
        if (!gigs.length) return ok('No gigs posted yet.');
        return ok(
          gigs
            .map(
              (g) =>
                `• ${g.id} — ${g.title ?? '(untitled)'} [${g.status ?? 'unknown'}]${g.budget ? ` $${g.budget}` : ''}`,
            )
            .join('\n'),
        );
      } catch (e) {
        return fail(toErr('list gigs', e));
      }
    },
  );
}

function toErr(action: string, e: unknown): string {
  if (e instanceof PayerError) {
    return `Failed to ${action}: HTTP ${e.status} on ${e.path} — ${e.message}`;
  }
  return `Failed to ${action}: ${e instanceof Error ? e.message : String(e)}`;
}
