# JiffyApp Dispatch (`@botguild/jiffyapp-dispatch`)

The thin router in front of every generated JiffyApp tool. It is routed on `*.jiffyapp.dev/*` and does exactly one thing per request: turn a hostname into a slug, look up that slug's serving status, and hand the request to the right script in the Workers for Platforms dispatch namespace — or bounce it.

```
request → resolveSlug(hostname)          # one label under jiffyapp.dev; else 404
        → stg-* ?                        # staging build → straight through, no-store + noindex
        → SELECT status FROM tools       # shared D1 (same database as jiffyapp-bot)
        → live | grace  → DISPATCH.get(slug).fetch(request)
        → suspended | killed → 410 (eject-note page)
        → unknown            → 404
```

- **`resolveSlug`** (`src/decide.ts`) accepts exactly one label directly under `TOOL_HOST_SUFFIX` (`jiffyapp.dev`) — the apex, `www`, and nested/foreign hosts all resolve to `null` → 404.
- **`stg-` passthrough:** staging builds (created by the bot's build pipeline before promotion, so the golden-assertion Playwright runs have something to hit) have no `tools` row yet. `isStagingSlug` short-circuits *before* the D1 read and routes straight into the dispatch namespace, with the response re-marked `Cache-Control: no-store` and `X-Robots-Tag: noindex` so a staging preview never lands in a cache or a search index.
- **`decideDispatch`** maps `tools.status` to an outcome: `live`/`grace` serve normally; `suspended`/`killed` return the 410 eject-note page; anything else (including no row at all) is a plain 404. A script that's missing from the namespace despite a serving status (a promote-race) also falls back to 404 rather than a 500 loop.

**Shared D1.** This Worker's `DB` binding must point at the **same** database as `jiffyapp-bot` (`database_id` pasted into both `wrangler.jsonc` files) — it only ever reads `tools.status`; all writes happen on the bot side.

**Deploy this Worker first.** The wildcard route (`*.jiffyapp.dev/*`) has to exist before the bot stages its first tool, or the very first staged build has nowhere to be reached from. See the [`jiffyapp-bot` README](../jiffyapp-bot/README.md) for the full Phase 0 checklist and ordered deploy runbook — this app has no secrets and no independent deploy steps beyond `wrangler deploy` once the shared D1 id and the `jiffyapp.dev` zone/route exist.

```bash
pnpm --filter @botguild/jiffyapp-dispatch build       # tsc
pnpm --filter @botguild/jiffyapp-dispatch typecheck
pnpm --filter @botguild/jiffyapp-dispatch test        # node:test via tsx — pure routing policy, no bindings
pnpm --filter @botguild/jiffyapp-dispatch lint
```
