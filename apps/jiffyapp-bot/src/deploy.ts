// Workers-for-Platforms dispatch-namespace deployer (Task 14): the only place that talks to
// Cloudflare's REST API to PUT/DELETE a tool's Worker script into the shared dispatch
// namespace, plus an in-namespace "does it serve" check via the DISPATCH binding itself
// (staging scripts never get a public host, so the only way to confirm one is live is to
// route a request through the dispatcher binding rather than hit a public URL).
//
// putScript/deleteScript retry exactly once on a network throw or a 5xx response (1s
// backoff, injectable via `sleep` so tests never actually wait); a 4xx is treated as a
// permanent failure and thrown immediately with no retry. checkServes never throws — a
// script that hasn't been deployed yet (or was just deleted) makes
// `dispatch.get(slug).fetch(...)` throw a binding error, which normalizes to
// `{ ok: false, status: 0 }` rather than propagating.

import type { Logger } from 'pino';

/** Structural view of env.DISPATCH — the Workers-for-Platforms dispatch namespace binding. */
export interface DispatchLike {
  get(name: string): { fetch(request: Request | string): Promise<Response> };
}

export interface ToolDeployer {
  /** Full-script PUT (idempotent overwrite). Throws DeployError on non-2xx. */
  putScript(slug: string, script: string): Promise<void>;
  /** 404 tolerated — deleting an already-gone script is not an error. */
  deleteScript(slug: string): Promise<void>;
  /** In-namespace 200 check via the DISPATCH binding (staging never has a public host). */
  checkServes(slug: string): Promise<{ ok: boolean; status: number }>;
}

export class DeployError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DeployError';
  }
}

export interface ToolDeployerConfig {
  accountId: string;
  namespace: string;
  apiToken: string;
  dispatch: DispatchLike;
  /** Injectable for tests — never call the live Cloudflare API from a test. */
  fetchImpl?: typeof fetch;
  /** Injectable backoff sleep — tests pass a no-op so the single retry doesn't wait. */
  sleep?: (ms: number) => Promise<void>;
  logger: Logger;
}

const COMPATIBILITY_DATE = '2026-06-01';
const RETRY_BACKOFF_MS = 1000;
const BODY_EXCERPT_LIMIT = 200;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function excerpt(text: string): string {
  return text.length > BODY_EXCERPT_LIMIT ? text.slice(0, BODY_EXCERPT_LIMIT) : text;
}

export function createToolDeployer(config: ToolDeployerConfig): ToolDeployer {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const sleep = config.sleep ?? defaultSleep;
  const { accountId, namespace, apiToken, dispatch, logger } = config;

  function scriptUrl(slug: string): string {
    const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts`;
    // Defensive: slugs are already constrained to [a-z0-9-] elsewhere, but this is the one
    // place a bad slug would corrupt a URL path, so encode unconditionally.
    return `${base}/${encodeURIComponent(slug)}`;
  }

  /** One fetch, with a single retry on network throw or 5xx (1s backoff). A 4xx — or any
   *  response at all on the first try — returns immediately with no retry. */
  async function requestWithRetry(url: string, init: RequestInit): Promise<Response> {
    let response: Response | undefined;
    let thrown: unknown;

    try {
      response = await fetchImpl(url, init);
    } catch (err) {
      thrown = err;
    }

    if (response && response.status < 500) {
      return response;
    }

    logger.warn(
      { url, method: init.method, status: response?.status, err: thrown },
      'deploy: retrying after failed request',
    );
    await sleep(RETRY_BACKOFF_MS);

    return fetchImpl(url, init);
  }

  return {
    async putScript(slug, script) {
      const form = new FormData();
      form.set(
        'metadata',
        new Blob(
          [JSON.stringify({ main_module: 'index.mjs', compatibility_date: COMPATIBILITY_DATE })],
          { type: 'application/json' },
        ),
      );
      form.set(
        'index.mjs',
        new File([script], 'index.mjs', { type: 'application/javascript+module' }),
      );

      const response = await requestWithRetry(scriptUrl(slug), {
        method: 'PUT',
        headers: { Authorization: `Bearer ${apiToken}` },
        body: form,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new DeployError(response.status, excerpt(body));
      }
    },

    async deleteScript(slug) {
      const response = await requestWithRetry(scriptUrl(slug), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiToken}` },
      });

      if (response.status === 200 || response.status === 404) return;

      const body = await response.text().catch(() => '');
      throw new DeployError(response.status, excerpt(body));
    },

    async checkServes(slug) {
      try {
        const res = await dispatch.get(slug).fetch('https://tool.internal/');
        return { ok: res.status === 200, status: res.status };
      } catch {
        return { ok: false, status: 0 };
      }
    },
  };
}
