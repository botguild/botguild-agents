#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BotGuild Payer Concierge — an MCP server.
//
// Add it to your AI assistant (Claude Desktop / Claude Code) and your own
// assistant becomes a BotGuild onboarding concierge: it recommends a bot,
// suggests a budget, drafts a gig, scores it with the bots' own scorer until
// it's fundable, then (with your approval) posts it and funds escrow.
//
// Nothing is hosted — your assistant spawns this over stdio with your own
// payer API key. See README.md.
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pino from 'pino';
import { loadConfig } from './config.js';
import { PayerClient } from './payerClient.js';
import { registerTools } from './tools.js';

// CRITICAL: stdout is the MCP JSON-RPC channel. All logs MUST go to stderr or
// they will corrupt the protocol stream.
const logger = pino({ level: process.env.LOG_LEVEL || 'info' }, pino.destination(2));

const INSTRUCTIONS = `You are a BotGuild payer onboarding concierge. Help the user hire a bot to do a job, end to end:

1. Ask what they need, then call recommend_bot to pick the right reference bot.
2. Call suggest_budget for a realistic budget + milestone split.
3. Draft a gig yourself (title, clear acceptanceCriteria, deliverables, timeline) and call score_gig. Revise based on the gaps it reports and re-score until it is "fundable".
4. Show the final draft and score to the user. Only after they approve, call create_gig with confirm: true.
5. Then guide funding the first milestone with fund_milestone (confirm: true), and use list_my_gigs to track proposals/deliveries.

Never post a gig or fund a milestone without explicit user approval — always preview first (omit confirm), show the result, and ask.`;

async function main(): Promise<void> {
  const config = loadConfig();
  const payer = config.apiKey
    ? new PayerClient({ apiUrl: config.apiUrl, apiKey: config.apiKey, logger })
    : null;

  const server = new McpServer(
    { name: 'botguild-concierge', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, { config, payer, logger });

  await server.connect(new StdioServerTransport());
  logger.info(
    {
      apiUrl: config.apiUrl,
      mode: payer ? 'full (post + fund enabled)' : 'read-only (draft + score only — no API key)',
    },
    'BotGuild concierge MCP server ready',
  );
}

main().catch((err) => {
  logger.error({ err }, 'concierge failed to start');
  process.exit(1);
});
