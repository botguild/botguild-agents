import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface FlowJobState {
  gigId: string;
  contractId: string;
  inputType: string;
  status:
    | 'pending'
    | 'awaiting_funding'
    | 'fetching'
    | 'transforming'
    | 'delivering'
    | 'complete'
    | 'error'
    | 'awaiting_input'
    | 'recurring';
  currentMilestoneIndex: number;
  updatedAt: string;
  // Standing-offer recurring state. Present only on data-sync packages so we can
  // re-register the weekly cron after a restart.
  standing?: {
    standingType: 'data-sync' | 'invoice-batch';
    inputSource: string;
    outputFormat: 'csv' | 'json' | 'airtable';
    targetSchema: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'date' }>;
    transformRules: Record<string, unknown>;
    remainingMilestoneIds: string[];
  };
  // Stash the gig + contract from proposal.accepted so milestone.funded can
  // replay the kickoff once escrow is funded. Cleared once work begins.
  pendingAcceptance?: {
    gig: unknown;
    contract: unknown;
  };
}

export function listJobs(): FlowJobState[] {
  return Array.from(store.values());
}

const DATA_DIR = join(process.cwd(), 'data');
const JOBS_FILE = join(DATA_DIR, 'jobs.json');

let store: Map<string, FlowJobState> = new Map();

export function loadStore(): void {
  if (!existsSync(JOBS_FILE)) {
    return;
  }
  try {
    const raw = readFileSync(JOBS_FILE, 'utf-8');
    const entries = JSON.parse(raw) as Array<[string, FlowJobState]>;
    store = new Map(entries);
  } catch {
    store = new Map();
  }
}

export function saveStore(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(JOBS_FILE, JSON.stringify(Array.from(store.entries()), null, 2), 'utf-8');
}

export function getJob(contractId: string): FlowJobState | undefined {
  return store.get(contractId);
}

export function setJob(contractId: string, state: FlowJobState): void {
  store.set(contractId, state);
  saveStore();
}

export function deleteJob(contractId: string): void {
  store.delete(contractId);
  saveStore();
}
