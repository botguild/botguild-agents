import { Hono } from 'hono';
import { verifyWebhookSignature } from '@botguild/sdk';
import type { Logger } from 'pino';
import type { WebhookEvent, WebhookHandler } from '@botguild/agent-core';

// Workers replacement for agent-core's createWebhookServer: same wire contract
// (X-BotGuild-Signature / X-BotGuild-Delivery headers, `{ event, data,
// timestamp }` body, identical status codes) but returned as a Hono app for the
// Worker `fetch` handler instead of binding a port. HMAC verification goes
// through @botguild/sdk's WebCrypto verifyWebhookSignature — agent-core's
// node:crypto verifySignature is not Workers-safe. There is no markReady()
// phase: a Worker has no boot sequence, so handlers are wired at config time.

export type { WebhookEvent, WebhookHandler };

export interface WorkersWebhookAppConfig {
  /**
   * HMAC secret used to verify inbound webhook signatures. Accepts a fixed
   * string or a (possibly async) getter resolved on every request — use the
   * getter form to read the platform-issued secret from D1. A getter that
   * throws or returns an empty string yields 503 so the platform retries the
   * delivery once the secret has been captured (see ensureRegisteredWorkers).
   */
  secret: string | (() => string | Promise<string>);
  botId: string;
  logger: Logger;
  /**
   * Event handlers keyed by event type (the 7 dispatched lifecycle events).
   * Events with no handler are acked with 200 so the platform doesn't retry
   * them. Webhooks are handler-scoped: wrap each handler in
   * withOwnershipFilter so sibling bots' contract events are dropped.
   */
  handlers: Record<string, WebhookHandler>;
  /**
   * Optional provider of extra fields merged into the GET /health body —
   * e.g. the D1-cached reputation snapshot. Resolved on each request; a throw
   * is logged and omitted, never a 500.
   */
  healthExtra?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}

// The platform signs as `sha256=<hex>`; the SDK verifier requires that exact
// prefix while agent-core's verifySignature also tolerated bare hex. Keep the
// tolerant read so both header forms verify.
function normalizeSignature(signature: string): string {
  return signature.startsWith('sha256=') ? signature : `sha256=${signature}`;
}

export function createWorkersWebhookApp(config: WorkersWebhookAppConfig): Hono {
  const { botId, logger, handlers, healthExtra } = config;
  const resolveSecret = async (): Promise<string> =>
    typeof config.secret === 'function' ? await config.secret() : config.secret;

  const app = new Hono();

  app.post('/webhook', async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header('X-BotGuild-Signature') ?? '';
    const deliveryId = c.req.header('X-BotGuild-Delivery');

    let secret: string;
    try {
      secret = await resolveSecret();
    } catch (err) {
      logger.error({ err, deliveryId }, 'webhook secret getter threw, returning 503');
      return c.json({ error: 'Secret unavailable' }, 503);
    }
    // No secret yet (registration hasn't run / persisted) — 503 so the
    // platform retries instead of recording the delivery against a bot that
    // could never have verified it.
    if (!secret) {
      logger.info({ deliveryId }, 'webhook received before secret captured, returning 503');
      return c.json({ error: 'Secret unavailable' }, 503);
    }

    if (
      !signature ||
      !(await verifyWebhookSignature(rawBody, normalizeSignature(signature), secret))
    ) {
      return c.json({ error: 'Invalid or missing signature' }, 401);
    }

    let parsed: { event?: string; data?: unknown; timestamp?: string };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const eventType = parsed.event;
    if (!eventType) {
      logger.warn({ rawBody: rawBody.slice(0, 200) }, 'webhook missing event field');
      return c.json({ error: 'Missing event field' }, 400);
    }

    const handler = Object.hasOwn(handlers, eventType) ? handlers[eventType] : undefined;
    if (!handler) {
      logger.info({ eventType, deliveryId }, 'no handler registered for event type');
      return c.json({ status: 'ok' }, 200);
    }

    const event: WebhookEvent = {
      eventType,
      payload: parsed.data,
      timestamp: parsed.timestamp,
      deliveryId,
    };

    try {
      await handler(event);
      return c.json({ status: 'ok' }, 200);
    } catch (error) {
      logger.error({ eventType, deliveryId, error }, 'webhook handler error');
      return c.json({ error: 'Handler error' }, 500);
    }
  });

  app.get('/health', async (c) => {
    let extra: Record<string, unknown> = {};
    try {
      extra = (await healthExtra?.()) ?? {};
    } catch (err) {
      logger.warn({ err }, 'healthExtra provider threw; omitting from /health');
    }
    // Spread extra FIRST so the reserved core fields always win. No uptime:
    // a Worker isolate has no meaningful process lifetime to report.
    return c.json({ ...extra, status: 'ok', botId });
  });

  return app;
}
