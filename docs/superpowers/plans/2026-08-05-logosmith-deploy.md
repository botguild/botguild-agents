# LogoSmith Deployment Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A path-filtered GitHub Actions workflow that gates, migrates, and deploys the `apps/logosmith-bot` Cloudflare Worker from `develop`, plus the doc updates that keep the runbook and gitflow docs truthful.

**Architecture:** One new workflow (`deploy-logosmith.yml`) auto-fires on `develop` pushes touching the logosmith app, the two shared `packages/` compiled into its bundle, or the workflow file itself (manual `workflow_dispatch` as fallback). It runs a self-contained logosmith-scoped typecheck+test gate, applies D1 migrations, deploys with the workspace-pinned wrangler, and smoke-checks `GET /health`. Spec: `docs/superpowers/specs/2026-08-05-logosmith-deploy-design.md`.

**Tech Stack:** GitHub Actions, pnpm 9.15.0 workspace filters, wrangler 4 (Cloudflare Workers + D1), bash, actionlint (validation only).

## Global Constraints

- Node 22 + pnpm 9.15.0. Locally, if `node: command not found`, run `export PATH="$HOME/.local/share/mise/shims:$PATH"` first (this machine manages Node via mise).
- All commands run from the repo root: `/home/rolandknight/github.com/botguild/botguild-agents`.
- wrangler stays workspace-pinned (`^4.107.0` in `apps/logosmith-bot/package.json` devDependencies). Never install wrangler globally, and never use a third-party deploy action.
- No new third-party GitHub Actions anywhere. The workflow may use only `actions/checkout@v6` and the local composite `./.github/actions/setup`.
- Only these files change in this plan: `apps/logosmith-bot/package.json`, `.github/workflows/deploy-logosmith.yml` (new), `apps/logosmith-bot/README.md`, `docs/cicd/gitflow.md`, `docs/tech-debt.md`. Explicitly do NOT touch `.github/workflows/deploy-agents.yml` or `.github/workflows/ci.yml`.
- The ⚠️ placeholder IDs in `apps/logosmith-bot/wrangler.jsonc` stay as placeholders — provisioning real IDs is the operator's step (spec §3), not part of this plan.
- TDD does not apply to declarative YAML/docs; each task's test cycle is its validation commands with the exact expected output stated. Run them and compare.
- Commit messages: conventional-commit style as given per task, each ending with the two trailer lines shown in Task 1's commit step.

---

### Task 1: `db:migrate` script + deploy workflow

**Files:**
- Modify: `apps/logosmith-bot/package.json` (scripts block, currently lines 8–15)
- Create: `.github/workflows/deploy-logosmith.yml`

**Interfaces:**
- Consumes: existing package scripts `typecheck`, `test`, `deploy` in `apps/logosmith-bot/package.json`; the composite action `./.github/actions/setup`; `WEBHOOK_BASE_URL` in `apps/logosmith-bot/wrangler.jsonc` `vars`.
- Produces: package script `db:migrate` (= `wrangler d1 migrations apply logosmith --remote`); workflow file `.github/workflows/deploy-logosmith.yml` with display name `Deploy LogoSmith` and job `deploy`. Tasks 2–3 reference the workflow by exactly these names/paths.

- [ ] **Step 1: Add the `db:migrate` script**

In `apps/logosmith-bot/package.json`, change the scripts block by inserting one line after `"deploy": "wrangler deploy",`:

```json
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "db:migrate": "wrangler d1 migrations apply logosmith --remote",
    "test": "tsx --test src/*.test.ts src/**/*.test.ts",
    "lint": "eslint . --max-warnings=0"
  },
```

- [ ] **Step 2: Verify the script resolves**

Run: `pnpm --filter @botguild/logosmith-bot run 2>/dev/null | grep -A1 "db:migrate"`
Expected output includes both lines:

```
  db:migrate
    wrangler d1 migrations apply logosmith --remote
```

- [ ] **Step 3: Create the workflow file**

Create `.github/workflows/deploy-logosmith.yml` with exactly:

