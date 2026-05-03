import type { TransformRules } from './parser.ts';

export interface NormalizeResult {
  rows: Record<string, unknown>[];
  originalCount: number;
  afterDedupCount: number;
  normalizedCount: number;
  skippedCount: number;
  phoneFailCount: number;
  summary: string;
}

const DATE_FIELD_RE = /date|at|time|created|updated|timestamp/i;
const PHONE_FIELD_RE = /phone|mobile|tel/i;

function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    if (value > 1_000_000_000) {
      return new Date(value * 1000).toISOString();
    }
    return null;
  }

  if (typeof value !== 'string') return null;

  const numericStr = Number(value);
  if (!Number.isNaN(numericStr) && numericStr > 1_000_000_000) {
    return new Date(numericStr * 1000).toISOString();
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const mdyFull = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdyFull) {
    const [, m, d, y] = mdyFull;
    return new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`).toISOString();
  }

  const mdyShort = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (mdyShort) {
    const [, m, d, y] = mdyShort;
    const fullYear = parseInt(y, 10) >= 70 ? `19${y}` : `20${y}`;
    return new Date(`${fullYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`).toISOString();
  }

  const dmyDash = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmyDash) {
    const [, d, m, y] = dmyDash;
    return new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`).toISOString();
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return null;
}

function normalizePhone(
  value: unknown,
  phoneFailCount: { count: number },
): string {
  const original = String(value);

  if (original.startsWith('+')) {
    return `+${original.replace(/[^\d]/g, '')}`;
  }

  const digits = original.replace(/\D/g, '');

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  phoneFailCount.count += 1;
  return original;
}

function isEmptyRow(row: Record<string, unknown>): boolean {
  return Object.values(row).every(
    (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === ''),
  );
}

export function normalizeRows(
  rows: Record<string, unknown>[],
  rules: TransformRules,
): NormalizeResult {
  const originalCount = rows.length;
  const phoneFailCounter = { count: 0 };
  let skippedCount = 0;
  let normalizedCount = 0;

  const nonEmptyRows = rows.filter((row) => {
    if (isEmptyRow(row)) {
      skippedCount++;
      return false;
    }
    return true;
  });

  let dedupedRows: Record<string, unknown>[];
  if (rules.dedupKey) {
    const map = new Map<unknown, Record<string, unknown>>();
    for (const row of nonEmptyRows) {
      map.set(row[rules.dedupKey], row);
    }
    dedupedRows = Array.from(map.values());
  } else {
    dedupedRows = nonEmptyRows;
  }

  const afterDedupCount = dedupedRows.length;

  const processedRows = dedupedRows.map((row) => {
    const result: Record<string, unknown> = {};
    let changed = false;

    for (const [key, value] of Object.entries(row)) {
      let normalized: unknown = value;

      if (typeof normalized === 'string') {
        const trimmed = normalized.trim();
        if (trimmed !== normalized) {
          normalized = trimmed;
          changed = true;
        }
      }

      if (DATE_FIELD_RE.test(key)) {
        const dateResult = normalizeDate(normalized);
        if (dateResult !== null && dateResult !== normalized) {
          normalized = dateResult;
          changed = true;
        }
      } else if (PHONE_FIELD_RE.test(key) && normalized !== null && normalized !== undefined && normalized !== '') {
        const phoneResult = normalizePhone(normalized, phoneFailCounter);
        if (phoneResult !== normalized) {
          normalized = phoneResult;
          changed = true;
        }
      }

      result[key] = normalized;
    }

    if (changed) normalizedCount++;
    return result;
  });

  const summary = `Processed ${originalCount} rows: ${skippedCount} empty rows removed, ${afterDedupCount} after dedup, ${normalizedCount} rows normalized.`;

  return {
    rows: processedRows,
    originalCount,
    afterDedupCount,
    normalizedCount,
    skippedCount,
    phoneFailCount: phoneFailCounter.count,
    summary,
  };
}
