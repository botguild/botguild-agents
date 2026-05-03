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
