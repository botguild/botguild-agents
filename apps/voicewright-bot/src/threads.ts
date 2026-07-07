// Contract-thread reading (FR-1): post-funding brief corrections arrive as
// buyer thread posts, and AgentClient only writes messages — so this module
// reads them with the same auth + casing conventions (X-API-Key,
// mapKeysToCamel). Polled from the 15-min cron sweep for jobs parked with
// reason 'brief_invalid'.

import { mapKeysToCamel } from '@botguild/agent-core';

export interface ThreadMessage {
  id: string;
  content: string;
  botId?: string;
  senderType?: string;
  createdAt?: string;
}

export interface ThreadReaderConfig {
  apiUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface ThreadReader {
  /** Messages of the contract's thread, oldest first. [] when no thread yet. */
  fetchContractMessages(contractId: string): Promise<ThreadMessage[]>;
}

export function createThreadReader(config: ThreadReaderConfig): ThreadReader {
  const apiUrl = config.apiUrl.replace(/\/$/, '');
  const fetchImpl = config.fetchImpl ?? fetch;

  async function getJson<T>(path: string): Promise<T> {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      headers: { 'X-API-Key': config.apiKey },
    });
    if (!response.ok) {
      throw new Error(`GET ${path} responded ${response.status}`);
    }
    return mapKeysToCamel(await response.json()) as T;
  }

  return {
    async fetchContractMessages(contractId: string): Promise<ThreadMessage[]> {
      const query = new URLSearchParams({ scope: 'contract', scopeId: contractId, limit: '1' });
      const threads = await getJson<{ threads?: Array<{ id: string }> }>(`/threads?${query.toString()}`);
      const threadId = threads.threads?.[0]?.id;
      if (!threadId) return [];
      const res = await getJson<{ messages?: ThreadMessage[] }>(`/threads/${threadId}/messages`);
      return res.messages ?? [];
    },
  };
}

/**
 * Newest buyer-posted message that parses into a valid result via `parse`
 * (e.g. parseAdBrief). Messages from this bot are skipped — the correction
 * request itself quotes field names and must never be mistaken for a brief.
 */
export function findLatestCorrection<T>(
  messages: ThreadMessage[],
  botId: string,
  parse: (content: string) => { ok: true; brief: T } | { ok: false; errors: unknown },
): T | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as ThreadMessage;
    if (message.botId === botId) continue;
    const parsed = parse(message.content ?? '');
    if (parsed.ok) return parsed.brief;
  }
  return undefined;
}
