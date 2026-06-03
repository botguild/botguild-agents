import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NegotiationMemory } from './negotiation.js';

// Persists the set of proposal ids we've already countered, so the
// "counter back once, then decline" policy survives restarts/redeploys.
// Without this, a restart mid-negotiation would re-counter a proposal we'd
// already pushed back on, and the turn-based loop could ping-pong forever.
// Flat-file under the same /app/data volume as jobs.json / webhook-secret.json.

export interface NegotiationStoreConfig {
  /** Directory for persistent state. Defaults to `<cwd>/data`, matching the
   * jobs.json convention; Fly mounts this from a volume. */
  dataDir?: string;
}

function resolveFile(config: NegotiationStoreConfig): { dir: string; file: string } {
  const dir = config.dataDir ?? join(process.cwd(), 'data');
  return { dir, file: join(dir, 'negotiation.json') };
}

export function createNegotiationMemory(config: NegotiationStoreConfig = {}): NegotiationMemory {
  const { dir, file } = resolveFile(config);
  const countered = new Set<string>();

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
      if (Array.isArray(parsed)) {
        for (const id of parsed) if (typeof id === 'string') countered.add(id);
      }
    } catch {
      // Corrupt/partial file — start empty rather than crash on boot.
    }
  }

  function persist(): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(Array.from(countered)), 'utf-8');
  }

  return {
    hasCountered(proposalId: string): boolean {
      return countered.has(proposalId);
    },
    markCountered(proposalId: string): void {
      if (countered.has(proposalId)) return;
      countered.add(proposalId);
      persist();
    },
    clear(proposalId: string): void {
      if (!countered.delete(proposalId)) return;
      persist();
    },
  };
}
