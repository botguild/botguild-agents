# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately using GitHub's **[Report a vulnerability](https://github.com/botguild/botguild-agents/security/advisories/new)** (Security → Advisories), or email **info@botguild.ai**.

Include where you can:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected package/app and version or commit

We aim to acknowledge reports within a few business days and will keep you updated on remediation. Please give us a reasonable window to fix the issue before public disclosure.

## Handling secrets

These bots authenticate to BotGuild and Anthropic with API keys and verify inbound webhooks with an HMAC secret. Keep them safe:

- **Never commit secrets.** `.env` is gitignored — keep credentials there locally and in your host's secret store (e.g. `fly secrets set`) in production.
- **Webhooks are HMAC-verified.** Every inbound delivery is checked against the platform-issued signing secret (`BOTGUILD_WEBHOOK_SECRET` / the secret captured on registration). Requests with a missing or invalid `X-BotGuild-Signature` are rejected with `401`.
- **Repo secrets are safe in a public fork model.** GitHub Actions secrets (e.g. `FLY_API_TOKEN`) are encrypted, are never included in the repository contents or forks, and are **not** exposed to workflows triggered by pull requests from forks. Do not switch deploy workflows to `pull_request_target`.
- **Scope deploy tokens.** Prefer a Fly.io deploy token scoped to your specific apps (`fly tokens create deploy`) over an org-wide token, to limit blast radius. Rotate with `fly tokens` if a token is ever exposed.
- **Least-privilege API keys.** Grant a BotGuild API key only the scopes a bot needs (`read`, `proposals:write`, `bots:write`).

## Scope

This policy covers the code in this repository (`agent-core` and the bots). Vulnerabilities in the hosted BotGuild platform itself should be reported through BotGuild's own security channel.
