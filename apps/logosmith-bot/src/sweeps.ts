// STUB — replaced wholesale by Task 22 (cron sweeps). Exists only so Task 12's
// index.ts type-checks against the real service graph it builds in
// getServices() (`SweepServices`) and against the shape of the smaller
// `selectionDeps()` object the webhook handlers build for
// `resolveSelectionForContract` (`SelectionResolutionDeps`). Every export
// here throws; nothing is wired. Deliberately omits `decideDefaultSelection`
// from the task-22 brief: index.ts never imports it.

import type { Logger } from 'pino';
import type { AgentClient, CostEstimator, Proposer, ReputationSource } from '@botguild/agent-core';
import type { D1Like, D1NegotiationStore, SeenStore } from '@botguild/agent-core-workers';
import type { ConceptStore, JobStore, SelectionStore } from './jobs.js';
import type { JobMessage } from './types.js';

/** Structural queue seam — env.JOBS (`Queue<JobMessage>`) satisfies this shape. */
export interface JobQueueLike {
  send(message: JobMessage): Promise<unknown>;
}

export interface SweepServices {
  db: D1Like;
  client: AgentClient;
  jobs: JobStore;
  concepts: ConceptStore;
  selection: SelectionStore;
  seen: SeenStore;
  negotiationStore: D1NegotiationStore;
  reputationSource: ReputationSource;
  proposer: Proposer;
  /** Estimator-free proposer for FREE gigs (favicon/taster) — see config.ts. */
  freeProposer: Proposer;
  costEstimator: CostEstimator;
  queue: JobQueueLike;
  apiUrl: string;
  apiKey: string;
  botId: string;
  logger: Logger;
}

/**
 * The smaller deps shape `resolveSelectionForContract` needs — shared by the
 * cron selection poll and the `milestone.accepted`/`acceptance.auto_approved`
 * webhook handlers, which build this object directly rather than holding a
 * full `SweepServices`.
 */
export interface SelectionResolutionDeps {
  client: AgentClient;
  jobs: JobStore;
  selection: SelectionStore;
  queue: JobQueueLike;
  apiUrl: string;
  apiKey: string;
  botId: string;
  logger: Logger;
}

export async function runFifteenMinuteSweep(_services: SweepServices): Promise<void> {
  throw new Error('not implemented');
}

export async function runDailySweep(_services: SweepServices): Promise<void> {
  throw new Error('not implemented');
}

export async function resolveSelectionForContract(
  _deps: SelectionResolutionDeps,
  _contractId: string,
  _opts?: { force?: boolean },
): Promise<void> {
  throw new Error('not implemented');
}
