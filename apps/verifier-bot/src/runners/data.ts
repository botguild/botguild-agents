import type { Logger } from 'pino';
import type { CheckResult } from './http.ts';

export interface DataQualityCriterion {
  criterionId: string;
  description: string;
  field: string;
  check: 'null-rate' | 'type-correctness' | 'uniqueness' | 'value-range' | 'pattern-match';
  threshold?: number;
  expectedType?: string;
  minValue?: number;
  maxValue?: number;
  pattern?: string;
}

export interface ColumnStats {
  field: string;
  nullRate: number;
  uniquenessRate: number;
  detectedType: string;
  min?: number;
  max?: number;
  mean?: number;
  stdDev?: number;
  outlierCount: number;
}

export interface DataQualityResult {
  checkResults: CheckResult[];
  columnStats: ColumnStats[];
  rowCount: number;
  outlierWarnings: string[];
  summary: string;
}

export interface DataRunnerConfig {
  logger: Logger;
}

function isNull(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function detectType(values: unknown[]): string {
  const nonNull = values.filter((v) => !isNull(v));
  if (nonNull.length === 0) return 'string';

  let numericCount = 0;
  let booleanCount = 0;
  let dateCount = 0;

  for (const v of nonNull) {
    if (typeof v === 'boolean') {
      booleanCount++;
      continue;
    }
    if (typeof v === 'string' && (v === 'true' || v === 'false')) {
      booleanCount++;
      continue;
    }
    const n = Number(v);
    if (!Number.isNaN(n) && v !== '') {
      numericCount++;
      continue;
    }
    if (typeof v === 'string') {
      const parsed = new Date(v);
      if (!Number.isNaN(parsed.getTime()) && /\d{4}/.test(v)) {
        dateCount++;
        continue;
      }
    }
  }

  const total = nonNull.length;
  if (numericCount / total > 0.8) return 'number';
  if (booleanCount / total > 0.8) return 'boolean';
  if (dateCount / total > 0.8) return 'date';
  return 'string';
}

function computeColumnStats(
  field: string,
  values: unknown[],
  outlierWarnings: string[],
): ColumnStats {
  const total = values.length;
  const nullCount = values.filter(isNull).length;
  const nullRate = total > 0 ? nullCount / total : 0;

  const nonNullValues = values.filter((v) => !isNull(v));
  const uniqueValues = new Set(nonNullValues.map((v) => String(v)));
  const uniquenessRate = total > 0 ? uniqueValues.size / total : 0;

  const detectedType = detectType(values);

  if (detectedType !== 'number') {
    return { field, nullRate, uniquenessRate, detectedType, outlierCount: 0 };
  }

  const nums = nonNullValues.map((v) => Number(v)).filter((n) => !Number.isNaN(n));

  if (nums.length === 0) {
    return { field, nullRate, uniquenessRate, detectedType, outlierCount: 0 };
  }

  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const mean = nums.reduce((sum, n) => sum + n, 0) / nums.length;
  const variance = nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / nums.length;
  const stdDev = Math.sqrt(variance);

  const outliers = nums.filter((n) => Math.abs(n - mean) > 3 * stdDev);
  const outlierCount = outliers.length;

  if (outlierCount > 0) {
    outlierWarnings.push(
      `Field "${field}": ${outlierCount} outlier(s) detected (values > 3σ from mean ${mean.toFixed(2)}, σ=${stdDev.toFixed(2)})`,
    );
  }

  return { field, nullRate, uniquenessRate, detectedType, min, max, mean, stdDev, outlierCount };
}

function parseCSV(text: string): Record<string, unknown>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((h) => h.trim());
  const rows: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const row: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j++) {
      const cell = cells[j]?.trim() ?? '';
      row[headers[j]] = cell === '' ? null : cell;
    }
    rows.push(row);
  }

  return rows;
}

async function loadSource(source: string | Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (Array.isArray(source)) return source;

  const response = await fetch(source);
  const contentType = response.headers.get('content-type') ?? '';

  if (source.endsWith('.csv') || contentType.includes('text/csv')) {
    const text = await response.text();
    return parseCSV(text);
  }

  const json = await response.json();
  if (!Array.isArray(json)) {
    throw new Error('JSON source must be an array of objects');
  }
  return json as Record<string, unknown>[];
}

function buildColumnIndex(rows: Record<string, unknown>[]): Map<string, unknown[]> {
  const index = new Map<string, unknown[]>();
  for (const row of rows) {
    for (const [field, value] of Object.entries(row)) {
      if (!index.has(field)) index.set(field, []);
      index.get(field)!.push(value);
    }
  }
  return index;
}

