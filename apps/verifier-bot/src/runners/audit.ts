import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { CheckResult, CheckVerdict } from './http.js';

export interface AuditCriterion {
  criterionId: string;
  description: string;
  expected: string;
}

export interface AuditVerdict {
  criterionId: string;
  verdict: 'pass' | 'fail' | 'partial';
  reasoning: string;
  confidence: number;
  needsHumanReview: boolean;
}

export interface AuditRunnerConfig {
  apiKey: string;
  logger: Logger;
}

export interface AuditResult {
  checkResults: CheckResult[];
  auditVerdicts: AuditVerdict[];
  needsHumanReviewCount: number;
}

const CONTENT_TRUNCATION_LIMIT = 8000;
const CONFIDENCE_REVIEW_THRESHOLD = 0.7;
const MODEL = 'claude-sonnet-4-6';

function toCheckVerdict(verdict: 'pass' | 'fail' | 'partial'): CheckVerdict {
  if (verdict === 'pass') return 'pass';
  return 'fail';
}

function buildFailResults(criteria: AuditCriterion[], errorMessage: string): AuditResult {
  const auditVerdicts: AuditVerdict[] = criteria.map((c) => ({
    criterionId: c.criterionId,
    verdict: 'fail',
    reasoning: errorMessage,
    confidence: 0,
    needsHumanReview: true,
  }));

  const checkResults: CheckResult[] = criteria.map((c) => ({
    criterionId: c.criterionId,
    description: c.description,
    verdict: 'fail' as CheckVerdict,
    actual: errorMessage,
    expected: c.expected,
    attempts: 1,
  }));

  return {
    checkResults,
    auditVerdicts,
    needsHumanReviewCount: criteria.length,
  };
}

export async function runAcceptanceAudit(
  deliverableContent: string,
  criteria: AuditCriterion[],
  config: AuditRunnerConfig,
): Promise<AuditResult> {
  const { apiKey, logger } = config;

  let content = deliverableContent;

  if (content.startsWith('http://') || content.startsWith('https://')) {
    logger.info({ url: content }, 'fetching deliverable from URL');
    try {
      const response = await fetch(content);
      if (!response.ok) {
        const reason = `Deliverable URL returned HTTP ${response.status} ${response.statusText}`;
        logger.error({ url: deliverableContent, status: response.status }, reason);
        return buildFailResults(criteria, reason);
      }
      content = await response.text();
      if (content.length > CONTENT_TRUNCATION_LIMIT) {
        logger.warn(
          { originalLength: content.length, truncatedTo: CONTENT_TRUNCATION_LIMIT },
          'truncating deliverable content',
        );
        content = content.slice(0, CONTENT_TRUNCATION_LIMIT);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ url: deliverableContent, error: message }, 'failed to fetch deliverable URL');
      return buildFailResults(criteria, `Failed to fetch deliverable URL: ${message}`);
    }
  }

  const criteriaText = criteria
    .map(
      (c) =>
        `- criterionId: "${c.criterionId}"\n  description: "${c.description}"\n  expected: "${c.expected}"`,
    )
    .join('\n');

  const userMessage = `Criteria to evaluate:\n${criteriaText}\n\nDeliverable content:\n${content}\n\nReturn a JSON array with one entry per criterion:\n[{ "criterionId": "...", "verdict": "pass|fail|partial", "reasoning": "one sentence", "confidence": 0.0-1.0 }]`;

  const client = new Anthropic({ apiKey });

  let rawResponse: string;
  try {
    logger.info({ criteriaCount: criteria.length }, 'sending acceptance audit to Claude');
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system:
        'You are an acceptance criteria auditor. Evaluate whether the provided deliverable meets each stated criterion. Return a JSON array with one entry per criterion.',
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return buildFailResults(criteria, 'Claude returned no text content');
    }
    rawResponse = textBlock.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ error: message }, 'Claude API call failed');
    return buildFailResults(criteria, `Claude API error: ${message}`);
  }

  let parsed: Array<{
    criterionId: string;
    verdict: string;
    reasoning: string;
    confidence: number;
  }>;
  try {
    const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No JSON array found in response');
    }
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ error: message, rawResponse }, 'failed to parse Claude JSON response');
    return buildFailResults(criteria, `Failed to parse Claude response: ${message}`);
  }

  const criteriaMap = new Map(criteria.map((c) => [c.criterionId, c]));

  const verdictsById = new Map<
    string,
    { verdict: string; reasoning: string; confidence: number }
  >();
  for (const item of parsed) {
    if (item.criterionId) verdictsById.set(item.criterionId, item);
  }

  // Make sure every requested criterion has a verdict — Claude can omit
  // entries, which would otherwise silently drop them from the report.
  const auditVerdicts: AuditVerdict[] = criteria.map((c) => {
    const item = verdictsById.get(c.criterionId);
    if (!item) {
      logger.warn(
        { criterionId: c.criterionId },
        'criterion missing from audit response, marking for review',
      );
      return {
        criterionId: c.criterionId,
        verdict: 'fail',
        reasoning: 'Auditor did not return a verdict for this criterion; needs human review.',
        confidence: 0,
        needsHumanReview: true,
      };
    }
    return {
      criterionId: c.criterionId,
      verdict: item.verdict as 'pass' | 'fail' | 'partial',
      reasoning: item.reasoning,
      confidence: item.confidence,
      needsHumanReview: item.confidence < CONFIDENCE_REVIEW_THRESHOLD,
    };
  });

  const checkResults: CheckResult[] = auditVerdicts.map((v) => {
    const criterion = criteriaMap.get(v.criterionId);
    return {
      criterionId: v.criterionId,
      description: criterion?.description ?? v.criterionId,
      verdict: toCheckVerdict(v.verdict),
      actual: v.reasoning,
      expected: criterion?.expected ?? '',
      attempts: 1,
    };
  });

  const needsHumanReviewCount = auditVerdicts.filter((v) => v.needsHumanReview).length;

  logger.info({ total: auditVerdicts.length, needsHumanReviewCount }, 'acceptance audit complete');

  return { checkResults, auditVerdicts, needsHumanReviewCount };
}
