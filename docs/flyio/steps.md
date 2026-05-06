# Fly.io setup — botguild-agents

Step-by-step guide to deploying SentinelBot, FlowBot, and VerifierBot to Fly.io
and wiring them to GitHub Actions for auto-deploy on every push to `main`.

References: <https://fly.io/docs/>

## 1. Install the CLI and authenticate (local, one-time)

```bash
# macOS
brew install flyctl

# any platform
curl -L https://fly.io/install.sh | sh

flyctl auth signup     # first time
# or
flyctl auth login      # if you already have an account
```

Verify: `flyctl auth whoami`.

## 2. Pick an organization and region

```bash
flyctl orgs list                       # find your org slug
flyctl platform regions                # list region codes
```

The fly.toml files default to `iad` (Ashburn). Change `primary_region` if you
want a region closer to your Anthropic / BotGuild API latency.

## 3. Create the three apps (do not deploy yet)

`fly launch` would generate a fresh fly.toml; we already have ours, so use
`apps create`:

```bash
flyctl apps create botguild-sentinel-bot --org <your-org>
flyctl apps create botguild-flow-bot     --org <your-org>
flyctl apps create botguild-verifier-bot --org <your-org>
```

If you'd rather use `launch`, pass `--copy-config --no-deploy` from inside
each `apps/<bot>` directory:

```bash
cd apps/sentinel-bot && flyctl launch --copy-config --no-deploy --name botguild-sentinel-bot
```

## 4. Create the persistent volume for SentinelBot

`apps/sentinel-bot/fly.toml` mounts `sentinel_data` at `/app/data` (where
`jobs.json` lives). The volume must exist before first deploy:

```bash
flyctl volumes create sentinel_data \
  --app botguild-sentinel-bot \
  --region iad \
  --size 1
```

FlowBot and VerifierBot don't currently mount volumes — their state is
in-memory plus ephemeral `data/jobs.json`. If you want their state to survive
restarts, add a `[[mounts]]` block to their fly.toml and create matching
volumes (`flow_data`, `verifier_data`).

## 5. Set per-app secrets

Each bot needs the same set of credentials. The repo ships a helper script
that reads `.env` and pushes secrets to all three apps in one shot:

```bash
# 1. Copy .env.example to .env and fill in values
cp .env.example .env
$EDITOR .env

# 2. Generate a webhook secret (paste output into BOTGUILD_WEBHOOK_SECRET)
openssl rand -hex 32

# 3. Preview what the script will push (values are masked in output)
./scripts/fly-secrets.sh --dry-run

# 4. Apply
./scripts/fly-secrets.sh
```

The script:
- Reads `.env` from the repo root and validates that the four required values
  (`BOTGUILD_API_URL`, `BOTGUILD_API_KEY`, `BOTGUILD_WEBHOOK_SECRET`,
  `ANTHROPIC_API_KEY`) are non-empty.
- Computes `WEBHOOK_BASE_URL` per-app as `https://<app>.fly.dev`, ignoring
  whatever's in `.env` (which is for local docker-compose / ngrok).
- Skips `PORT` because each bot's `fly.toml` owns it.
- Pushes optional values (`BOTGUILD_BOT_ID`, `TELEGRAM_*`) only if set.
- Use `--app <name>` to limit to one bot, or `--dry-run` to preview.

If you'd rather set them by hand, the equivalent without the script is:

```bash
APP=botguild-sentinel-bot   # then botguild-flow-bot, then botguild-verifier-bot

flyctl secrets set --app $APP \
  BOTGUILD_API_URL=https://botguild.ai/api \
  BOTGUILD_API_KEY=<your-bot-api-key> \
  BOTGUILD_WEBHOOK_SECRET=<random-32+-char-string> \
  ANTHROPIC_API_KEY=<your-anthropic-key> \
  WEBHOOK_BASE_URL=https://$APP.fly.dev
```

Notes:
- `WEBHOOK_BASE_URL` must match the public hostname Fly assigns each app — by
  default `<app-name>.fly.dev`. The bot appends `/webhook` to it on startup
  when registering with the platform.
- `PORT` is already set per-bot in `fly.toml` (3001/3002/3003) — don't override
  it via secrets.
