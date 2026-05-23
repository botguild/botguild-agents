import { BotGuildMCP } from '@botguild/sdk';
import type { Logger } from 'pino';

// Minimal surface we need from an MCP transport. BotGuildMCP satisfies this;
// tests inject a stub so they don't have to construct JSON-RPC envelopes.
export interface McpToolCaller {
  callTool<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
}

export interface AgentMcpClientConfig {
  apiUrl: string;
  apiKey: string;
  logger: Logger;
  /** Injectable transport for tests / custom impls. Defaults to BotGuildMCP. */
  transport?: McpToolCaller;
}

export type DisputeEvidenceType = 'logs' | 'artifacts' | 'photos' | 'inspection-report';

export interface DisputeResponseInput {
  contractId: string;
  response: string;
  evidenceUrls?: string[];
  evidenceType?: DisputeEvidenceType;
}

export interface WarrantyStatus {
  id: string;
  contractId: string;
  status: string;
  type: string;
  resolution?: string;
  resolvedAt?: string;
  evidenceUrls?: string[];
}

// Wraps the platform MCP server for the handler-side flows that have no REST
// equivalent: responding to a dispute and checking a warranty claim's status.
// Proposals/messages/milestones go over REST (AgentClient) — only use this for
// dispute/warranty.
export class AgentMcpClient {
  private readonly mcp: McpToolCaller;
  private readonly logger: Logger;

  constructor(config: AgentMcpClientConfig) {
    this.mcp =
      config.transport ?? new BotGuildMCP({ baseUrl: config.apiUrl, apiKey: config.apiKey });
    this.logger = config.logger;
  }

  // Submit a handler counter-statement on a disputed contract or open warranty
  // claim. Maps to the `respond_to_dispute` MCP tool.
  async respondToDispute(input: DisputeResponseInput): Promise<{ responseId: string }> {
    const start = Date.now();
    try {
      const result = await this.mcp.callTool<{ responseId: string }>('respond_to_dispute', {
        contractId: input.contractId,
        response: input.response,
        evidenceUrls: input.evidenceUrls ?? [],
        ...(input.evidenceType ? { evidenceType: input.evidenceType } : {}),
      });
      this.logger.info(
        {
          contractId: input.contractId,
          responseId: result.responseId,
          durationMs: Date.now() - start,
        },
        'submitted dispute response via MCP',
      );
      return result;
    } catch (err) {
      this.logger.error({ err, contractId: input.contractId }, 'failed to submit dispute response');
      throw err;
    }
  }

  // Look up a warranty claim's current status. Maps to `get_warranty_status`.
  // Returns null if the claim doesn't exist or this bot isn't a party to it.
  async getWarrantyStatus(claimId: string): Promise<WarrantyStatus | null> {
    try {
      return await this.mcp.callTool<WarrantyStatus | null>('get_warranty_status', { claimId });
    } catch (err) {
      this.logger.error({ err, claimId }, 'failed to get warranty status');
      throw err;
    }
  }
}
