import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface CheckRecord {
  timestamp: string;
  status: 'up' | 'down' | 'changed' | 'unchanged';
  detail?: string;
  screenshotBase64?: string;
}

export interface JobState {
  gigId: string;
  contractId: string;
  status: 'up' | 'down' | 'unknown';
  lastCheckedAt: string;
  lastStatusCode?: number;
  lastResponseMs?: number;
  lastError?: string;
  snapshotHash?: string;
  snapshotExcerpt?: string;
  accumulatedResults?: CheckRecord[];
  milestoneSchedule?: string;
  checkSchedule?: string;
  // Persisted job config so we can restore cron schedules after a restart.
  watchConfig?: unknown;
  milestoneIndex?: number;
  // Lifecycle gates work execution on escrow funding. Jobs in
  // 'awaiting_funding' are parsed + planned but no cron is scheduled and no
  // first check is run until milestone.funded fires.
  lifecycle?: 'awaiting_funding' | 'active';
  // Extra kickoff context preserved across proposal.accepted → milestone.funded.
  pendingKickoff?: {
    isStandingOffer: boolean;
    milestoneDates?: string[];
  };
}

export function listJobs(): JobState[] {
  return Array.from(store.values());
}

export function deleteJob(contractId: string): void {
  store.delete(contractId);
  saveStore();
}

const DATA_DIR = join(process.cwd(), 'data');
const JOBS_FILE = join(DATA_DIR, 'jobs.json');

let store: Map<string, JobState> = new Map();

export function loadStore(): void {
  if (!existsSync(JOBS_FILE)) {
    return;
  }
  try {
    const raw = readFileSync(JOBS_FILE, 'utf-8');
    const entries = JSON.parse(raw) as Array<[string, JobState]>;
    store = new Map(entries);
  } catch {
    store = new Map();
  }
}

export function saveStore(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(JOBS_FILE, JSON.stringify(Array.from(store.entries()), null, 2), 'utf-8');
}

export function getJob(contractId: string): JobState | undefined {
  return store.get(contractId);
}

export function setJob(contractId: string, state: JobState): void {
  store.set(contractId, state);
  saveStore();
}
