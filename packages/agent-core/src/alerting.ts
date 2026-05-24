import type { Logger } from 'pino';

export interface TelegramAlerterConfig {
  botToken: string;
  chatId: string;
  logger: Logger;
}

export interface Alerter {
  sendStartupAlert(serviceName: string, botId: string): Promise<void>;
  sendFatalAlert(serviceName: string, botId: string, errorMessage: string): Promise<void>;
  sendDisputeAlert(serviceName: string, contractId: string, reason?: string): Promise<void>;
}

async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
  logger: Logger,
): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'telegram alert failed');
    }
  } catch (err) {
    logger.warn({ err }, 'telegram alert request failed');
  }
}

export function createAlerter(config: TelegramAlerterConfig): Alerter {
  const { botToken, chatId, logger } = config;

  return {
    async sendStartupAlert(serviceName: string, botId: string): Promise<void> {
      if (!botToken || !chatId) return;
      const text = `🤖 ${serviceName} started (botId: ${botId}) at ${new Date().toISOString()}`;
      await sendTelegram(botToken, chatId, text, logger);
    },

    async sendFatalAlert(serviceName: string, botId: string, errorMessage: string): Promise<void> {
      if (!botToken || !chatId) return;
      const text = `🚨 ${serviceName} fatal error (botId: ${botId}): ${errorMessage} at ${new Date().toISOString()}`;
      await sendTelegram(botToken, chatId, text, logger);
    },

    async sendDisputeAlert(
      serviceName: string,
      contractId: string,
      reason?: string,
    ): Promise<void> {
      if (!botToken || !chatId) return;
      const text = `⚖️ ${serviceName}: contract ${contractId} is DISPUTED${reason ? ` — ${reason}` : ''}. Human follow-up needed. ${new Date().toISOString()}`;
      await sendTelegram(botToken, chatId, text, logger);
    },
  };
}
