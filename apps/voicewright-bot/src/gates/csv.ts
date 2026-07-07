// Meta bulk-import CSV builder + template schema validator (§8/§9).
//
// The header set below is the versioned template contract: it mirrors the
// column names Meta's Ads Manager bulk-import sheet uses for the campaign,
// ad-set, and ad columns an importable text-ad row requires. The template is
// undocumented-as-API and unversioned upstream, so the ONLY authority for
// this constant is the committed golden file produced by importing a
// hand-built CSV into the stakeholder ad account (PRD §14 Phase 1) — update
// TEMPLATE_GOLDEN_FILE_TEST_DATE when that test runs, and re-validate
// monthly. Gate wording is "conforms to the validated import template
// (golden-file tested <date>)", never "100% clean import".

import type { AdBrief, Variant } from '../types.js';

export const TEMPLATE_VERSION = 'meta-bulk-import-v1';

/**
 * Placeholder until the Phase 1 golden-file import runs against the
 * stakeholder ad account; the delivery report stamps this value.
 */
export const TEMPLATE_GOLDEN_FILE_TEST_DATE = 'PENDING-PHASE-1-GOLDEN-FILE-TEST';

export const META_BULK_TEMPLATE_HEADERS = [
  'Campaign Name',
  'Campaign Objective',
  'Campaign Status',
  'Ad Set Name',
  'Ad Set Status',
  'Ad Name',
  'Ad Status',
  'Title',
  'Body',
  'Link Description',
  'Display Link',
  'Link',
  'Image Hash',
] as const;

export const CSV_MAX_BYTES = 2 * 1024 * 1024;

/** RFC 4180: quote fields containing comma, quote, CR, or LF; double quotes. */
export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function displayLink(landingUrl: string): string {
  try {
    return new URL(landingUrl).hostname;
  } catch {
    return landingUrl;
  }
}

export function buildAdRow(variant: Variant, brief: AdBrief): string[] {
  return [
    brief.campaign.campaignName,
    brief.campaign.objective,
    'PAUSED', // imported drafts start paused; the buyer flips them live
    brief.campaign.adSetName,
    'PAUSED',
    `${brief.campaign.adSetName} — ${variant.angle} — ${variant.id}`,
    'PAUSED',
    variant.headline,
    variant.primaryText,
    variant.description,
    displayLink(brief.creative.landingUrl),
    brief.creative.landingUrl,
    brief.creative.imageRef,
  ];
}

/**
 * Assemble the deliverable CSV: exact template headers, RFC 4180 escaping,
 * CRLF line endings, UTF-8. Throws when the encoded output exceeds the 2 MB
 * template cap — a size violation must never ship.
 */
export function buildCsv(variants: Variant[], brief: AdBrief): string {
  const lines = [
    META_BULK_TEMPLATE_HEADERS.map(escapeCsvField).join(','),
    ...variants.map((v) => buildAdRow(v, brief).map(escapeCsvField).join(',')),
  ];
  const csv = lines.join('\r\n') + '\r\n';
  const bytes = new TextEncoder().encode(csv).byteLength;
  if (bytes > CSV_MAX_BYTES) {
    throw new Error(`CSV is ${bytes} bytes — exceeds the ${CSV_MAX_BYTES}-byte template cap`);
  }
  return csv;
}

// --- Template schema validation (FR-8) --------------------------------------

export interface CsvValidation {
  valid: boolean;
  errors: string[];
  rowCount: number;
  templateVersion: string;
  goldenFileTestDate: string;
}

/** Minimal RFC 4180 parser — enough to re-read our own output for validation. */
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < csv.length) {
    const ch = csv[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += ch === '\r' && csv[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop a trailing empty row produced by the final CRLF.
  return rows.filter((r, idx) => !(idx === rows.length - 1 && r.length === 1 && r[0] === ''));
}

/**
 * Validate a CSV against the golden-file template schema before delivery:
 * exact header set AND order, uniform column count, non-empty required copy
 * columns, size cap.
 */
export function validateCsvAgainstTemplate(csv: string): CsvValidation {
  const errors: string[] = [];
  const bytes = new TextEncoder().encode(csv).byteLength;
  if (bytes > CSV_MAX_BYTES) {
    errors.push(`size ${bytes} bytes exceeds ${CSV_MAX_BYTES}-byte cap`);
  }

  const rows = parseCsv(csv);
  const header = rows[0] ?? [];
  const expected: string[] = [...META_BULK_TEMPLATE_HEADERS];
  if (header.length !== expected.length || header.some((h, idx) => h !== expected[idx])) {
    errors.push(`header row does not match template ${TEMPLATE_VERSION}: got [${header.join(', ')}]`);
  }

  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    errors.push('no ad rows');
  }
  const requiredColumns = ['Campaign Name', 'Ad Set Name', 'Ad Name', 'Title', 'Body', 'Link'];
  dataRows.forEach((row, idx) => {
    if (row.length !== expected.length) {
      errors.push(`row ${idx + 1} has ${row.length} columns, expected ${expected.length}`);
      return;
    }
    for (const column of requiredColumns) {
      const value = row[expected.indexOf(column)];
      if (!value || value.trim().length === 0) {
        errors.push(`row ${idx + 1} is missing required column "${column}"`);
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    rowCount: dataRows.length,
    templateVersion: TEMPLATE_VERSION,
    goldenFileTestDate: TEMPLATE_GOLDEN_FILE_TEST_DATE,
  };
}