- `BOTGUILD_BOT_ID` can be left blank initially; the bot resolves it on
  startup via `registerBot` and you can read it back from `flyctl logs`.

## 6. First deploy (manual smoke test)

Deploy each bot manually first so you can watch logs and catch config issues
before handing off to CI. **Run from the repo root** — the Dockerfiles use
monorepo-relative `COPY apps/<bot>/...` paths, so the build context must be
the workspace, not the bot subdirectory.

```bash
flyctl deploy . --remote-only --config apps/sentinel-bot/fly.toml
flyctl deploy . --remote-only --config apps/flow-bot/fly.toml
flyctl deploy . --remote-only --config apps/verifier-bot/fly.toml
```

The trailing `.` is significant — it sets the Docker build context to the
current directory (repo root) so the Dockerfile's `COPY apps/<bot>/...`
paths resolve correctly. Without it, flyctl would default the context to
the directory containing `fly.toml` and the build fails with
`apps/<bot>: not found`.

`--remote-only` builds the Docker image on Fly's builder so you don't need
local Docker. After each deploy:

```bash
flyctl status --app botguild-sentinel-bot
flyctl logs   --app botguild-sentinel-bot
```

Look for `"FlowBot started"` / `"SentinelBot started"` / `"VerifierBot started"`.
The `/health` checks pass automatically once the bot binds to its port.

## 7. Wire up GitHub Actions auto-deploy

The `.github/workflows/deploy-agents.yml` workflow deploys all three apps in
parallel on push to `main`. It needs an org-scoped Fly API token:

```bash
flyctl tokens create org <your-org> --name botguild-agents-ci
```

Copy the printed token, then in the repo:

```bash
gh secret set FLY_API_TOKEN --body "<token-from-fly>"
```

Re-run any failed deploys:

```bash
gh run list --branch main --limit 3
gh run rerun <run-id>
```

## 8. (Optional) Log drain to Axiom or Logtail

The project ships pino JSON logs that include `service`, `botId`, and where
applicable `gigId` / `contractId` / `durationMs`. To ship them off-platform:

```bash
flyctl logs ship --app botguild-sentinel-bot \
  --provider axiom \
  --token <axiom-ingest-token> \
  --dataset botguild-bots
```

Repeat per app, or use one shared dataset and filter by `service` / `botId`.
See `.github/fly-log-drain.md` for additional notes.

## 9. Verify end-to-end

For each bot:

```bash
curl https://botguild-sentinel-bot.fly.dev/health
# → {"status":"ok","botId":"...","uptime":...,"jobCount":0}
```

Then create a test gig in BotGuild that matches a bot's category or standing
offer and watch logs:

```bash
flyctl logs --app botguild-sentinel-bot
```

You should see `gig poller: listGigs failed` (none open) → eventually
`proposal submitted successfully` when a matching gig arrives.

## Common gotchas

- **`WEBHOOK_BASE_URL` mismatch.** If the URL doesn't resolve publicly, the
  BotGuild platform can't deliver `proposal.accepted` etc. — the bot would
  then only catch gigs via the polling fallback.
- **Volume not in same region as app.** `flyctl volumes create` must use the
  same region as `primary_region` or the machine won't start.
- **Free-tier machine quota.** Three bots × `min_machines_running = 1`
  exceeds the free tier; either drop one bot's `min_machines_running` to 0
  (it'll cold-start) or upgrade the org.
- **Playwright in containers.** SentinelBot diff and VerifierBot DOM checks
  use Chromium. If you change the Dockerfile, keep the `playwright` install
  step that downloads the browser — `mcr.microsoft.com/playwright`-based
  images are the simplest path.

## Quick reference — app inventory

| App | Port | Volume | Notes |
|---|---|---|---|
| `botguild-sentinel-bot` | 3001 | `sentinel_data` → `/app/data` | Uptime + diff monitoring |
| `botguild-flow-bot` | 3002 | (none) | ETL/data transform |
| `botguild-verifier-bot` | 3003 | (none) | QA / acceptance audits |

All apps default to `primary_region = 'iad'` and `vm: shared-cpu-1x / 512mb`.
