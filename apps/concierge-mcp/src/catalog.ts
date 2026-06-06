// ---------------------------------------------------------------------------
// Reference-bot catalog
//
// The concierge matches a payer's need to one of the deployed reference bots
// and scores their gig draft against that bot's OWN scorer config — so the
// advice ("SentinelBot would score this 86/100") reflects what the bot will
// actually do. Keep `scorer` in sync with each bot's apps/<bot>/src/config.ts.
// ---------------------------------------------------------------------------

import type { ScorerConfig } from '@botguild/agent-core';

export interface BotProfile {
  id: string;
  name: string;
  tagline: string;
  /** Mirror of the bot's scorerConfig (categories + keyword relevance + budget band + bid threshold). */
  scorer: ScorerConfig;
  canDo: string[];
  cantDo: string[];
  /** Lowercase keywords used to match a free-text need to this bot. */
  keywords: string[];
}

export const CATALOG: BotProfile[] = [
  {
    id: 'sentinel-bot',
    name: 'SentinelBot',
    tagline:
      'Monitoring & alerting — watches pages, APIs, and jobs and alerts on change or failure.',
    scorer: {
      categories: ['monitoring', 'Monitoring', 'Ops & Automation', 'web-scraping', 'Web Scraping'],
      keywords: [
        'monitor',
        'monitoring',
        'uptime',
        'downtime',
        'availability',
        'alert',
        'health check',
        'status page',
        'page change',
        'change detection',
        'scrape',
        'watch',
        'cron',
        'scheduled',
      ],
      keywordsForFullScore: 3,
      minKeywordHits: 2,
      budgetMin: 1,
      budgetMax: 400,
      proposalThreshold: 40,
    },
    canDo: [
      'Scheduled uptime / health checks on URLs and APIs',
      'Page-content diffing (detect changes, e.g. competitor pricing)',
      'Alert on change or downtime (e.g. to Slack/Telegram)',
    ],
    cantDo: [
      'Transform or clean data (use FlowBot)',
      'Run acceptance/QA test suites (use VerifierBot)',
    ],
    keywords: [
      'monitor',
      'monitoring',
      'uptime',
      'downtime',
      'alert',
      'watch',
      'change',
      'diff',
      'scrape',
      'scraping',
      'availability',
      'health',
      'ping',
      'track',
      'competitor',
    ],
  },
  {
    id: 'flow-bot',
    name: 'FlowBot',
    tagline: 'Data ETL — cleans and transforms CSV / PDF / API data into structured output.',
    scorer: {
      categories: ['Ops & Automation'],
      keywords: [
        'data',
        'etl',
        'transform',
        'csv',
        'excel',
        'spreadsheet',
        'pdf',
        'invoice',
        'api feed',
        'json feed',
        'ingest',
        'clean',
        'normalize',
        'parse',
        'pipeline',
        'sync',
        'extract',
        'migrate',
      ],
      keywordsForFullScore: 3,
      budgetMin: 60,
      budgetMax: 350,
      proposalThreshold: 40,
    },
    canDo: [
      'Extract data from CSV, PDF, or API sources',
      'Normalize, deduplicate, and reshape into a target schema',
      'Deliver structured output (CSV / JSON / Sheets-ready)',
    ],
    cantDo: [
      'Monitor things on a schedule (use SentinelBot)',
      'Verify another system against criteria (use VerifierBot)',
    ],
    keywords: [
      'transform',
      'etl',
      'extract',
      'normalize',
      'clean',
      'csv',
      'pdf',
      'api',
      'data',
      'convert',
      'parse',
      'migrate',
      'dedupe',
      'spreadsheet',
      'invoice',
      'structure',
    ],
  },
  {
    id: 'verifier-bot',
    name: 'VerifierBot',
    tagline:
      'QA & acceptance — runs structured checks and delivers a pass/fail report with evidence.',
    scorer: {
      categories: ['Testing & QA'],
      keywords: [
        'test',
        'testing',
        'qa',
        'quality',
        'verify',
        'verification',
        'validation',
        'validate',
        'acceptance',
        'smoke',
        'regression',
        'audit',
        'contract',
        'schema',
        'pass/fail',
        'e2e',
        'end-to-end',
      ],
      keywordsForFullScore: 3,
      budgetMin: 50,
      budgetMax: 300,
      proposalThreshold: 40,
    },
    canDo: [
      'HTTP / DOM / schema / data-quality checks against stated criteria',
      'AI-assisted acceptance evaluation (does it meet the spec?)',
      'Pass/fail report with evidence',
    ],
    cantDo: ['Build or transform the thing under test', 'Continuously monitor (use SentinelBot)'],
    keywords: [
      'verify',
      'test',
      'qa',
      'quality',
      'check',
      'acceptance',
      'validate',
      'assert',
      'audit',
      'review',
      'smoke',
      'regression',
      'pass',
      'fail',
      'criteria',
    ],
  },
];

export function getBot(id: string): BotProfile | undefined {
  return CATALOG.find((b) => b.id === id || b.name.toLowerCase() === id.toLowerCase());
}

export interface BotMatch {
  bot: BotProfile;
  score: number; // keyword hits
}

/** Rank bots by keyword overlap with a free-text need. Deterministic. */
export function rankBots(need: string): BotMatch[] {
  const text = need.toLowerCase();
  return CATALOG.map((bot) => ({
    bot,
    score: bot.keywords.reduce((n, kw) => (text.includes(kw) ? n + 1 : n), 0),
  })).sort((a, b) => b.score - a.score);
}
