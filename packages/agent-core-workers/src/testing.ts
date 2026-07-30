import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import type { D1Like, D1PreparedStatementLike, KVLike } from './bindings.js';

// Node-only test doubles, published under the './testing' subpath so bot
// packages can unit-test their D1/KV code without Miniflare. Never import
// this module from Worker code — it depends on node:sqlite.

/**
 * A D1Like backed by an in-memory node:sqlite database. D1 *is* SQLite, so
 * statements exercise real SQL semantics (unique constraints, upserts)
 * instead of a hand-rolled approximation.
 */
export function createMemoryD1(): D1Like {
  const db = new DatabaseSync(':memory:');

  return {
    prepare(sql: string): D1PreparedStatementLike {
      let params: SQLInputValue[] = [];
      const statement: D1PreparedStatementLike = {
        bind(...values: unknown[]): D1PreparedStatementLike {
          params = values as SQLInputValue[];
          return statement;
        },
        async first<T = unknown>(): Promise<T | null> {
          return (db.prepare(sql).get(...params) as T | undefined) ?? null;
        },
        async all<T = unknown>(): Promise<{ results: T[] }> {
          return { results: db.prepare(sql).all(...params) as T[] };
        },
        async run(): Promise<unknown> {
          return db.prepare(sql).run(...params);
        },
      };
      return statement;
    },
  };
}

/** An in-memory KVLike. TTLs are recorded but never expire (tests are fast). */
export function createMemoryKV(): KVLike & {
  store: Map<string, { value: string; expirationTtl?: number }>;
} {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  return {
    store,
    async get(key: string): Promise<string | null> {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      store.set(key, { value, expirationTtl: options?.expirationTtl });
    },
  };
}
