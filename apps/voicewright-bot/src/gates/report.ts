// JSON validation report builder (§8): the buyer-facing evidence artifact,
// generated from the same per-variant gate records the D1 audit log stores
// (FR-11). Per variant: grapheme counts, angle tag, pairwise diversity
// scores, moderation verdict snapshot, checklist results, advisory
// readability, regeneration attempts. Batch level: template version +
// golden-file test date, caps consumed, idempotency key.

import type { DiversityResult, PairScore, PriorCycleResult } from './diversity.js';
import type { CsvValidation } from './csv.js';
import type { JobOutcome, VariantState } from '../types.js';

export interface VariantReport {
  id: string;
  angle: string;
  headline: string;
  primaryText: string;
  description: string;
  status: string;
  graphemeCounts: Array<{
    field: string;
    graphemes: number;
    limit: number;
    marginApplied: boolean;
    pass: boolean;
  }>;
  diversityPairScores: PairScore[];
  moderation: unknown;
  checklist: unknown;
  readability: { advisory: true; lib: string; version: string; fleschKincaidGrade: number } | null;
  regenerationAttempts: number;
  failReason?: string;
}

export interface ValidationReport {
  reportVersion: 1;
  generatedAt: string;
  idempotencyKey: string;
  contractId: string;
  outcome: JobOutcome;
  variants: VariantReport[];
  batch: {
    variantCountRequested: number;
    variantCountDelivered: number;
    diversity: {
      pass: boolean;
      distinctAngles: number;
      requiredAngles: number;
      threshold: number;
      thresholdStatus: 'provisional-pending-phase-2-calibration';
      violations: PairScore[];
    };
    priorCycle: { pass: boolean; threshold: number; violations: PairScore[] } | null;
    csv: CsvValidation | null;
    capsConsumed: {
      spendUsd: number;
      spendCapUsd: number;
      batchRounds: number;
      batchRoundCap: number;
      regenCapPerVariant: number;
    };
    shortfall: Array<{ variantId: string; reason: string }>;
  };
}

export interface BuildReportInput {
  jobKey: string;
  contractId: string;
  outcome: JobOutcome;
  variantCountRequested: number;
  variantStates: VariantState[];
  deliveredIds: string[];
  diversity: DiversityResult;
  priorCycle: PriorCycleResult | null;
  csv: CsvValidation | null;
  spendUsd: number;
  spendCapUsd: number;
  batchRounds: number;
  batchRoundCap: number;
  regenCapPerVariant: number;
  now?: () => Date;
}

export function buildValidationReport(input: BuildReportInput): ValidationReport {
  const delivered = new Set(input.deliveredIds);
  const pairScoresFor = (variantId: string): PairScore[] =>
    input.diversity.pairScores.filter((p) => p.aId === variantId || p.bId === variantId);

  const variants: VariantReport[] = input.variantStates.map((state) => {
    const report: VariantReport = {
      id: state.variant.id,
      angle: state.variant.angle,
      headline: state.variant.headline,
      primaryText: state.variant.primaryText,
      description: state.variant.description,
      status: delivered.has(state.variant.id) ? 'delivered' : state.status,
      graphemeCounts: state.evidence.length ?? [],
      diversityPairScores: pairScoresFor(state.variant.id),
      moderation: state.evidence.moderation ?? null,
      checklist: state.evidence.checklist ?? null,
      readability: state.evidence.readability
        ? { advisory: true, ...state.evidence.readability }
        : null,
      regenerationAttempts: state.regenAttempts,
    };
    if (state.failReason !== undefined) report.failReason = state.failReason;
    return report;
  });

  const shortfall = input.variantStates
    .filter((state) => !delivered.has(state.variant.id))
    .map((state) => ({ variantId: state.variant.id, reason: state.failReason ?? state.status }));

  return {
    reportVersion: 1,
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    idempotencyKey: input.jobKey,
    contractId: input.contractId,
    outcome: input.outcome,
    variants,
    batch: {
      variantCountRequested: input.variantCountRequested,
      variantCountDelivered: input.deliveredIds.length,
      diversity: {
        pass: input.diversity.pass,
        distinctAngles: input.diversity.distinctAngles,
        requiredAngles: input.diversity.requiredAngles,
        threshold: input.diversity.threshold,
        thresholdStatus: 'provisional-pending-phase-2-calibration',
        violations: input.diversity.violations,
      },
      priorCycle: input.priorCycle
        ? {
            pass: input.priorCycle.pass,
            threshold: input.priorCycle.threshold,
            violations: input.priorCycle.violations,
          }
        : null,
      csv: input.csv,
      capsConsumed: {
        spendUsd: Number(input.spendUsd.toFixed(6)),
        spendCapUsd: input.spendCapUsd,
        batchRounds: input.batchRounds,
        batchRoundCap: input.batchRoundCap,
        regenCapPerVariant: input.regenCapPerVariant,
      },
      shortfall,
    },
  };
}
