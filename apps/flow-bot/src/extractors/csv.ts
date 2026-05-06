import Papa from 'papaparse';
import type { Logger } from 'pino';

export type ColumnType = 'string' | 'number' | 'date' | 'boolean' | 'mixed';

export interface ColumnStats {
  name: string;
  detectedType: ColumnType;
  nullCount: number;
}

export interface CsvExtractResult {
  rows: Record<string, unknown>[];
  columnNames: string[];
  columnStats: ColumnStats[];
  rowCount: number;
  malformedCount: number;
  sample: Record<string, unknown>[];
  summary: string;
}

export interface CsvExtractorConfig {
  logger: Logger;
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function detectColumnType(values: unknown[]): ColumnType {
  const nonNull = values.filter((v) => !isNullish(v));
  if (nonNull.length === 0) return 'string';

  const allBooleans = nonNull.every((v) => typeof v === 'boolean');
  if (allBooleans) return 'boolean';

  const allNumbers = nonNull.every((v) => typeof v === 'number');
  if (allNumbers) return 'number';

  const allStrings = nonNull.every((v) => typeof v === 'string');
  if (allStrings) {
    const allDates = nonNull.every((v) => !isNaN(Date.parse(v as string)));
    if (allDates) return 'date';
    return 'string';
  }

  return 'mixed';
}

export async function extractCsv(
  url: string,
  config: CsvExtractorConfig,
): Promise<CsvExtractResult> {
  const { logger } = config;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch CSV from ${url}: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();

  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
    transformHeader: (header) => header.trim(),
  });

  const malformedCount = result.errors.length;
  for (const error of result.errors) {
    logger.warn({ row: error.row, code: error.code, message: error.message }, 'malformed CSV row');
  }

  const rows = result.data;
  const columnNames = result.meta.fields ?? [];

  const columnStats: ColumnStats[] = columnNames.map((name) => {
    const values = rows.map((row) => row[name]);
    return {
      name,
      detectedType: detectColumnType(values),
      nullCount: values.filter(isNullish).length,
    };
  });

  const rowCount = rows.length;
  const sample = rows.slice(0, 3);
  const summary = `Parsed ${rowCount} rows, ${columnNames.length} columns. ${malformedCount} malformed rows skipped.`;

  return {
    rows,
    columnNames,
    columnStats,
    rowCount,
    malformedCount,
    sample,
    summary,
  };
}
