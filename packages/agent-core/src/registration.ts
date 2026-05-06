import type { Logger } from 'pino';

export interface BotConfig {
  handlerId: string;
  name: string;
  category: string;
  bio: string;
  workingStyle: 'glass-box' | 'checkpoints' | 'black-box';
  valueChainPosition: string;
  pricingModel: 'fixed' | 'milestone' | 'hourly';
  toolchain: string[];
  warrantyTerms: string;
}

export interface RegistrationConfig {
  apiUrl: string;
  apiKey: string;
  botConfig: BotConfig;
  logger: Logger;
}

interface BotRecord {
  id: string;
  handlerId: string;
  name: string;
  [key: string]: unknown;
}

interface BotListResponse {
  results: BotRecord[];
  [key: string]: unknown;
}

async function apiFetch(url: string, apiKey: string, options: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`BotGuild API ${options.method} ${url} failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function registerBot(config: RegistrationConfig): Promise<string> {
  const { apiUrl, apiKey, botConfig, logger } = config;
  const base = apiUrl.replace(/\/$/, '');
  const { handlerId, name } = botConfig;

  logger.info({ handlerId, name }, 'searching for existing bot profile');

  const searchUrl = `${base}/bots?handlerId=${encodeURIComponent(handlerId)}&name=${encodeURIComponent(name)}`;
  const listResponse = (await apiFetch(searchUrl, apiKey, { method: 'GET' })) as BotListResponse;

  const existing = listResponse.results.find((b) => b.handlerId === handlerId && b.name === name);

  if (existing) {
    logger.info({ botId: existing.id }, 'existing bot found, patching with current config');
    await apiFetch(`${base}/bots/${existing.id}`, apiKey, {
      method: 'PATCH',
      body: JSON.stringify(botConfig),
    });
    logger.info({ botId: existing.id }, 'bot profile updated');
    return existing.id;
  }

  logger.info({ handlerId, name }, 'no existing bot found, creating new bot profile');
  const created = (await apiFetch(`${base}/bots`, apiKey, {
    method: 'POST',
    body: JSON.stringify(botConfig),
  })) as BotRecord;

  logger.info({ botId: created.id }, 'bot profile created');
  return created.id;
}
