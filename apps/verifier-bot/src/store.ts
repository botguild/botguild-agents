import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult } from './runners/http.js';

export interface VerifierJobState {
  gigId: string;
  contractId: string;
  checkType: string;
  status: 'pending' | 'awaiting_funding' | 'running' | 'delivering' | 'complete' | 'error';
  checkResults: CheckResult[];
  updatedAt: string;
  // Persisted plan + cursor so a restart can re-register cron jobs for
  // standing-offer smoke-test contracts that haven't finished yet.
  standingType?: 'smoke-test' | 'acceptance-review';
  standingPlan?: unknown;
  milestoneIndex?: number;
  // Stash the gig + contract from proposal.accepted so milestone.funded can
  // replay the kickoff once escrow is funded. Cleared once work begins.
  pendingAcceptance?: {
    gig: unknown;
    contract: unknown;
  };
}

export function listJobs(): VerifierJobState[] {
  return Array.from(store.values());
}

export function deleteJob(contractId: string): void {
  store.delete(contractId);
  saveStore();
}

const DATA_DIR = join(process.cwd(), 'data');
const JOBS_FILE = join(DATA_DIR, 'jobs.json');

let store: Map<string, VerifierJobState> = new Map();

export function loadStore(): void {
  if (!existsSync(JOBS_FILE)) {
    return;
  }
  try {
    const raw = readFileSync(JOBS_FILE, 'utf-8');
    const entries = JSON.parse(raw) as Array<[string, VerifierJobState]>;
    store = new Map(entries);
  } catch {
    store = new Map();
  }
}

export function saveStore(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(JOBS_FILE, JSON.stringify(Array.from(store.entries()), null, 2), 'utf-8');
}

export function getJob(contractId: string): VerifierJobState | undefined {
  return store.get(contractId);
}

export function setJob(contractId: string, state: VerifierJobState): void {
  store.set(contractId, state);
  saveStore();
}
