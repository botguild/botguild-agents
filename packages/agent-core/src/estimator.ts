import Anthropic from '@anthropic-ai/sdk';
import type { Gig } from './client.js';
import { criterionText } from './client.js';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Hybrid cost estimation
//
// "Guess what the job costs in compute & resources, then bid 1.5× that."
//
//   1. Claude (Haiku) estimates the *resource quantities* a job needs — how many
//      LLM calls, tokens, browser-minutes, compute-minutes, and execution runs.
//      This is the fuzzy part: it reads the gig and judges scope. (Hybrid: the
//      model only estimates quantities, never dollars.)
//   2. A deterministic per-bot RateCard converts those quantities to a dollar
//      cost. Same quantities → same cost, every time. This keeps pricing
//      reproducible and auditable even though step 1 is a model call.
//   3. price = clamp(round(markup × cost)), markup defaulting to 1.5.
//
// Estimates are cached per gig id so the proposer and the negotiation poller
// agree on the same number without paying for two model calls.
// ---------------------------------------------------------------------------

export interface ResourceEstimate {
  /** Number of Claude/LLM calls the job requires end-to-end. */
  claudeCalls: number;
  /** Total LLM tokens, in thousands. */
  claudeKTokens: number;
  /** Headless-browser (Playwright) minutes. 0 for jobs that need no browser. */
  browserMinutes: number;
  /** General compute/runtime minutes (parsing, transforms, I/O). */
  computeMinutes: number;
  /** Distinct execution cycles (e.g. weekly watch runs, repeated test passes). */
  runs: number;
}

export interface RateCard {
  perClaudeCall: number;
  perKToken: number;
  perBrowserMinute: number;
  perComputeMinute: number;
  perRun: number;
  /** Baseline per-gig setup/infra cost added regardless of quantities. */
  fixedOverhead: number;
}

export interface CostResult {
  resources: ResourceEstimate;
  cost: number; // deterministic dollars from the rate card
  target: number; // round(markup × cost) — our firm minimum acceptable price
  price: number; // the bid: max(target, gig.budget) — align up to the gig if it pays more
  markup: number;
  source: 'claude' | 'fallback';
}

// Deterministic: quantities × rates + overhead. No minimum, no model involved.
export function applyRateCard(est: ResourceEstimate, card: RateCard): number {
  return (
    card.fixedOverhead +
    est.claudeCalls * card.perClaudeCall +
    est.claudeKTokens * card.perKToken +
    est.browserMinutes * card.perBrowserMinute +
    est.computeMinutes * card.perComputeMinute +
    est.runs * card.perRun
  );
}

export interface CostEstimatorConfig {
  apiKey: string;
  botName: string;
  /** What the bot does — grounds Claude's scope judgement. */
  botDescription: string;
  rateCard: RateCard;
  /** Used when the model call fails so we always return a usable number. */
  fallbackEstimate: ResourceEstimate;
  /** Bid multiplier over estimated cost. Defaults to 1.5. */
  markup?: number;
  logger: Logger;
}

export interface CostEstimator {
  /** Estimate cost and bid price for a gig (cached by gig id). */
  estimate(gig: Gig): Promise<CostResult>;
}

const ESTIMATE_TOOL: Anthropic.Tool = {
  name: 'report_resource_estimate',
  description:
    'Report the compute and resource quantities required to fully deliver this gig. ' +
    'Estimate realistically based on the scope described — more targets, larger data, ' +
    'longer monitoring windows, and stricter acceptance criteria all increase the numbers.',
  input_schema: {
    type: 'object',
    properties: {
      claudeCalls: { type: 'number', description: 'Total number of LLM/Claude calls end-to-end.' },
      claudeKTokens: { type: 'number', description: 'Total LLM tokens used, in thousands.' },
      browserMinutes: {
        type: 'number',
        description: 'Headless-browser (Playwright) minutes. Use 0 if no browser work is needed.',
      },
      computeMinutes: {
        type: 'number',
        description: 'General compute/runtime minutes for parsing, transforms, and I/O.',
      },
      runs: {
        type: 'number',
        description: 'Distinct execution cycles (e.g. weekly watch runs, repeated test passes).',
      },
    },
    required: ['claudeCalls', 'claudeKTokens', 'browserMinutes', 'computeMinutes', 'runs'],
  },
};

