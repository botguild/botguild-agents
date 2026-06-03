import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { Logger } from 'pino';

export interface WebhookEvent {
  eventType: string;
  payload: unknown;
  timestamp?: string;
  deliveryId?: string;
}

export type WebhookHandler = (event: WebhookEvent) => Promise<void>;

export interface WebhookServerConfig {
  port: number;
  /**
   * HMAC secret used to verify inbound webhook signatures. Accepts either a
   * fixed string or a getter function — the getter is resolved on every
   * request. Use the getter form when the secret may change at runtime
   * (e.g. swapped in after capturing the platform-issued secret from POST
   * /webhooks).
   */
  secret: string | (() => string);
  botId: string;
  logger: Logger;
  /**
   * Optional provider of extra fields merged into the GET /health body —
   * e.g. live reputation, jobCount. Resolved on each /health request and must
   * not throw. Keep it cheap (read a cached value); /health is hit every 30s.
   */
  healthExtra?: () => Record<string, unknown>;
}

export interface WebhookServer {
  on(eventType: string, handler: WebhookHandler): void;
  /**
   * Mark the server as ready to dispatch webhook events. Until called,
   * `/webhook` returns 503 so the platform retries deliveries instead of
   * recording them as delivered while handlers are still being wired up.
   * `/health` is unaffected — it returns 200 from the moment start() resolves.
   */
  markReady(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export interface ProcessWebhookInput {
  rawBody: string;
  signature: string;
  secret: string;
  deliveryId?: string;
  handlers: Map<string, WebhookHandler>;
  logger: Logger;
  /**
   * Whether the server is ready to dispatch events. Defaults to true to
   * preserve existing test behavior. When false, requests that would
   * otherwise succeed return 503 (signature + payload checks still run).
   */
  ready?: boolean;
}

export interface ProcessWebhookResult {
  status: number;
  body: { status?: 'ok'; error?: string };
}

export async function processWebhookRequest(
  input: ProcessWebhookInput,
): Promise<ProcessWebhookResult> {
  const { rawBody, signature, secret, deliveryId, handlers, logger, ready = true } = input;

  if (!signature || !verifySignature(rawBody, signature, secret)) {
    return { status: 401, body: { error: 'Invalid or missing signature' } };
  }

  let parsed: { event?: string; data?: unknown; timestamp?: string };
  try {
    parsed = JSON.parse(rawBody) as typeof parsed;
  } catch {
    return { status: 400, body: { error: 'Invalid JSON body' } };
  }

  const eventType = parsed.event;
  if (!eventType) {
    logger.warn({ rawBody: rawBody.slice(0, 200) }, 'webhook missing event field');
    return { status: 400, body: { error: 'Missing event field' } };
  }

  // Handlers not wired yet — return 503 so the platform retries this delivery
  // instead of recording it as successfully delivered to an unprepared bot.
  if (!ready) {
    logger.info({ eventType, deliveryId }, 'webhook received before server ready, returning 503');
    return { status: 503, body: { error: 'Server not ready' } };
  }

  const event: WebhookEvent = {
    eventType,
    payload: parsed.data,
    timestamp: parsed.timestamp,
    deliveryId,
  };

  const handler = handlers.get(eventType);
  if (!handler) {
    logger.info({ eventType, deliveryId }, 'no handler registered for event type');
    return { status: 200, body: { status: 'ok' } };
  }

  try {
    await handler(event);
    return { status: 200, body: { status: 'ok' } };
  } catch (error) {
    logger.error({ eventType, deliveryId, error }, 'webhook handler error');
    return { status: 500, body: { error: 'Handler error' } };
  }
}

export function createWebhookServer(config: WebhookServerConfig): WebhookServer {
  const { port, secret, botId, logger, healthExtra } = config;
  const resolveSecret = (): string => (typeof secret === 'function' ? secret() : secret);
  const handlers = new Map<string, WebhookHandler>();
  let ready = false;
  let serverRef: Server | undefined;

  const app = new Hono();

  app.post('/webhook', async (c) => {
    const result = await processWebhookRequest({
      rawBody: await c.req.text(),
      signature: c.req.header('X-BotGuild-Signature') ?? '',
      secret: resolveSecret(),
      deliveryId: c.req.header('X-BotGuild-Delivery') ?? undefined,
      handlers,
      ready,
      logger,
    });
    return c.json(result.body, result.status as 200 | 400 | 401 | 500 | 503);
  });

  app.get('/health', (c) => {
    let extra: Record<string, unknown> = {};
    try {
      extra = healthExtra?.() ?? {};
    } catch (err) {
      // /health must never 500 on an observability extra — Fly would mark the
      // machine unhealthy and recycle it.
      logger.warn({ err }, 'healthExtra provider threw; omitting from /health');
    }
    // Spread extra FIRST so the reserved core fields always win — an
    // observability provider can't accidentally clobber status/botId/uptime.
    return c.json({
      ...extra,
      status: 'ok',
      botId,
      uptime: process.uptime(),
      version: process.env['npm_package_version'] ?? 'unknown',
    });
  });

  return {
    on(eventType: string, handler: WebhookHandler): void {
      handlers.set(eventType, handler);
    },

    markReady(): void {
      if (ready) return;
      ready = true;
      logger.info('webhook server marked ready, accepting webhook deliveries');
    },

    start(): Promise<void> {
      return new Promise((resolve) => {
        serverRef = serve({ fetch: app.fetch, port }, () => {
          logger.info({ port }, 'webhook server started');
          resolve();
        }) as Server;
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!serverRef) {
          resolve();
          return;
        }
        serverRef.close((err) => {
          if (err) {
            reject(err);
          } else {
            logger.info('webhook server stopped');
            resolve();
          }
        });
      });
    },
  };
}
