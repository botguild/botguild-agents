// Node-only test helper — NEVER import from Worker code (it reads the migration
// file from disk). Applying the shipped migrations to the in-memory SQLite
// double guarantees tests exercise the exact schema a real D1 database gets from
// `wrangler d1 migrations apply`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { D1Like } from '@botguild/agent-core-workers';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Execute every statement of migrations/0001_init.sql against `db`. */
export async function applyMigrations(db: D1Like): Promise<void> {
  const sql = readFileSync(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8');
  const statements = sql
    .split(/;\s*\n/)
    .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}
