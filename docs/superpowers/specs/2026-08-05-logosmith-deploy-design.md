# LogoSmith deployment pipeline — design

**Date:** 2026-08-05
**Status:** Approved
**Scope:** CI/CD deployment for `apps/logosmith-bot` (Cloudflare Worker). First Workers app in this repo to get an automated deploy.

## Background

The existing `deploy-agents.yml` is dead code: its auto-trigger was removed when
the sentinel/flow/verifier Fly apps were destroyed (c147a84), and its jobs keep
an `if: github.event.workflow_run.conclusion == 'success'` guard that is never
true on `workflow_dispatch`, so even a manual run does nothing. It only knows
about the three retired Fly bots; none of the five newer Cloudflare Workers
apps deploy from CI. LogoSmith (Worker + D1 + KV + R2 + Queues + Workers AI +
cron triggers) is the first to be wired up.

Ideas carried forward from the old pipeline: deploy exactly what was validated,
and gate the deploy on green checks (cf4b5f6). Idea deliberately changed: the
deploy branch is `develop` (the GitHub default), not `main` — decided by the
repo owner for this bot; `docs/cicd/gitflow.md` gets a note recording the
exception.

## Decisions (made during brainstorming)

1. **Trigger:** auto-deploy on push to `develop`, in a **separate, path-filtered
   workflow**, plus a `workflow_dispatch` manual fallback that actually works.
2. **Path filter:** `apps/logosmith-bot/**`, `packages/agent-core/**`,
   `packages/agent-core-workers/**`, and the workflow file itself. The shared
   packages are compiled into the Worker bundle; excluding them would let
   library fixes sit unshipped until the next app-subtree commit.
   `pnpm-lock.yaml` is deliberately excluded (workspace-shared → noisy);
   dependency-bump-only deploys go through manual dispatch.
3. **Gating:** self-contained — the deploy workflow runs logosmith-scoped
   typecheck + tests itself before deploying. Full repo CI still runs in
   parallel on the same push; an unrelated red job elsewhere neither blocks nor
   is blocked by a logosmith deploy.

## Design

### 1. New workflow: `.github/workflows/deploy-logosmith.yml`

```yaml
on:
  push:
    branches: [develop]
    paths:
      - apps/logosmith-bot/**
      - packages/agent-core/**
      - packages/agent-core-workers/**
      - .github/workflows/deploy-logosmith.yml
  workflow_dispatch:

concurrency:
  group: deploy-logosmith
  cancel-in-progress: false   # queue deploys; never cancel a migration mid-flight
```

Single `deploy` job (ubuntu-latest):

1. `actions/checkout@v6`, then `./.github/actions/setup` (existing composite:
   pnpm 9.15.0, Node 22, frozen-lockfile install).
2. **Gate:** `pnpm --filter "@botguild/logosmith-bot..." typecheck` and the
   same filter for `test`. The `...` suffix includes workspace dependencies
   (`agent-core`, `agent-core-workers`) — matching the trigger paths, so a
   shared-package change that breaks its own tests does not ship.
3. **Migrations:** `pnpm --filter @botguild/logosmith-bot db:migrate`
   (new script, below) → `wrangler d1 migrations apply logosmith --remote`.
   Runs before deploy so new code never meets an old schema; wrangler tracks
   applied migrations, so this is a no-op when there is nothing pending.
4. **Deploy:** `pnpm --filter @botguild/logosmith-bot deploy` — the
   workspace-pinned wrangler (`^4.107.0`). No third-party deploy action,
   consistent with the repo's supply-chain posture (cf. the gitleaks CLI
   choice in `ci.yml`).
5. **Smoke:** extract `WEBHOOK_BASE_URL` from `apps/logosmith-bot/wrangler.jsonc`
   (single source of truth — not duplicated into the workflow) and
   `curl --retry` `GET <url>/health`, asserting the body contains
   `"botId": "bot-logosmith"`.

Steps 3–4 get `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from GitHub
repo secrets.

### 2. Package change

Add to `apps/logosmith-bot/package.json` scripts, symmetric with `deploy`:

```json
"db:migrate": "wrangler d1 migrations apply logosmith --remote"
```

### 3. Prerequisites and rollout order

Manual, one-time, **before merging `logosmith` → `develop`**:

1. Provision: `wrangler d1 create logosmith`, `wrangler kv namespace create
   CACHE`, `wrangler r2 bucket create logosmith-deliverables`, **and both
   queues** — `wrangler queues create logosmith-jobs` and
   `wrangler queues create logosmith-jobs-dlq`. (The README's ordered deploy
   runbook currently omits the queue creation `wrangler deploy` requires —
   fixed as part of this work.)
2. Commit the real `database_id`, KV `id`, and real `WEBHOOK_BASE_URL` into
   `wrangler.jsonc` on the `logosmith` branch, replacing the ⚠️ placeholders.
   Resource IDs are non-secret config (useless without an API token) and safe
   in the public repo.
3. `wrangler secret put` the 10 runtime secrets listed in `wrangler.jsonc`.
4. Add GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (from the "Edit Cloudflare
   Workers" token template, plus D1 Edit) and `CLOUDFLARE_ACCOUNT_ID`.
5. **Validate the pipeline by manually dispatching the workflow from the
   `logosmith` branch** — that run is the bring-up deploy.
6. Merge to `develop`; auto-deploy takes over.

Merging before provisioning is not dangerous, just a guaranteed red first run
(migrations fail against the placeholder database id).

### 4. Failure semantics

| Failure | Outcome |
|---|---|
| Gate (typecheck/test) fails | Nothing touched; job red |
| Migration apply fails | Job stops before deploy; old code keeps serving |
| Deploy fails | Workers deploys are atomic; previous version keeps serving |
| Smoke fails | Job red; new version stays live — rollback is manual (`wrangler rollback`), noted in the runbook |
| Two merges race | `concurrency` queues the second run; no interleaved migrate/deploy |

### 5. Doc touches

- `docs/cicd/gitflow.md`: short note that logosmith deploys from `develop`
  (path-filtered workflow), unlike the retired main-triggered Fly flow.
- `apps/logosmith-bot/README.md` runbook: add the two `wrangler queues create`
  lines and the GitHub-secrets step; note `wrangler rollback` under the smoke
  check.

## Non-goals

- No changes to `deploy-agents.yml` (stays as documented dead code) or to
  `ci.yml`'s retired-bot docker matrix (tech-debt note only).
- No pipelines for the other Workers bots (jiffyapp-bot/-dispatch,
  thumbforge-bot/-probe, voicewright-bot) — this workflow is deliberately
  shaped as their copy-paste template, but wiring them up is separate work.
- No staging environment; there is one production Worker.

## Success criteria

- Manual dispatch from the `logosmith` branch performs a full
  migrate → deploy → green smoke run.
- After merge, a `develop` push touching a filtered path auto-deploys; a push
  not touching them does not trigger the workflow.
- A commit with a failing logosmith-scoped test never reaches `wrangler deploy`.
