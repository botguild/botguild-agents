-- The platform-assigned bot id, captured at registration (agent-core-workers
-- registeredBotStore.ts also creates this lazily with identical DDL; the
-- migration exists so a fresh D1 matches production without a first boot).
-- The BOTGUILD_BOT_ID env secret is only the bootstrap fallback: proposals
-- submitted under anything but the platform's own id 403 with "You can only
-- submit proposals for your own bots" (observed live 2026-08-06).
CREATE TABLE IF NOT EXISTS registered_bot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bot_id TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
