import Anthropic from '@anthropic-ai/sdk';
import type { Gig } from '@botguild/agent-core';
import type { Logger } from 'pino';

export type InputType = 'csv' | 'pdf' | 'api' | 'sheet';
export type OutputFormat = 'csv' | 'json' | 'airtable';

export interface SchemaField {
  name: string;
  type: 'string' | 'number' | 'date' | 'boolean';
}

export interface TransformRules {
  dedupKey?: string;
  dateFormat?: string;
  requiredFields?: string[];
}

export interface TransformJobConfig {
  gigId: string;
  contractId: string;
  inputType: InputType;
  inputSource: string;
  targetSchema: SchemaField[];
  transformRules: TransformRules;
  outputFormat: OutputFormat;
  milestoneIds: string[];
  confidence: number;
}

export interface ParseResult {
  config: TransformJobConfig;
  needsClarification: boolean;
  clarificationQuestion?: string;
}

export interface GigParserConfig {
  apiKey: string;
  logger: Logger;
}

const SYSTEM_PROMPT = `You are a configuration extractor for FlowBot, a data transformation bot. Extract structured transform job configuration from gig descriptions.

Given a gig title, description, budget, and acceptance criteria, extract the data pipeline parameters and return a JSON object.

Return ONLY valid JSON with no additional text, markdown, or explanation.`;

const CONFIDENCE_THRESHOLD = 0.7;

interface ClaudeExtraction {
  inputType: InputType;
  inputSource: string;
  targetSchema: SchemaField[];
  transformRules: TransformRules;
  outputFormat: OutputFormat;
  confidence: number;
  clarificationQuestion: string | null;
}

function buildUserPrompt(gig: Gig): string {
  return `Extract a transform job configuration from the following gig:

Title: ${gig.title}
Description: ${gig.description}
Budget: ${gig.budget}
Acceptance Criteria: ${gig.acceptanceCriteria ?? 'Not specified'}

Return a JSON object with exactly these fields:
{
  "inputType": "csv|pdf|api|sheet",
  "inputSource": "https://...",
  "targetSchema": [{"name": "column_name", "type": "string|number|date|boolean"}],
  "transformRules": {
    "dedupKey": "id",
    "dateFormat": "ISO8601",
    "requiredFields": ["id"]
  },
  "outputFormat": "csv|json|airtable",
  "confidence": 0.9,
  "clarificationQuestion": null
}`;
}

export function createGigParser(config: GigParserConfig): {
  parse(gig: Gig, contractId: string, milestoneIds: string[]): Promise<ParseResult>;
} {
  const { apiKey, logger } = config;
  const client = new Anthropic({ apiKey });

  return {
    async parse(gig: Gig, contractId: string, milestoneIds: string[]): Promise<ParseResult> {
      logger.info({ gigId: gig.id, contractId }, 'parsing gig into TransformJobConfig');

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
        logger.error(
          { err, gigId: gig.id, contractId },
          'Claude API call failed during gig parsing',
        );
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
        throw new Error(`JSON parse failed for gig ${gig.id}: ${String(err)}`, { cause: err });
      }

      const jobConfig: TransformJobConfig = {
        gigId: gig.id,
        contractId,
        inputType: extraction.inputType,
        inputSource: extraction.inputSource,
        targetSchema: extraction.targetSchema,
        transformRules: extraction.transformRules,
        outputFormat: extraction.outputFormat,
        milestoneIds,
        confidence: extraction.confidence,
      };

      const needsClarification = extraction.confidence < CONFIDENCE_THRESHOLD;

      logger.info(
        { gigId: gig.id, contractId, confidence: extraction.confidence, needsClarification },
        'gig parsing complete',
      );

      return {
        config: jobConfig,
        needsClarification,
        clarificationQuestion: needsClarification
          ? (extraction.clarificationQuestion ?? undefined)
          : undefined,
      };
    },
  };
}
