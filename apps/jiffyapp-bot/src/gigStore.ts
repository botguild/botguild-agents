// D1 store for proposal-time compilation (`gig_briefs`, FR-3 persistence): what a gig
// classified to, and — for builds — the exact goldens compiled and shown to the buyer
// before they accepted. Exists before any contract, keyed by gig id, and kept out of
// jobs.ts (Task 11) so proposal-time code carries no job/contract dependency.

import type { D1Like } from '@botguild/agent-core-workers';
import type { GoldenSet, JiffyBrief, TemplateId } from './types.js';

export interface GigBriefRow {
  gigId: string;
  kind: 'build' | 'cycle';
  templateId?: TemplateId;
  templateVersion?: string;
  toolId?: string;
  brief?: JiffyBrief;
  goldens?: GoldenSet;
  compiledAt: string;
}

interface RawGigBriefRow {
  gig_id: string;
  kind: 'build' | 'cycle';
  template_id: string | null;
  template_version: string | null;
  tool_id: string | null;
  brief_json: string | null;
  goldens_json: string | null;
  compiled_at: string;
}

function toGigBriefRow(raw: RawGigBriefRow): GigBriefRow {
  return {
    gigId: raw.gig_id,
    kind: raw.kind,
    templateId: (raw.template_id ?? undefined) as TemplateId | undefined,
    templateVersion: raw.template_version ?? undefined,
    toolId: raw.tool_id ?? undefined,
    brief: raw.brief_json ? (JSON.parse(raw.brief_json) as JiffyBrief) : undefined,
    goldens: raw.goldens_json ? (JSON.parse(raw.goldens_json) as GoldenSet) : undefined,
    compiledAt: raw.compiled_at,
  };
}

export interface GigStore {
  /** INSERT OR REPLACE — a re-proposal (e.g. after a thread correction) overwrites cleanly. */
  saveBuild(row: {
    gigId: string;
    templateId: TemplateId;
    templateVersion: string;
    brief: JiffyBrief;
    goldens: GoldenSet;
  }): Promise<void>;
  saveCycle(row: { gigId: string; toolId: string }): Promise<void>;
  get(gigId: string): Promise<GigBriefRow | null>;
}

export function createGigStore(db: D1Like, now: () => Date = () => new Date()): GigStore {
  return {
    async saveBuild({ gigId, templateId, templateVersion, brief, goldens }): Promise<void> {
      await db
        .prepare(
          `INSERT OR REPLACE INTO gig_briefs
             (gig_id, kind, template_id, template_version, tool_id, brief_json, goldens_json, compiled_at)
           VALUES (?, 'build', ?, ?, NULL, ?, ?, ?)`,
        )
        .bind(
          gigId,
          templateId,
          templateVersion,
          JSON.stringify(brief),
          JSON.stringify(goldens),
          now().toISOString(),
        )
        .run();
    },

    async saveCycle({ gigId, toolId }): Promise<void> {
      await db
        .prepare(
          `INSERT OR REPLACE INTO gig_briefs
             (gig_id, kind, template_id, template_version, tool_id, brief_json, goldens_json, compiled_at)
           VALUES (?, 'cycle', NULL, NULL, ?, NULL, NULL, ?)`,
        )
        .bind(gigId, toolId, now().toISOString())
        .run();
    },

    async get(gigId): Promise<GigBriefRow | null> {
      const raw = await db
        .prepare('SELECT * FROM gig_briefs WHERE gig_id = ?')
        .bind(gigId)
        .first<RawGigBriefRow>();
      return raw ? toGigBriefRow(raw) : null;
    },
  };
}