```yaml
name: Deploy LogoSmith

# LogoSmith (apps/logosmith-bot) is a Cloudflare Worker deployed from
# `develop` (the default branch), path-filtered to what actually ships in
# its bundle. This is unlike the retired Fly bots (deploy-agents.yml, now
# dead code, which deployed from `main`). Design:
# docs/superpowers/specs/2026-08-05-logosmith-deploy-design.md
on:
  push:
    branches: [develop]
    paths:
      - apps/logosmith-bot/**
      - packages/agent-core/**
      - packages/agent-core-workers/**
      - .github/workflows/deploy-logosmith.yml
  # Manual fallback: dependency-bump-only redeploys (pnpm-lock.yaml is
  # deliberately not a trigger path) and the pre-merge bring-up run
  # dispatched from the logosmith branch.
  workflow_dispatch:

# Queue deploys rather than overlap; never cancel a run mid-migration.
concurrency:
  group: deploy-logosmith
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  deploy:
    name: Gate, migrate, deploy
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      # The gate runs node-only tests; skip Playwright's ~150MB Chromium
      # download that the workspace install would otherwise trigger.
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
    steps:
      - uses: actions/checkout@v6
      - uses: ./.github/actions/setup

      # Self-contained gate — logosmith plus the workspace packages compiled
      # into its bundle ("..." = the package and its workspace deps). Full
      # repo CI runs in parallel on the same push; unrelated red jobs there
      # neither block nor are blocked by this deploy.
      - name: Typecheck (logosmith + deps)
        run: pnpm --filter "@botguild/logosmith-bot..." typecheck

      - name: Test (logosmith + deps)
        run: pnpm --filter "@botguild/logosmith-bot..." test

      # Migrations before deploy — new code must never meet an old schema.
      # wrangler tracks applied migrations; a clean run is a no-op.
      - name: Apply D1 migrations
        run: pnpm --filter @botguild/logosmith-bot db:migrate
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Deploy Worker
        run: pnpm --filter @botguild/logosmith-bot deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      # Smoke: the Worker's public URL lives only in wrangler.jsonc
      # (WEBHOOK_BASE_URL) — extract it rather than duplicate it here. On
      # failure the new version stays live; rollback is manual
      # (`wrangler rollback`, see the README runbook).
      - name: Smoke check /health
        run: |
          url="$(sed -n 's/.*"WEBHOOK_BASE_URL": *"\([^"]*\)".*/\1/p' apps/logosmith-bot/wrangler.jsonc)"
          if [ -z "$url" ]; then
            echo "WEBHOOK_BASE_URL not found in wrangler.jsonc" >&2
            exit 1
          fi
          body="$(curl -sfS --retry 5 --retry-delay 5 --retry-all-errors "$url/health")"
          echo "$body"
          echo "$body" | grep -q '"botId": *"bot-logosmith"' || {
            echo "/health body did not contain botId bot-logosmith" >&2
            exit 1
          }
```

- [ ] **Step 4: Lint the workflow with actionlint**

Download the pinned actionlint binary into the session scratchpad (or any writable temp dir — NOT the repo) and run it:

```bash
VERSION=1.7.7
curl -sSfL "https://github.com/rhysd/actionlint/releases/download/v${VERSION}/actionlint_${VERSION}_linux_amd64.tar.gz" \
  | tar -xz -C "$SCRATCH_DIR" actionlint
"$SCRATCH_DIR/actionlint" .github/workflows/deploy-logosmith.yml
```

Expected: no output, exit code 0. Any finding (shellcheck included) is a real defect in the file — fix it, don't suppress it.

- [ ] **Step 5: Verify the smoke-check URL extraction against the real file**

Run: `sed -n 's/.*"WEBHOOK_BASE_URL": *"\([^"]*\)".*/\1/p' apps/logosmith-bot/wrangler.jsonc`
Expected: exactly one non-empty line — currently `https://logosmith-bot.example.workers.dev` (the placeholder; after the operator provisions, the same command prints the real URL — either proves the extraction works).

- [ ] **Step 6: Run the gate commands the workflow will run**

Run: `pnpm --filter "@botguild/logosmith-bot..." typecheck`
Expected: `Scope: 3 of 14 workspace projects`, then `typecheck: Done` for `packages/agent-core`, `packages/agent-core-workers`, and `apps/logosmith-bot` (verified working on this branch 2026-08-05).

Run: `pnpm --filter "@botguild/logosmith-bot..." test`
Expected: same 3-project scope, all test suites pass (exit 0). Takes a few minutes.

