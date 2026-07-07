// D1 store for the recurring tier (FR-10): stored briefs keyed by the briefId
// issued at first delivery, plus the prior-cycle delivered variants that feed
// the differs-from-prior-cycle gate.

import type { D1Like } from '@botguild/agent-core-workers';
import type { AdBrief, Variant } from './types.js';

export interface StoredBrief {
  briefId: string;
  originContractId: string;
  brief: AdBrief;
  cycle: number;
  nextDueAt: string | null;
  lastNudgedCycle: number;
}

interface RawBriefRow {
  brief_id: string;
  origin_contract_id: string;
  brief_json: string;
  cycle: number;
  next_due_at: string | null;
  last_nudged_cycle: number;
}

function toStoredBrief(raw: RawBriefRow): StoredBrief {
  return {
    briefId: raw.brief_id,
    originContractId: raw.origin_contract_id,
    brief: JSON.parse(raw.brief_json) as AdBrief,
    cycle: raw.cycle,
    nextDueAt: raw.next_due_at,
    lastNudgedCycle: raw.last_nudged_cycle,
  };
}

export interface BriefStore {
  create(input: { briefId: string; originContractId: string; brief: AdBrief; nextDueAt: Date }): Promise<void>;
  get(briefId: string): Promise<StoredBrief | null>;
  /**
   * Record the just-delivered refresh cycle as the brief's last-delivered cycle.
   * Set explicitly (not `cycle + 1`) so a queue retry of the same producedCycle
   * is idempotent and cannot skip a cycle.
   */
  completeCycle(briefId: string, cycle: number, nextDueAt: Date): Promise<void>;
  /** Briefs whose cycle is due and not yet nudged this cycle (daily cron). */
  listDue(asOf: Date): Promise<StoredBrief[]>;
  markNudged(briefId: string, cycle: number): Promise<void>;
  saveCycleVariants(briefId: string, cycle: number, variants: Variant[]): Promise<void>;
  /** All variants delivered in cycles before `cycle` (the prior-cycle gate input). */
  priorCycleVariants(briefId: string, cycle: number): Promise<Variant[]>;
}

export function createBriefStore(db: D1Like, now: () => Date = () => new Date()): BriefStore {
  return {
    async create({ briefId, originContractId, brief, nextDueAt }): Promise<void> {
      const ts = now().toISOString();
      await db
        .prepare(
          `INSERT INTO briefs (brief_id, origin_contract_id, brief_json, cycle, next_due_at, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?)`,
        )
        .bind(briefId, originContractId, JSON.stringify(brief), nextDueAt.toISOString(), ts, ts)
        .run();
    },

    async get(briefId): Promise<StoredBrief | null> {
      const raw = await db.prepare('SELECT * FROM briefs WHERE brief_id = ?').bind(briefId).first<RawBriefRow>();
      return raw ? toStoredBrief(raw) : null;
    },

    async completeCycle(briefId, cycle, nextDueAt): Promise<void> {
      await db
        .prepare('UPDATE briefs SET cycle = ?, next_due_at = ?, updated_at = ? WHERE brief_id = ?')
        .bind(cycle, nextDueAt.toISOString(), now().toISOString(), briefId)
        .run();
    },

    async listDue(asOf): Promise<StoredBrief[]> {
      const { results } = await db
        .prepare('SELECT * FROM briefs WHERE next_due_at IS NOT NULL AND next_due_at <= ? AND last_nudged_cycle < cycle')
        .bind(asOf.toISOString())
        .all<RawBriefRow>();
      return results.map(toStoredBrief);
    },

    async markNudged(briefId, cycle): Promise<void> {
      await db
        .prepare('UPDATE briefs SET last_nudged_cycle = ?, updated_at = ? WHERE brief_id = ?')
        .bind(cycle, now().toISOString(), briefId)
        .run();
    },

    async saveCycleVariants(briefId, cycle, variants): Promise<void> {
      const ts = now().toISOString();
      for (const v of variants) {
        await db
          .prepare(
            `INSERT OR REPLACE INTO cycle_variants (brief_id, cycle, variant_id, angle, headline, primary_text, description, delivered_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(briefId, cycle, v.id, v.angle, v.headline, v.primaryText, v.description, ts)
          .run();
      }
    },

    async priorCycleVariants(briefId, cycle): Promise<Variant[]> {
      const { results } = await db
        .prepare('SELECT variant_id, angle, headline, primary_text, description FROM cycle_variants WHERE brief_id = ? AND cycle < ?')
        .bind(briefId, cycle)
        .all<{ variant_id: string; angle: string; headline: string; primary_text: string; description: string }>();
      return results.map((r) => ({
        id: r.variant_id,
        angle: r.angle,
        headline: r.headline,
        primaryText: r.primary_text,
        description: r.description,
      }));
    },
  };
}