function buildSystemPrompt(botName: string, botDescription: string): string {
  return `You are the cost-estimation engine for ${botName}, an autonomous bot on the BotGuild marketplace.

${botName} does the following work:
${botDescription}

Your only job is to estimate the COMPUTE AND RESOURCE QUANTITIES required to fully deliver a gig — never a dollar amount. A separate deterministic rate card turns your quantities into a price, so estimate quantities honestly and proportionally to scope:

- A small, one-off job needs few LLM calls, low tokens, little compute, and a single run.
- A larger job — more targets/endpoints/rows, a longer monitoring window, stricter or more numerous acceptance criteria, multiple input formats — needs proportionally more.
- Set browserMinutes to 0 for jobs that involve no web pages or headless-browser checks.

Always call the report_resource_estimate tool with your best numeric estimate. Do not under- or over-state scope; estimate what it would genuinely take to deliver quality work that meets the acceptance criteria.`;
}

function buildUserPrompt(gig: Gig): string {
  return `Estimate the resources to fully deliver this gig.

**Title**: ${gig.title}
**Category**: ${gig.category}
**Budget (buyer's stated cap)**: $${gig.budget}
**Description**: ${gig.description}${
    gig.deliverables?.length ? `\n**Deliverables**: ${gig.deliverables.join('; ')}` : ''
  }${
    gig.acceptanceCriteria?.length
      ? `\n**Acceptance Criteria**: ${gig.acceptanceCriteria.map(criterionText).join('; ')}`
      : ''
  }${gig.timeline ? `\n**Requested Timeline**: ${gig.timeline}` : ''}

Call report_resource_estimate with the compute and resource quantities required.`;
}

function coerceEstimate(input: unknown, fallback: ResourceEstimate): ResourceEstimate {
  const obj = (input ?? {}) as Record<string, unknown>;
  const num = (key: keyof ResourceEstimate): number => {
    const v = obj[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback[key];
  };
  return {
    claudeCalls: num('claudeCalls'),
    claudeKTokens: num('claudeKTokens'),
    browserMinutes: num('browserMinutes'),
    computeMinutes: num('computeMinutes'),
    runs: num('runs'),
  };
}

export function createCostEstimator(config: CostEstimatorConfig): CostEstimator {
  const anthropic = new Anthropic({ apiKey: config.apiKey });
  const markup = config.markup ?? 1.5;
  const cache = new Map<string, CostResult>();

  function resultFrom(
    resources: ResourceEstimate,
    source: CostResult['source'],
    gigBudget: number,
  ): CostResult {
    const cost = applyRateCard(resources, config.rateCard);
    // Our firm minimum: 1.5× the guessed cost. No lower bound beyond that.
    const target = Math.round(markup * cost);
    // Bid the target, but if the gig already budgets at/above it, align up to the
    // gig amount to capture the buyer's full willingness to pay.
    const price = Math.max(target, gigBudget);
    return { resources, cost, target, price, markup, source };
  }

  return {
    async estimate(gig: Gig): Promise<CostResult> {
      const cached = cache.get(gig.id);
      if (cached) return cached;

      let result: CostResult;
      try {
        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 300,
          tools: [ESTIMATE_TOOL],
          tool_choice: { type: 'tool', name: ESTIMATE_TOOL.name },
          system: [
            {
              type: 'text',
              text: buildSystemPrompt(config.botName, config.botDescription),
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: buildUserPrompt(gig) }],
        });

        const toolUse = response.content.find(
          (block): block is Anthropic.ToolUseBlock =>
            block.type === 'tool_use' && block.name === ESTIMATE_TOOL.name,
        );
        if (!toolUse) throw new Error('model did not return a resource estimate');

        const resources = coerceEstimate(toolUse.input, config.fallbackEstimate);
        result = resultFrom(resources, 'claude', gig.budget);

        config.logger.info(
          {
            gigId: gig.id,
            resources,
            cost: result.cost,
            target: result.target,
            gigBudget: gig.budget,
            price: result.price,
            markup,
            cacheReadTokens: response.usage.cache_read_input_tokens,
          },
          'estimated gig cost from resource quantities',
        );
      } catch (error) {
        result = resultFrom(config.fallbackEstimate, 'fallback', gig.budget);
        config.logger.warn(
          { err: error, gigId: gig.id, cost: result.cost, price: result.price },
          'cost estimation failed, using deterministic fallback estimate',
        );
      }

      cache.set(gig.id, result);
      return result;
    },
  };
}
