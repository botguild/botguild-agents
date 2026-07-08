// Domain types shared across the bot. No Workers globals — node-testable everywhere.

export const TEMPLATE_IDS = [
  'landing',
  'calculator',
  'form',
  'csv-dashboard',
  'widget',
  'link-in-bio',
  'pricing-table',
  'quiz',
  'waitlist',
  'transformer',
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/** Fenced-JSON brief from the gig description (PRD §8). Unknown keys pass through to codegen. */
export interface JiffyBrief {
  template?: string;
  name: string;
  description: string;
  copy?: Record<string, unknown>;
  logic?: string;
  brand?: { accentHex?: string };
  slugPreference?: string;
  notifyEmail?: string;
  [key: string]: unknown;
}

// ---- Golden examples (templates PRD §1.4 — the ONLY assertion vocabulary) ----

export type GoldenStep =
  | { do: 'load' }
  | { do: 'fill'; fields: Record<string, string | boolean> } // testid → value; boolean = checkbox
  | { do: 'select'; fields: Record<string, string> }
  | { do: 'click'; testid: string; nth?: number }
  | { do: 'paste'; testid: string; text?: string; fixture?: string } // exactly one of text|fixture (fixture = key into GoldenSet.fixtures)
  | { do: 'upload'; testid: string; fixture: string }; // fixture = key into GoldenSet.fixtures

export type GoldenExpectation =
  | { testid: string; nth?: number; equals: string }
  | { testid: string; nth?: number; contains: string }
  | { testid: string; count: number }
  | { testid: string; nth?: number; visible: true }
  | { testid: string; nth?: number; hidden: true }
  | { testid: string; nth?: number; hrefEquals: string }
  | { testid: string; nth?: number; hrefStartsWith: string }
  | { testid: string; nth?: number; attrEquals: { attr: string; value: string } }
  | { titleEquals: string }
  | { metaEquals: { property: string; value: string } };

export interface GoldenExample {
  title: string; // human-readable row in the proposal table
  steps: GoldenStep[]; // executor always loads the page first; steps may be []
  expect: GoldenExpectation[];
}

export interface GoldenSet {
  goldens: GoldenExample[]; // 3–7 per FR-3
  fixtures?: Record<string, string>; // e.g. golden CSV content for upload/paste steps
}

// ---- Jobs ----

export type JobKind = 'build' | 'cycle' | 'edit';

export interface JobMessage {
  kind: JobKind;
  contractId: string;
  jobKey: string; // sha256(contractId) + ':' + stage
  toolId?: string; // cycle + edit
  requestId?: string; // edit (thread message id)
}

export type ToolStatus = 'building' | 'live' | 'grace' | 'suspended' | 'killed';

// ---- Generated tool files ----

export interface FileEntry {
  content: string;
  contentType: string;
  encoding?: 'base64'; // binary assets (re-hosted images)
}
export type FileSet = Record<string, FileEntry>; // path ('/index.html') → entry

export type SlotValues = Record<string, unknown>;
