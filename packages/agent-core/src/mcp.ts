import { BotGuildMCP } from '@botguild/sdk';
import type { Logger } from 'pino';
import type { Alerter } from './alerting.js';

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

// Shape of the handler-scoped `get_my_reputation` MCP tool. The handler
// roll-up plus a per-bot breakdown; `reputation` values are an open map
// (score, rating counts, ...) so we keep it loose and read the fields we need.
export interface MyReputation {
  handler: {
    handlerId: string;
    reputationScore: number;
    disputeRate: number;
  };
  bots: Array<{
    botId: string;
    name: string;
    reputation: Record<string, number | string | null>;
  }>;
}

// Shape of the handler-scoped `get_my_earnings` MCP tool: the escrow/payment
// overview for this handler.
export interface MyEarnings {
  summary: {
    funded: number;
    released: number;
    refunded: number;
    fees: number;
    balance: number;
    transactionCount: number;
  };
  transactions: Array<Record<string, unknown>>;
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

  // The calling handler's reputation roll-up + per-bot breakdown. Maps to the
  // handler-scoped `get_my_reputation` MCP read tool.
  getMyReputation(): Promise<MyReputation> {
    return this.mcp.callTool<MyReputation>('get_my_reputation');
  }

  // The calling handler's escrow/payment overview. Maps to `get_my_earnings`.
  getMyEarnings(args?: { limit?: number }): Promise<MyEarnings> {
    return this.mcp.callTool<MyEarnings>('get_my_earnings', args?.limit ? { limit: args.limit } : {});
  }
}

// Factual, claim-free boilerplate: points the arbitrator at the recorded
// evidence and signals that a human will follow up. Deliberately makes no
// assertions about the merits — humans handle the substantive response.
export const DEFAULT_DISPUTE_RESPONSE =
  'Automated acknowledgement: delivery details and progress for this contract are recorded ' +
  'in its event history and message thread. A human operator has been notified and will ' +
  'follow up on this dispute.';

export interface HandleDisputedContractInput {
  serviceName: string;
  contractId: string;
  reason?: string;
  mcp: AgentMcpClient;
  alerter: Alerter | null;
  logger: Logger;
}

// Reaction to a contract entering 'disputed'. Two parts, deliberately split by
// confidence:
//   1. Operator alert — the sure thing. High value, zero risk; humans are the
//      real dispute handlers.
//   2. Default counter-statement via respond_to_dispute — best-effort and
//      UNVERIFIED against a live dispute. Failure is tolerated: we log and
//      lean on the human follow-up the alert triggered.
export async function handleDisputedContract(input: HandleDisputedContractInput): Promise<void> {
  const { serviceName, contractId, reason, mcp, alerter, logger } = input;
  logger.warn({ contractId, reason }, 'contract disputed — operator attention needed');

  try {
    await alerter?.sendDisputeAlert(serviceName, contractId, reason);
  } catch (err) {
    logger.warn({ err, contractId }, 'dispute operator-alert failed');
  }

  try {
    const { responseId } = await mcp.respondToDispute({
      contractId,
      response: DEFAULT_DISPUTE_RESPONSE,
    });
    logger.info({ contractId, responseId }, 'submitted default dispute counter-statement');
  } catch {
    // respondToDispute already logged the error (with the exception) at error
    // level. Don't re-log the same failure at error here — this path is
    // intentionally best-effort. A warn records that we're falling back to the
    // human follow-up the alert triggered, without double error-level noise.
    logger.warn({ contractId }, 'auto dispute response failed; relying on human follow-up');
  }
}
