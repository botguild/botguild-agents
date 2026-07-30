// STUB — replaced wholesale by Task 18 (pipeline stage 1: capped regeneration
// loop to M1) and extended by Task 21 (stage 2: pack/report/M2 delivery).
//
// Exists only so Task 12's index.ts type-checks against the real service
// graph it builds in getServices() — `PipelineConfig` here matches that
// object literal field-for-field. `processJobMessage` throws; nothing is
// wired. Deliberately omits `runConceptStage`/`decideSlotAction`/`SlotAction`/
// `StageOutcome`/`runVectorStage` from the task-18/21 briefs: index.ts never
// imports them, and guessing their shape now would just be replaced anyway.

import type { Logger } from 'pino';
import type { AgentClient } from '@botguild/agent-core';
import type { ConceptStore, JobStore, QuotaStore, SelectionStore } from './jobs.js';
import type { WasmSources } from './pack/wasm.js';
import type { AiLike, FetchLike, JobMessage } from './types.js';

/** R2 seam for the deliverable bytes (put) and stage-2 artifact read-back (get). */
export interface DeliverableStore {
  put(key: string, value: Uint8Array, contentType: string): Promise<void>;
  /** Stage 2 reads the winner's stage-1 artifacts back (Task 21); null on a miss. */
  get(key: string): Promise<Uint8Array | null>;
}

/** Vendor API keys the pipeline needs (moderation, generation, vectorizer, fonts). */
export interface PipelineSecrets {
  moderationApiKey: string;
  anthropicApiKey: string;
  ideogramApiKey: string;
  recraftApiKey: string;
  vectorizerToken: string;
  googleFontsApiKey: string;
}

export interface PipelineConfig {
  jobs: JobStore;
  concepts: ConceptStore;
  selection: SelectionStore;
  quota: QuotaStore;
  client: AgentClient;
  ai: AiLike;
  deliverables: DeliverableStore;
  /** Once-per-isolate wasm sources for the pack stack (pack/wasm.ts memoizes init). */
  sources: WasmSources;
  secrets: PipelineSecrets;
  fetchImpl: FetchLike;
  /** Public base URL of this Worker — deliverable/progress-page URLs are Worker-served. */
  publicBaseUrl: string;
  logger: Logger;
}

export async function processJobMessage(
  _config: PipelineConfig,
  _message: JobMessage,
): Promise<void> {
  throw new Error('not implemented');
}
