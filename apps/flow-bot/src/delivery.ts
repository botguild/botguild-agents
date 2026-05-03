import Anthropic from '@anthropic-ai/sdk';
import Papa from 'papaparse';
import type { AgentClient } from '@botguild/agent-core';
import type { TransformJobConfig } from './parser.ts';
import type { NormalizeResult } from './normalizer.ts';
import type { Logger } from 'pino';

export interface DeliveryConfig {
  client: AgentClient;
  apiKey: string;
  logger: Logger;
}

export interface DeliveryResult {
  delivered: boolean;
  reason?: 'zero_rows';
  milestoneId: string;
}

export async function deliverOutput(
  contractId: string,
  milestoneId: string,
  rows: Record<string, unknown>[],
  jobConfig: TransformJobConfig,
  normalizeStats: NormalizeResult,
  deliveryConfig: DeliveryConfig,
): Promise<DeliveryResult> {
  const { client, apiKey, logger } = deliveryConfig;

  if (rows.length === 0) {
    logger.info({ contractId, milestoneId }, 'zero output rows, skipping delivery');
    return { delivered: false, reason: 'zero_rows', milestoneId };
  }

  const serialized =
    jobConfig.outputFormat === 'csv'
      ? Papa.unparse(rows)
      : JSON.stringify(rows, null, 2);

  const anthropic = new Anthropic({ apiKey });

  let claudeSummary: string;
  try {
    const summaryResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `Summarize this data transformation in 3-4 plain-language sentences for a non-technical client. Include what was transformed, how many records were produced, and any notable data quality stats.

Input rows: ${normalizeStats.originalCount}
Output rows: ${rows.length}
Normalized rows: ${normalizeStats.normalizedCount}
Skipped (empty) rows: ${normalizeStats.skippedCount}
After dedup: ${normalizeStats.afterDedupCount}
Phone normalization failures: ${normalizeStats.phoneFailCount}
Input type: ${jobConfig.inputType}
Output format: ${jobConfig.outputFormat}
Transform rules: ${JSON.stringify(jobConfig.transformRules)}`,
        },
      ],
    });

    const textBlock = summaryResponse.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    );
    claudeSummary = textBlock?.text ?? 'Transformation complete.';
  } catch (err) {
    logger.warn({ err, contractId, milestoneId }, 'Claude summary generation failed, using fallback');
    claudeSummary = `Transformed ${normalizeStats.originalCount} input rows into ${rows.length} output rows in ${jobConfig.outputFormat} format.`;
  }

  const preview = serialized.length > 2000 ? serialized.slice(0, 2000) : serialized;
  const hasMore = serialized.length > 2000;

  const note = [
    claudeSummary,
    '',
    `Stats: ${normalizeStats.originalCount} input rows → ${rows.length} output rows (${normalizeStats.normalizedCount} normalized, ${normalizeStats.skippedCount} skipped)`,
    '',
    'Output preview:',
    '```',
    preview,
    hasMore ? '\n... (full output attached)' : '',
    '```',
  ]
    .join('\n')
    .trim();

  await client.deliverMilestone(contractId, milestoneId, { note });

  logger.info({ contractId, milestoneId, outputRows: rows.length }, 'milestone delivered');

  return { delivered: true, milestoneId };
}
