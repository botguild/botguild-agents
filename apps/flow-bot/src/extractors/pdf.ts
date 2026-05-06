import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import pdfParse from 'pdf-parse';
import type { SchemaField } from '../parser.js';

export interface PdfExtractResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  needsReviewCount: number;
  pageCount: number;
  summary: string;
}

export interface PdfExtractorConfig {
  apiKey: string;
  logger: Logger;
}

const CONFIDENCE_THRESHOLD = 0.7;
const MAX_TEXT_LENGTH = 8000;

const SYSTEM_PROMPT =
  'You are a data extraction assistant. Extract structured records from document text and return them as a JSON array matching the provided schema. For each record include a `_confidence` field (0.0–1.0). Return only valid JSON.';

function buildUserPrompt(targetSchema: SchemaField[], text: string): string {
  const schemaDescription = targetSchema.map((f) => `  - ${f.name} (${f.type})`).join('\n');

  const truncatedText = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;

  return `Extract records from the following document text and return a JSON array matching this schema:

Schema fields:
${schemaDescription}

Return format: [{ ${targetSchema.map((f) => `${f.name}: value`).join(', ')}, _confidence: 0.9 }]

Document text:
${truncatedText}`;
}

export async function extractPdf(
  url: string,
  targetSchema: SchemaField[],
  config: PdfExtractorConfig,
): Promise<PdfExtractResult> {
  const { apiKey, logger } = config;

  logger.info({ url }, 'fetching PDF');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF from ${url}: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  logger.info({ url }, 'parsing PDF');

  const { text, numpages: pageCount } = await pdfParse(buffer);

  logger.info({ url, pageCount, textLength: text.length }, 'sending PDF text to Claude');

  const client = new Anthropic({ apiKey });

  let claudeResponse: Anthropic.Message;
  try {
    claudeResponse = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildUserPrompt(targetSchema, text),
        },
      ],
    });
  } catch (err) {
    logger.error({ err, url }, 'Claude API call failed during PDF extraction');
    throw err;
  }

  const textBlock = claudeResponse.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text',
  );

  if (!textBlock) {
    throw new Error('Claude returned no text content for PDF extraction');
  }

  let rawRows: (Record<string, unknown> & { _confidence?: number })[];
  try {
    rawRows = JSON.parse(textBlock.text) as (Record<string, unknown> & { _confidence?: number })[];
  } catch (err) {
    logger.error(
      { err, url, rawText: textBlock.text },
      'failed to parse Claude JSON response for PDF',
    );
    throw new Error(`JSON parse failed for PDF extraction from ${url}: ${String(err)}`, {
      cause: err,
    });
  }

  let needsReviewCount = 0;
  const rows: Record<string, unknown>[] = rawRows.map((raw) => {
    const confidence = typeof raw._confidence === 'number' ? raw._confidence : 1.0;
    const { _confidence, ...rest } = raw;
    void _confidence;

    if (confidence < CONFIDENCE_THRESHOLD) {
      needsReviewCount++;
      return { ...rest, needs_review: true };
    }

    return rest;
  });

  const rowCount = rows.length;
  const summary = `Extracted ${rowCount} records from ${pageCount} pages. ${needsReviewCount} flagged for review.`;

  logger.info({ url, rowCount, pageCount, needsReviewCount }, 'PDF extraction complete');

  return {
    rows,
    rowCount,
    needsReviewCount,
    pageCount,
    summary,
  };
}
