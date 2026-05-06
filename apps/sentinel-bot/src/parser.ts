import Anthropic from '@anthropic-ai/sdk';
import type { Gig } from '@botguild/agent-core';
import type { Logger } from 'pino';

export type WatchType = 'uptime' | 'change' | 'price' | 'scheduled';
export type ReportFormat = 'summary' | 'diff' | 'raw';

export interface WatchJobConfig {
  gigId: string;
  contractId: string;
  targets: string[];
  watchType: WatchType;
  schedule: string;
  requiresJs: boolean;
  selectors?: string[];
  screenshot: boolean;
  deliveryChannelHint?: string;
  reportFormat: ReportFormat;
  milestoneIds: string[];
  confidence: number;
  checkSchedule?: string;
  milestoneSchedule?: string;
}

export interface ParseResult {
  config: WatchJobConfig;
  needsClarification: boolean;
  clarificationQuestion?: string;
}

export interface GigParserConfig {
  apiKey: string;
  logger: Logger;
}

const SYSTEM_PROMPT = `You are a configuration extractor for SentinelBot, a web monitoring bot. Extract structured watch job configuration from gig descriptions.

Given a gig title, description, budget, and acceptance criteria, extract the monitoring parameters and return a JSON object.

Return ONLY valid JSON with no additional text, markdown, or explanation.`;

const CONFIDENCE_THRESHOLD = 0.7;

interface ClaudeExtraction {
  targets: string[];
  watchType: WatchType;
  schedule: string;
  requiresJs: boolean;
  selectors?: string[];
  screenshot: boolean;
  deliveryChannelHint?: string;
  reportFormat: ReportFormat;
  confidence: number;
  clarificationQuestion: string | null;
}

function buildUserPrompt(gig: Gig): string {
  return `Extract a watch job configuration from the following gig:

Title: ${gig.title}
Description: ${gig.description}
Budget: ${gig.budget}
Acceptance Criteria: ${gig.acceptanceCriteria ?? 'Not specified'}

Return a JSON object with exactly these fields:
{
  "targets": ["https://..."],        // array of URLs or API endpoints to monitor
  "watchType": "uptime|change|price|scheduled",
  "schedule": "0 9 * * *",          // cron expression or "event-driven"
  "requiresJs": false,               // whether Playwright needs JS rendering
  "selectors": [],                   // CSS selectors to watch (for change watchType)
  "screenshot": false,               // whether to capture screenshots
  "deliveryChannelHint": "report",   // "slack", "telegram", or "report"
  "reportFormat": "summary",         // "summary", "diff", or "raw"
  "confidence": 0.9,                 // your confidence in this extraction (0.0-1.0)
  "clarificationQuestion": null      // a specific question if confidence < 0.7, otherwise null
}`;
}

export function createGigParser(config: GigParserConfig): {
  parse(gig: Gig, contractId: string): Promise<ParseResult>;
} {
  const { apiKey, logger } = config;
  const client = new Anthropic({ apiKey });

  return {
    async parse(gig: Gig, contractId: string): Promise<ParseResult> {
      logger.info({ gigId: gig.id, contractId }, 'parsing gig into WatchJobConfig');

      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 1024,
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [
            {
              role: 'user',
              content: buildUserPrompt(gig),
            },
          ],
        });
      } catch (err) {
        logger.error({ err, gigId: gig.id, contractId }, 'Claude API call failed during gig parsing');
        throw err;
      }

      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text',
      );

      if (!textBlock) {
        const err = new Error('Claude returned no text content for gig parsing');
        logger.error({ gigId: gig.id, contractId }, err.message);
        throw err;
      }

      let extraction: ClaudeExtraction;
      try {
        extraction = JSON.parse(textBlock.text) as ClaudeExtraction;
      } catch (err) {
        logger.error(
          { err, gigId: gig.id, contractId, rawText: textBlock.text },
          'failed to parse Claude JSON response for gig',
        );
        throw new Error(`JSON parse failed for gig ${gig.id}: ${String(err)}`);
      }

      const config: WatchJobConfig = {
        gigId: gig.id,
        contractId,
        targets: extraction.targets,
        watchType: extraction.watchType,
        schedule: extraction.schedule,
        requiresJs: extraction.requiresJs,
        selectors: extraction.selectors,
        screenshot: extraction.screenshot,
        deliveryChannelHint: extraction.deliveryChannelHint,
        reportFormat: extraction.reportFormat,
        milestoneIds: [],
        confidence: extraction.confidence,
      };

      const needsClarification = extraction.confidence < CONFIDENCE_THRESHOLD;

      logger.info(
        { gigId: gig.id, contractId, confidence: extraction.confidence, needsClarification },
        'gig parsing complete',
      );

      return {
        config,
        needsClarification,
        clarificationQuestion: needsClarification
          ? (extraction.clarificationQuestion ?? undefined)
          : undefined,
      };
    },
  };
}
