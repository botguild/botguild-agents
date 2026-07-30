// Node-only test helper — NEVER import from Worker code (it reads the
// migration file from disk). Applying the shipped migrations to the in-memory
// SQLite double guarantees tests exercise the exact schema a real D1 database
// gets from `wrangler d1 migrations apply`.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { D1Like } from '@botguild/agent-core-workers';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Apply every migration in `migrations/` (in filename order) against `db`. */
export async function applyMigrations(db: D1Like): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql
      .split(/;\s*\n/)
      .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await db.prepare(statement).run();
    }
  }
}
