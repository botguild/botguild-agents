import Anthropic from '@anthropic-ai/sdk';
import type { Gig } from '@botguild/agent-core';
import type { Logger } from 'pino';

export type CheckType = 'smoke' | 'data-quality' | 'api-contract' | 'acceptance-audit' | 'dom-ui';

export interface Criterion {
  id: string;
  description: string;
  expected: string;
  checkMethod: 'http' | 'dom' | 'data' | 'claude';
}

export interface EvidenceRequirement {
  screenshot: boolean;
  responseLog: boolean;
  sampleRows: boolean;
}

export interface CheckPlan {
  gigId: string;
  contractId: string;
  checkType: CheckType;
  targets: string[];
  criteriaList: Criterion[];
  evidenceRequired: EvidenceRequirement;
  milestoneIds: string[];
  confidence: number;
}

export interface ParseResult {
  plan: CheckPlan;
  needsClarification: boolean;
  clarificationQuestion?: string;
}

export interface GigParserConfig {
  apiKey: string;
  logger: Logger;
}

const SYSTEM_PROMPT = `You are a configuration extractor for VerifierBot, a quality-assurance and acceptance-testing bot. Extract structured check plan configuration from gig descriptions.

Given a gig title, description, budget, and acceptance criteria, extract the verification parameters and return a JSON object.

Return ONLY valid JSON with no additional text, markdown, or explanation.`;

const CONFIDENCE_THRESHOLD = 0.7;

interface ClaudeExtraction {
  checkType: CheckType;
  targets: string[];
  criteriaList: Criterion[];
  evidenceRequired: EvidenceRequirement;
  confidence: number;
  clarificationQuestion: string | null;
}

function buildUserPrompt(gig: Gig): string {
  return `Extract a check plan configuration from the following gig:

Title: ${gig.title}
Description: ${gig.description}
Budget: ${gig.budget}
Acceptance Criteria: ${gig.acceptanceCriteria ?? 'Not specified'}

Return a JSON object with exactly these fields:
{
  "checkType": "smoke|data-quality|api-contract|acceptance-audit|dom-ui",
  "targets": ["https://..."],
  "criteriaList": [
    { "id": "slug", "description": "...", "expected": "...", "checkMethod": "http|dom|data|claude" }
  ],
  "evidenceRequired": { "screenshot": false, "responseLog": true, "sampleRows": false },
  "confidence": 0.9,
  "clarificationQuestion": null
}

Guidelines:
- checkType: use "smoke" for basic availability checks, "data-quality" for data validation, "api-contract" for API schema/response checks, "acceptance-audit" for full acceptance criteria review, "dom-ui" for browser/UI checks
- targets: URLs, API endpoints, or data sources referenced in the gig
- criteriaList: one entry per verifiable criterion extracted from the acceptance criteria; id must be a short kebab-case slug
- checkMethod: "http" for HTTP status/response checks, "dom" for browser DOM assertions, "data" for dataset/row-level checks, "claude" for subjective/prose evaluation
- evidenceRequired: set flags based on what proof the client would need
- confidence: your confidence in this extraction (0.0-1.0); set below 0.7 if the acceptance criteria are ambiguous or missing
- clarificationQuestion: a specific, actionable question if confidence < 0.7, otherwise null`;
}

export function createGigParser(config: GigParserConfig): {
  parse(gig: Gig, contractId: string, milestoneIds: string[]): Promise<ParseResult>;
} {
  const { apiKey, logger } = config;
  const client = new Anthropic({ apiKey });

  return {
    async parse(gig: Gig, contractId: string, milestoneIds: string[]): Promise<ParseResult> {
      logger.info({ gigId: gig.id, contractId }, 'parsing gig into CheckPlan');

      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: 'claude-sonnet-4-6',
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

      const plan: CheckPlan = {
        gigId: gig.id,
        contractId,
        checkType: extraction.checkType,
        targets: extraction.targets,
        criteriaList: extraction.criteriaList,
        evidenceRequired: extraction.evidenceRequired,
        milestoneIds,
        confidence: extraction.confidence,
      };

      const needsClarification = extraction.confidence < CONFIDENCE_THRESHOLD;

      logger.info(
        { gigId: gig.id, contractId, confidence: extraction.confidence, needsClarification },
        'gig parsing complete',
      );

      return {
        plan,
        needsClarification,
        clarificationQuestion: needsClarification
          ? (extraction.clarificationQuestion ?? undefined)
          : undefined,
      };
    },
  };
}
