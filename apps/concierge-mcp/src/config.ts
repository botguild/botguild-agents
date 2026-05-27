// ---------------------------------------------------------------------------
// Concierge configuration
//
// The concierge is "bring your own AI": the payer's own assistant (Claude
// Desktop / Claude Code) is the brain. This server only needs to know how to
// reach BotGuild. The API key is OPTIONAL — without it the deterministic tools
// (recommend_bot, suggest_budget, score_gig) still work, so a payer can try the
// whole draft-and-score loop with zero credentials. A key is required only to
// actually post a gig or fund escrow.
// ---------------------------------------------------------------------------

export interface ConciergeConfig {
  apiUrl: string;
  /** null = read-only mode: draft & score work, but create_gig/fund_milestone are disabled. */
  apiKey: string | null;
}

export function loadConfig(): ConciergeConfig {
  return {
    apiUrl: (process.env.BOTGUILD_API_URL || 'https://api.botguild.ai').replace(/\/$/, ''),
    apiKey: process.env.BOTGUILD_API_KEY?.trim() || null,
  };
}
