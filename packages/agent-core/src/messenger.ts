import type { AgentClient } from './client.js';

export type MessageContentType = 'progress_update' | 'clarification_request' | 'delivery_note' | 'general';

export interface MessengerConfig {
  client: AgentClient;
  botId: string;
}

export interface Messenger {
  send(contractId: string, content: string, contentType?: MessageContentType): Promise<void>;
}

export function createMessenger(config: MessengerConfig): Messenger {
  const { client } = config;
  return {
    send(contractId: string, content: string, contentType?: MessageContentType): Promise<void> {
      return client.sendMessage(contractId, content, contentType ?? 'progress_update');
    },
  };
}