function evaluateCriterion(
  criterion: DataQualityCriterion,
  statsMap: Map<string, ColumnStats>,
  columnIndex: Map<string, unknown[]>,
): CheckResult {
  const { criterionId, description, field, check } = criterion;

  const stats = statsMap.get(field);
  const values = columnIndex.get(field) ?? [];

  if (!stats) {
    return {
      criterionId,
      description,
      verdict: 'skip',
      actual: `field "${field}" not found in data`,
      expected: `field "${field}" present`,
      attempts: 1,
    };
  }

  switch (check) {
    case 'null-rate': {
      const threshold = criterion.threshold ?? 0;
      const pass = stats.nullRate <= threshold;
      return {
        criterionId,
        description,
        verdict: pass ? 'pass' : 'fail',
        actual: `${(stats.nullRate * 100).toFixed(1)}%`,
        expected: `< ${(threshold * 100).toFixed(1)}%`,
        attempts: 1,
      };
    }

    case 'type-correctness': {
      const expectedType = criterion.expectedType ?? '';
      const pass = stats.detectedType === expectedType;
      return {
        criterionId,
        description,
        verdict: pass ? 'pass' : 'fail',
        actual: stats.detectedType,
        expected: expectedType,
        attempts: 1,
      };
    }

    case 'uniqueness': {
      const threshold = criterion.threshold ?? 1;
      const pass = stats.uniquenessRate >= threshold;
      return {
        criterionId,
        description,
        verdict: pass ? 'pass' : 'fail',
        actual: `${(stats.uniquenessRate * 100).toFixed(1)}%`,
        expected: `>= ${(threshold * 100).toFixed(1)}%`,
        attempts: 1,
      };
    }

    case 'value-range': {
      const { minValue, maxValue } = criterion;
      const minOk = minValue === undefined || (stats.min !== undefined && stats.min >= minValue);
      const maxOk = maxValue === undefined || (stats.max !== undefined && stats.max <= maxValue);
      const pass = minOk && maxOk;
      const actualRange =
        stats.min !== undefined && stats.max !== undefined
          ? `[${stats.min}, ${stats.max}]`
          : 'no numeric data';
      const expectedRange = `[${minValue ?? '-∞'}, ${maxValue ?? '+∞'}]`;
      return {
        criterionId,
        description,
        verdict: pass ? 'pass' : 'fail',
        actual: actualRange,
        expected: expectedRange,
        attempts: 1,
      };
    }

    case 'pattern-match': {
      const pattern = criterion.pattern ?? '';
      const regex = new RegExp(pattern);
      const nonNull = values.filter((v) => !isNull(v));
      if (nonNull.length === 0) {
        return {
          criterionId,
          description,
          verdict: 'skip',
          actual: 'no non-null values to check',
          expected: `all values match /${pattern}/`,
          attempts: 1,
        };
      }
      const failCount = nonNull.filter((v) => !regex.test(String(v))).length;
      const failRate = failCount / nonNull.length;
      const pass = failCount === 0;
      return {
        criterionId,
        description,
        verdict: pass ? 'pass' : 'fail',
        actual: pass ? `all ${nonNull.length} values match` : `${(failRate * 100).toFixed(1)}% fail (${failCount}/${nonNull.length})`,
        expected: `all values match /${pattern}/`,
        attempts: 1,
      };
    }
  }
}

export async function runDataQualityChecks(
  source: string | Record<string, unknown>[],
  criteria: DataQualityCriterion[],
  config: DataRunnerConfig,
): Promise<DataQualityResult> {
  const { logger } = config;

  logger.info('loading data source');
  const rows = await loadSource(source);
  const rowCount = rows.length;
  logger.info({ rowCount }, 'data source loaded');

  const columnIndex = buildColumnIndex(rows);
  const outlierWarnings: string[] = [];

  const columnStats: ColumnStats[] = [];
  for (const [field, values] of columnIndex.entries()) {
    columnStats.push(computeColumnStats(field, values, outlierWarnings));
  }

  const statsMap = new Map(columnStats.map((s) => [s.field, s]));

  const checkResults: CheckResult[] = criteria.map((criterion) => {
    logger.info({ criterionId: criterion.criterionId, field: criterion.field, check: criterion.check }, 'evaluating criterion');
    return evaluateCriterion(criterion, statsMap, columnIndex);
  });

  const passCount = checkResults.filter((r) => r.verdict === 'pass').length;
  const failCount = checkResults.filter((r) => r.verdict === 'fail').length;
  const skipCount = checkResults.filter((r) => r.verdict === 'skip').length;

  const summary = `Checked ${rowCount} rows across ${columnStats.length} fields. Criteria: ${passCount} passed, ${failCount} failed, ${skipCount} skipped. Outlier warnings: ${outlierWarnings.length}.`;

  logger.info({ passCount, failCount, skipCount, outlierWarnings: outlierWarnings.length }, 'data quality checks complete');

  return { checkResults, columnStats, rowCount, outlierWarnings, summary };
}
