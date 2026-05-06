# BotGuild Agents

A pnpm monorepo containing three BotGuild automation bots: **SentinelBot**, **FlowBot**, and **VerifierBot**.

---

## Contributing

This repo follows a lightweight gitflow:

- `develop` is the default branch — branch off it for `feature/<slug>` or `epic/eN-<slug>` work and PR back into it.
- `main` is the release branch — pushes to `main` trigger Fly.io deploys.
- Full model in [`docs/cicd/gitflow.md`](docs/cicd/gitflow.md).
- Fly.io setup in [`docs/flyio/steps.md`](docs/flyio/steps.md).

---

## Prerequisites

- [Node.js 22](https://nodejs.org/)
- [pnpm 9](https://pnpm.io/installation)
- [Fly.io CLI (`flyctl`)](https://fly.io/docs/hands-on/install-flyctl/)

---

## Local Development

### Install dependencies

```bash
pnpm install
```

### Start all bots in watch mode

```bash
pnpm dev
```

### Start all bots via Docker Compose

```bash
docker-compose up
```

---

## Fly.io Deployment

### 1. Authenticate with Fly.io

```bash
fly auth login
```

### 2. Create the SentinelBot persistent volume

SentinelBot stores `jobs.json` on a persistent volume mounted at `/app/data`.

```bash
fly volumes create sentinel_data --region iad --size 1 --app botguild-sentinel-bot
```

### 3. Set secrets for each bot

Replace each `...` placeholder with the real value before running.

**SentinelBot** (port 3001)

```bash
fly secrets set \
  BOTGUILD_API_KEY=... \
  BOTGUILD_API_URL=... \
  BOTGUILD_BOT_ID=... \
  BOTGUILD_WEBHOOK_SECRET=... \
  ANTHROPIC_API_KEY=... \
  WEBHOOK_BASE_URL=... \
  PORT=3001 \
  --app botguild-sentinel-bot
```

**FlowBot** (port 3002)

```bash
fly secrets set \
  BOTGUILD_API_KEY=... \
  BOTGUILD_API_URL=... \
  BOTGUILD_BOT_ID=... \
  BOTGUILD_WEBHOOK_SECRET=... \
  ANTHROPIC_API_KEY=... \
  WEBHOOK_BASE_URL=... \
  PORT=3002 \
  --app botguild-flow-bot
```

**VerifierBot** (port 3003)

```bash
fly secrets set \
  BOTGUILD_API_KEY=... \
  BOTGUILD_API_URL=... \
  BOTGUILD_BOT_ID=... \
  BOTGUILD_WEBHOOK_SECRET=... \
  ANTHROPIC_API_KEY=... \
  WEBHOOK_BASE_URL=... \
  PORT=3003 \
  --app botguild-verifier-bot
```

### 4. Deploy each bot

```bash
fly deploy --config apps/sentinel-bot/fly.toml
fly deploy --config apps/flow-bot/fly.toml
fly deploy --config apps/verifier-bot/fly.toml
```

---

## Fly.io Metrics Dashboards

| Bot | Dashboard URL |
|-----|---------------|
| SentinelBot | https://fly.io/apps/botguild-sentinel-bot/metrics |
| FlowBot | https://fly.io/apps/botguild-flow-bot/metrics |
| VerifierBot | https://fly.io/apps/botguild-verifier-bot/metrics |
