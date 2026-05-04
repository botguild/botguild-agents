import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { Logger } from 'pino';

export interface WebhookEvent {
  eventType: string;
  payload: unknown;
}

export type WebhookHandler = (event: WebhookEvent) => Promise<void>;

export interface WebhookServerConfig {
  port: number;
  secret: string;
  botId: string;
  logger: Logger;
}

export interface WebhookServer {
  on(eventType: string, handler: WebhookHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function createWebhookServer(config: WebhookServerConfig): WebhookServer {
  const { port, secret, botId, logger } = config;
  const handlers = new Map<string, WebhookHandler>();
  let serverRef: Server | undefined;

  const app = new Hono();

  app.post('/webhook', async (c) => {
    const signature = c.req.header('X-Webhook-Signature') ?? '';
    const rawBody = await c.req.text();

    if (!signature || !verifySignature(rawBody, signature, secret)) {
      return c.json({ error: 'Invalid or missing signature' }, 401);
    }

    let event: WebhookEvent;
    try {
      event = JSON.parse(rawBody) as WebhookEvent;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { eventType, payload } = event;
    const handler = handlers.get(eventType);

    if (!handler) {
      logger.info({ eventType }, 'no handler registered for event type');
      return c.json({ status: 'ok' }, 200);
    }

    try {
      await handler({ eventType, payload });
      return c.json({ status: 'ok' }, 200);
    } catch (error) {
      logger.error({ eventType, error }, 'webhook handler error');
      return c.json({ error: 'Handler error' }, 500);
    }
  });

  app.get('/health', (c) => {
    return c.json({
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
