# Gitflow — botguild-agents

This repo uses a lightweight gitflow. The discipline lives in convention plus
fast-green CI rather than enforced branch protection (which isn't available
on this GitHub plan).

## Branches

| Branch | Purpose | Default? |
|---|---|---|
| `develop` | Integration branch — every epic/feature lands here first | **yes** (GitHub default) |
| `main` | Release branch — only release-ready commits (the retired Fly bots used to deploy from here) | no |
| `epic/eN-<slug>` | Long-lived branch for a whole epic that contains multiple stories | branched off `develop`; merges back to `develop` |
| `feature/<slug>` | Short-lived branch for a single story or bugfix | branched off `develop`; merges back to `develop` |
| `release/<version>` | Optional — a stabilization branch when a release needs final polish | branched off `develop`; merges to both `main` and `develop` |
| `hotfix/<slug>` | Urgent production fix | branched off `main`; merges back to both `main` and `develop` |

## Day-to-day flow

```
       feature/foo ──┐
                     ▼
develop ───●─────────●─────●───────────●───●  ← integration
                                       │
                                       ▼
                                       (release time)
                                       │
main    ─────────────────────────────●─●     ← release / Fly.io deploy
```

1. Make sure your local `develop` is up to date: `git checkout develop && git pull`.
2. Branch off: `git checkout -b feature/<slug>` (or `epic/eN-<slug>` for an epic).
3. Commit. CI runs on every push.
4. Open a PR — the base defaults to `develop`. Reviewers expect green CI.
5. Merge to `develop` (use a merge commit so the branch's history stays visible).

## Releasing to `main`

Releases are intentional events that trigger Fly.io deploys. Two acceptable patterns:

**Direct merge** (simplest, fine for solo work / small batches):
```bash
git checkout main && git pull
git merge --no-ff develop
git push origin main      # triggers deploy-agents.yml
```

**Release branch** (when develop has more than the next release should ship):
```bash
git checkout -b release/2026-05-07 develop
# stabilize: only bugfixes, version bumps, changelog
git checkout main && git merge --no-ff release/2026-05-07
git push origin main
git checkout develop && git merge --no-ff release/2026-05-07
git branch -d release/2026-05-07
```

## Hotfixes

For an urgent fix to the live deployment:

```bash
git checkout -b hotfix/<slug> main
# fix + commit
git checkout main && git merge --no-ff hotfix/<slug>
git push origin main      # triggers deploy
git checkout develop && git merge --no-ff hotfix/<slug>
git branch -d hotfix/<slug>
```

The hotfix has to land in **both** `main` and `develop`, otherwise the next
release from `develop` will silently regress it.

## CI and the gates

- CI runs on push to **any** branch and on PRs targeting either `develop` or `main`.
- All required checks (lint, typecheck, test, docker-build × 3) must be green
  before merging — but this is enforced by reviewer convention and the PR
  status panel, not by GitHub branch protection.
- `deploy-agents.yml` (the retired Fly bots' main-triggered deploy) is disabled
  dead code. The live deploy workflow is `deploy-logosmith.yml`: it
  auto-deploys the LogoSmith Worker on pushes to `develop` that touch its app
  subtree, the shared `packages/`, or the workflow file — gated on its own
  logosmith-scoped typecheck + tests (full CI runs in parallel and is not a
  dependency).

## FAQ

**Why not just use trunk-based with `main`?**
We did, and the merge of PR #1 produced 35 review findings that were merged
without auto-test enforcement. With gitflow we keep `main` clean (deploy-only)
and let `develop` absorb integration risk.

**Why not a "develop is the deploy branch" model?**
Because Fly.io deploys money-spending production. The mental model "what's on
main is what's in production" is the easiest invariant to defend. That
reasoning applied to the retired Fly bots; the LogoSmith Worker (2026-08)
deliberately deviates and deploys from `develop`, path-filtered and
self-gated — atomic Workers deploys plus a per-app test gate make the smaller
blast radius an acceptable trade for not running a release branch per Worker
bot.

**Can I push directly to `develop`?**
Technically yes, no rules block it. Don't — every change should ride a
PR so CI runs at least once on the merge target.

**Can I push directly to `main`?**
Same as above. Don't — releases should go through the patterns above so
the deploy is intentional and the merge commit names what shipped.
