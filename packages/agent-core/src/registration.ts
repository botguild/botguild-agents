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
  // Platform returns snake_case; the local handlerId in BotConfig is a
  // *local* identifier (e.g. "sentinel-bot") and isn't the same as the
  // server-generated `handler_id` token.
  handler_id?: string;
  name: string;
  [key: string]: unknown;
}

interface BotListResponse {
  // Platform returns `{ bots: [...], pagination: {...} }`.
  bots: BotRecord[];
  [key: string]: unknown;
}

interface HandlerMeResponse {
  // GET /handlers/me → `{ handler: { id, name, ... } }`. `id` is the
  // server-side handler token that owns bots (the `handler_id` on a BotRecord).
  handler: { id: string; name?: string; [key: string]: unknown };
}

function toApiBody(botConfig: BotConfig): Record<string, unknown> {
  // Map our internal config to the platform's request schema. `handlerId`
  // is local-only and not sent. `bio` maps to `positioningStatement`.
  return {
    name: botConfig.name,
    category: botConfig.category,
    positioningStatement: botConfig.bio,
    workingStyle: botConfig.workingStyle,
    valueChainPosition: botConfig.valueChainPosition,
    pricingModel: botConfig.pricingModel,
    toolchain: botConfig.toolchain,
    warrantyTerms: botConfig.warrantyTerms,
  };
}

async function apiFetch(url: string, apiKey: string, options: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(30_000),
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
  const body = toApiBody(botConfig);

  // Resolve the handler that this API key authenticates as. We can only PATCH
  // bots we own, so the match below must be scoped to this id — otherwise we'd
  // grab a same-named bot belonging to another handler and PATCH-404.
  const meResponse = (await apiFetch(`${base}/handlers/me`, apiKey, {
    method: 'GET',
  })) as HandlerMeResponse;
  const ownerHandlerId = meResponse.handler.id;

  logger.info(
    { handlerId, name, ownerHandlerId, ownerName: meResponse.handler.name },
    'searching for existing bot profile',
  );

  // `GET /bots` is a global marketplace listing and ignores the `?name=`
  // filter, so we fetch the list and match in code. Match on BOTH name and
  // owner: a bot is "ours" only if this handler owns it. A same-named bot under
  // a different handler (e.g. after a handler migration) must NOT match —
  // we'd create a fresh profile under the current handler instead.
  const searchUrl = `${base}/bots?name=${encodeURIComponent(name)}`;
  const listResponse = (await apiFetch(searchUrl, apiKey, { method: 'GET' })) as BotListResponse;
  const bots = listResponse.bots ?? [];

  const existing = bots.find((b) => b.name === name && b.handler_id === ownerHandlerId);

  if (existing) {
    logger.info({ botId: existing.id }, 'existing bot found, patching with current config');
    await apiFetch(`${base}/bots/${existing.id}`, apiKey, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    logger.info({ botId: existing.id }, 'bot profile updated');
    return existing.id;
  }

  logger.info({ handlerId, name }, 'no existing bot found, creating new bot profile');
  const createResponse = (await apiFetch(`${base}/bots`, apiKey, {
    method: 'POST',
    body: JSON.stringify(body),
  })) as { bot?: BotRecord } & BotRecord;

  // The create response wraps the record as `{ bot: {...} }`; tolerate both
  // shapes in case the API is inconsistent.
  const created = createResponse.bot ?? createResponse;
  logger.info({ botId: created.id }, 'bot profile created');
  return created.id;
}
