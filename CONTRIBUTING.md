# Contributing

Thanks for your interest in BotGuild Agents! Contributions of all kinds are welcome — new reference bots, improvements to `agent-core`, docs, and bug reports.

## Ways to contribute

- **Build a bot** on `agent-core` — see [Build Your Own Bot](docs/build-your-own-bot.md). You don't need to upstream your bot, but PRs that add focused, well-documented example bots are welcome.
- **Improve `agent-core`** — the shared runtime. Keep changes backward-compatible where possible; it's the foundation every bot depends on.
- **Docs** — clarity fixes, new guides, and corrections are always appreciated.
- **Report bugs / request features** via [Issues](https://github.com/botguild/botguild-agents/issues).

## Development setup

```bash
# Prerequisites: Node.js 22, pnpm 9
pnpm install
cp .env.example .env     # fill in keys if you want to run a bot end-to-end
```

Common commands:

```bash
pnpm dev            # run bots in watch mode (scope with --filter @botguild/<bot>)
pnpm build          # build all packages
pnpm typecheck      # type-check the workspace
pnpm test           # run tests
pnpm lint           # eslint (zero warnings allowed)
pnpm format         # prettier --write
```

## Branching & workflow

This repo uses a lightweight gitflow (full model in [`docs/cicd/gitflow.md`](docs/cicd/gitflow.md)):

- **`develop`** is the default branch — branch off it.
- Use `feature/<slug>` (or `fix/<slug>`, `docs/<slug>`) branch names.
- Open your PR **against `develop`**, not `main`.
- **`main`** is release-only; merges to `main` trigger deploys.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) — e.g. `feat(agent-core): …`, `fix(flow-bot): …`, `docs: …`.

## Before you open a PR

Run the full check suite — CI runs the same and must be green:

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
```

PR checklist:

- [ ] Branched off `develop`, targeting `develop`
- [ ] `typecheck`, `test`, `lint`, and `format:check` all pass
- [ ] New behavior has tests where practical (see `packages/agent-core/src/*.test.ts`)
- [ ] Docs updated if you changed the public API, env vars, or setup
- [ ] No secrets or credentials committed (`.env` is gitignored — keep it that way)

## Adding a new bot

Copy the template and rename it — Turborepo and pnpm pick up new workspaces automatically:

```bash
cp -R apps/starter-bot apps/my-bot
rm -rf apps/my-bot/dist apps/my-bot/node_modules
#  → set "name": "@botguild/my-bot" in apps/my-bot/package.json
pnpm install
```

See [Build Your Own Bot](docs/build-your-own-bot.md) for the rest.

## Code style

- TypeScript, ESM, strict mode. Prefer the typed `agent-core` exports over reaching into `@botguild/sdk` directly.
- Formatting and linting are enforced by Prettier + ESLint — run `pnpm format` before pushing.
- Match the surrounding code's conventions and comment density.

## Conduct & licensing

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md). Contributions are accepted under the project's [MIT License](LICENSE).
