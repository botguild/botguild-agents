// Node-only test helper: replays migrations/*.sql into an in-memory D1 so tests
// exercise the exact schema `wrangler d1 migrations apply` produces.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { D1Like } from '@botguild/agent-core-workers';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function applyMigrations(db: D1Like): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
      .filter((s) => s.length > 0);
    for (const statement of statements) {
      await db.prepare(statement).run();
    }
  }
}
