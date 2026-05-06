import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@botguild/agent-core';
import type { CheckResult } from './runners/http.js';
import type { AuditVerdict } from './runners/audit.js';
import type { Logger } from 'pino';

export type OverallVerdict = 'PASS' | 'FAIL' | 'PARTIAL';

export interface ReportConfig {
  client: AgentClient;
  apiKey: string;
  logger: Logger;
}

export interface ReportResult {
  verdict: OverallVerdict;
  reportMarkdown: string;
  milestoneNote: string;
  passCount: number;
  failCount: number;
}

function computeVerdict(checkResults: CheckResult[], auditVerdicts: AuditVerdict[]): OverallVerdict {
  const hasFail = checkResults.some((r) => r.verdict === 'fail');
  if (hasFail) return 'FAIL';

  const allPass = checkResults.every((r) => r.verdict === 'pass');
  if (allPass && auditVerdicts.every((v) => !v.needsHumanReview)) return 'PASS';

  const hasHumanReview = auditVerdicts.some((v) => v.needsHumanReview);
  if (hasHumanReview) return 'PARTIAL';

  return 'PASS';
}

function buildUserPrompt(
  verdict: OverallVerdict,
  passCount: number,
  failCount: number,
  checkResults: CheckResult[],
  auditVerdicts: AuditVerdict[],
): string {
  const criteriaLines = checkResults
    .map(
      (r) =>
        `- [${r.verdict.toUpperCase()}] ${r.description} (id: ${r.criterionId})\n  Expected: ${r.expected}\n  Actual: ${r.actual}${r.error ? `\n  Error: ${r.error}` : ''}`,
    )
    .join('\n');

  const auditLines =
    auditVerdicts.length > 0
      ? '\n\nAudit verdicts:\n' +
        auditVerdicts
          .map(
            (v) =>
              `- [${v.verdict.toUpperCase()}] ${v.criterionId}: ${v.reasoning} (confidence: ${v.confidence.toFixed(2)}, needs review: ${v.needsHumanReview})`,
          )
          .join('\n')
      : '';

  return `Generate a QA report for the following check run.

Overall verdict: ${verdict}
Summary: ${passCount} passed, ${failCount} failed

Criterion-by-criterion results:
${criteriaLines}${auditLines}

Produce a markdown report with exactly these sections:
## Verdict
## Summary
## Results
## Evidence
## Recommendations

${verdict === 'FAIL' ? 'In the Recommendations section, list specific, actionable remediation steps for each failed criterion.' : ''}
${verdict === 'PASS' ? 'In the Recommendations section, write: "All checks passed. No action required."' : ''}
${verdict === 'PARTIAL' ? 'In the Recommendations section, note which criteria need human review and why.' : ''}`;
}

function buildMilestoneNote(
  verdict: OverallVerdict,
  passCount: number,
  failCount: number,
  checkResults: CheckResult[],
): string {
  const failedDescriptions = checkResults
    .filter((r) => r.verdict === 'fail')
    .map((r) => r.description);

  let note = `Verdict: ${verdict} | ${passCount} passed, ${failCount} failed`;

  if (verdict === 'FAIL' && failedDescriptions.length > 0) {
    note += `\nCritical failures: ${failedDescriptions.join('; ')}`;
  }

  note += '\nFull report below.';

  return note;
}

export async function generateAndDeliverReport(
  contractId: string,
  milestoneId: string,
  checkResults: CheckResult[],
  auditVerdicts: AuditVerdict[],
  screenshotBase64s: string[],
  config: ReportConfig,
): Promise<ReportResult> {
  const { client, apiKey, logger } = config;

  const passCount = checkResults.filter((r) => r.verdict === 'pass').length;
  const failCount = checkResults.filter((r) => r.verdict === 'fail').length;
  const verdict = computeVerdict(checkResults, auditVerdicts);

  logger.info({ contractId, milestoneId, verdict, passCount, failCount }, 'generating report');

  const anthropic = new Anthropic({ apiKey });

  let reportMarkdown: string;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      system: 'You are a QA report writer. Generate a structured markdown report from check results.',
      messages: [
        {
          role: 'user',
          content: buildUserPrompt(verdict, passCount, failCount, checkResults, auditVerdicts),
        },
      ],
    });

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock) {
      throw new Error('Claude returned no text content for report generation');
    }
    reportMarkdown = textBlock.text;
  } catch (err) {
    logger.error({ err, contractId }, 'Claude report generation failed');
    throw err;
  }

  const milestoneNote = buildMilestoneNote(verdict, passCount, failCount, checkResults);

  // Encode any screenshot evidence as data URLs so the client receives the
  // visual proof — otherwise it's collected but silently dropped.
  const attachments = screenshotBase64s.length > 0
    ? screenshotBase64s.map((b64) => `data:image/png;base64,${b64}`)
    : undefined;

  logger.info(
    { contractId, milestoneId, screenshotCount: screenshotBase64s.length },
    'delivering milestone with report',
  );
  await client.deliverMilestone(contractId, milestoneId, {
    note: milestoneNote + '\n\n' + reportMarkdown,
    attachments,
  });

  logger.info({ contractId, milestoneId, verdict }, 'report delivered');

  return {
    verdict,
    reportMarkdown,
    milestoneNote,
    passCount,
    failCount,
  };
}
