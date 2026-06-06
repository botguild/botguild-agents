import type { Logger } from 'pino';
import { AgentError } from './client.js';

export interface BotConfig {
  handlerId: string;
  name: string;
  category: string;
  bio: string;
  // Internal only: feeds the proposer's system prompt. The platform dropped
  // its working_style/pricing_model/hourly_range bot columns, so this is no
  // longer sent in the registration body.
  workingStyle: 'glass-box' | 'checkpoints' | 'black-box';
  valueChainPosition: string;
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
  // `workingStyle` is intentionally omitted — the platform no longer has a
  // working_style column (it's kept on BotConfig only for the proposer prompt).
  return {
    name: botConfig.name,
    category: botConfig.category,
    positioningStatement: botConfig.bio,
    valueChainPosition: botConfig.valueChainPosition,
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
    throw new AgentError(
      res.status,
      `BotGuild API ${options.method} ${url} failed: ${res.status} ${text}`,
      url,
    );
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
    try {
      await apiFetch(`${base}/bots/${existing.id}`, apiKey, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      logger.info({ botId: existing.id }, 'bot profile updated');
    } catch (err) {
      // The PATCH is only a profile sync — we already have the bot id, so a
      // failed sync must not kill startup. In particular the platform returns
      // 409 CONFLICT while the bot has an active contract ("can't be edited
      // until it concludes"), which crash-looped VerifierBot on deploy: the
      // active contract itself prevented the bot from booting. Log and carry
      // on with the existing profile; the sync will catch up on a later boot.
      if (err instanceof AgentError && err.status === 409) {
        logger.warn(
          { botId: existing.id, err },
          'bot profile is locked (active contract) — skipping profile sync and continuing startup',
        );
      } else {
        throw err;
      }
    }
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