- [ ] **Step 7: Verify the deploy step's config/bundle without credentials**

Run: `pnpm --filter @botguild/logosmith-bot exec wrangler deploy --dry-run`
Expected: bundle report ending with a `Total Upload:` line (~5874 KiB / ~1978 KiB gzip per the README) and `--dry-run: exiting now.` — no auth needed; this proves `wrangler.jsonc` parses and the Worker bundles. Placeholder IDs are fine for a dry run.

- [ ] **Step 8: Commit**

```bash
git add apps/logosmith-bot/package.json .github/workflows/deploy-logosmith.yml
git commit -m "$(cat <<'EOF'
ci(logosmith): add path-filtered auto-deploy from develop

New deploy-logosmith.yml: on develop pushes touching the app subtree,
the shared packages compiled into its bundle, or the workflow itself
(plus manual dispatch), run a logosmith-scoped typecheck+test gate,
apply D1 migrations, deploy with the workspace-pinned wrangler, and
smoke-check /health. Adds the db:migrate script the workflow calls.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WyqJQiVwR5gHNwaTuwqEZJ
EOF
)"
```

---

### Task 2: README runbook updates

**Files:**
- Modify: `apps/logosmith-bot/README.md` (the "Ordered deploy runbook" section, currently lines 288–348)

**Interfaces:**
- Consumes: workflow `.github/workflows/deploy-logosmith.yml`, display name `Deploy LogoSmith`, GitHub secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` (from Task 1).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add queue creation to runbook step 1**

In the runbook's first code block, find:

```bash
wrangler kv namespace create CACHE
wrangler r2 bucket create logosmith-deliverables   # if it doesn't already exist
```

and append directly below, inside the same code block:

```bash

# Both queues too — `wrangler deploy` binds them but does NOT create them.
wrangler queues create logosmith-jobs
wrangler queues create logosmith-jobs-dlq
```

- [ ] **Step 2: Add the CI auto-deploy subsection**

Find the paragraph ending:

```
`{"status": ..., "botId": "bot-logosmith", ...}`, with a `reputation` field
once the cron has run at least once.
```

Insert after it (before `## DLQ replay runbook`), separated by blank lines:

```markdown
### CI auto-deploy (GitHub Actions)

Steps 3 and 5 also run automatically: `.github/workflows/deploy-logosmith.yml`
applies migrations and deploys on every push to `develop` that touches
`apps/logosmith-bot/`, `packages/agent-core/`, `packages/agent-core-workers/`,
or the workflow file itself — gated on a logosmith-scoped typecheck + test
run, and finished with the same `GET /health` sanity check. It needs two
GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare Workers"
token template, plus D1 Edit) and `CLOUDFLARE_ACCOUNT_ID`. The workflow can
also be dispatched manually (Actions → Deploy LogoSmith) for redeploys no
trigger path covers — e.g. a dependency bump that only changes
`pnpm-lock.yaml` — and for the pre-merge bring-up run from the `logosmith`
branch.

If the smoke check fails, the newly deployed version **stays live** — roll
back by hand with `wrangler rollback` (run in `apps/logosmith-bot/`).
```

- [ ] **Step 3: Verify formatting**

Run: `pnpm format:check`
Expected: exit 0 (prettier reports all matched files use the correct style). If it flags `apps/logosmith-bot/README.md`, run `pnpm exec prettier --write apps/logosmith-bot/README.md` and re-check.

- [ ] **Step 4: Commit**

```bash
git add apps/logosmith-bot/README.md
git commit -m "$(cat <<'EOF'
docs(logosmith): runbook — queue creation, CI auto-deploy, rollback

The runbook never created the two queues wrangler deploy requires.
Document the deploy-logosmith.yml pipeline (triggers, GitHub secrets,
manual dispatch) and manual rollback after a failed smoke check.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WyqJQiVwR5gHNwaTuwqEZJ
EOF
)"
```

---

### Task 3: gitflow + tech-debt doc updates

**Files:**
- Modify: `docs/cicd/gitflow.md` (branches table line 12, "CI and the gates" line 80, FAQ lines 89–91)
- Modify: `docs/tech-debt.md` (new entry at top, below the `# Tech Debt` heading)

