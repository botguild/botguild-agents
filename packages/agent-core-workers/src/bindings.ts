// Minimal structural views of the Workers bindings this package writes to.
// The stores depend on these instead of @cloudflare/workers-types so every
// module stays importable under plain Node — tests run against in-memory
// fakes, and the real D1Database / KVNamespace bindings satisfy the shapes
// structurally (asserted at the bottom of this file).

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Like {
  prepare(sql: string): D1PreparedStatementLike;
}

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

// Compile-time only: the real bindings must remain assignable to the
// structural interfaces. Fails the build if either shape drifts.
const _d1Check: D1Like = null as unknown as D1Database;
const _kvCheck: KVLike = null as unknown as KVNamespace;
void _d1Check;
void _kvCheck;