**Interfaces:**
- Consumes: workflow `.github/workflows/deploy-logosmith.yml` and its trigger semantics (from Task 1).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Update the stale `main` row in the branches table**

In `docs/cicd/gitflow.md`, replace:

```markdown
| `main` | Release branch — only release-ready commits; pushes here trigger Fly.io deploys | no |
```

with:

```markdown
| `main` | Release branch — only release-ready commits (the retired Fly bots used to deploy from here) | no |
```

- [ ] **Step 2: Replace the stale deploy-workflow bullet**

In the "CI and the gates" section, replace:

```markdown
- The deploy workflow (`deploy-agents.yml`) triggers only on push to `main`.
```

with:

```markdown
- `deploy-agents.yml` (the retired Fly bots' main-triggered deploy) is disabled
  dead code. The live deploy workflow is `deploy-logosmith.yml`: it
  auto-deploys the LogoSmith Worker on pushes to `develop` that touch its app
  subtree, the shared `packages/`, or the workflow file — gated on its own
  logosmith-scoped typecheck + tests (full CI runs in parallel and is not a
  dependency).
```

- [ ] **Step 3: Record the deliberate FAQ exception**

Replace the FAQ answer:

```markdown
Because Fly.io deploys money-spending production. The mental model "what's on
main is what's in production" is the easiest invariant to defend.
```

with:

```markdown
Because Fly.io deploys money-spending production. The mental model "what's on
main is what's in production" is the easiest invariant to defend. That
reasoning applied to the retired Fly bots; the LogoSmith Worker (2026-08)
deliberately deviates and deploys from `develop`, path-filtered and
self-gated — atomic Workers deploys plus a per-app test gate make the smaller
blast radius an acceptable trade for not running a release branch per Worker
bot.
```

- [ ] **Step 4: Add the tech-debt entry**

In `docs/tech-debt.md`, insert directly after the `# Tech Debt` heading (as the first entry):

```markdown
## CI Still Builds Retired Fly Bots; Workers Apps Have No Config Check

**Area:** `.github/workflows/ci.yml` (docker-build matrix) + the five Workers apps

**Recorded 2026-08-05** (while adding `deploy-logosmith.yml`): the
`docker-build` matrix still hadolints and builds Docker images for the three
retired Fly bots (sentinel/flow/verifier) on every push — CI minutes spent on
apps that no longer deploy anywhere (`deploy-agents.yml` is disabled dead
code). Meanwhile the other four Workers apps (jiffyapp-bot/-dispatch,
thumbforge-bot/-probe, voicewright-bot) get no `wrangler deploy --dry-run`
config/bundle check in CI at all; logosmith-bot is the only one with a deploy
pipeline.

**Options when picked up:** drop the retired bots from the docker-build matrix
(or remove the matrix and `deploy-agents.yml` together); add a matrixed
`wrangler deploy --dry-run` CI job for the Workers apps; clone
`deploy-logosmith.yml` per Workers bot as each goes live.
```

- [ ] **Step 5: Verify formatting**

Run: `pnpm format:check`
Expected: exit 0. If it flags either edited doc, run `pnpm exec prettier --write docs/cicd/gitflow.md docs/tech-debt.md` and re-check.

- [ ] **Step 6: Commit**

```bash
git add docs/cicd/gitflow.md docs/tech-debt.md
git commit -m "$(cat <<'EOF'
docs(cicd): record the develop-branch deploy exception for logosmith

gitflow.md still said deploys ride pushes to main via deploy-agents.yml,
which is disabled dead code. Point it at deploy-logosmith.yml and note
the deliberate deviation in the FAQ. Add a tech-debt entry for the
retired-bot docker matrix and the unchecked Workers apps.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WyqJQiVwR5gHNwaTuwqEZJ
EOF
)"
```

---

## After the plan: operator bring-up (not plan tasks — needs the Cloudflare account)

Per spec §3, in order, before merging `logosmith` → `develop`: provision D1/KV/R2 + both queues; commit real IDs and the real `WEBHOOK_BASE_URL` into `wrangler.jsonc`; `wrangler secret put` the 10 runtime secrets; add the two GitHub repo secrets; then validate the pipeline by dispatching **Deploy LogoSmith** from the `logosmith` branch (that run is the bring-up deploy). Merge only after that run is green. Success criteria are in the spec's final section.
