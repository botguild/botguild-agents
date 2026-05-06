# Multi-stage build for SentinelBot.
#
# `deps` installs workspace deps. `build` compiles TypeScript and then runs
# `pnpm deploy` to materialize a self-contained app directory — workspace
# packages (`@botguild/agent-core`) get copied in as real directories so the
# runner stage doesn't need pnpm symlinks to resolve them.

FROM node:22-slim AS deps
WORKDIR /app
RUN npm install -g pnpm@9.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
COPY packages/agent-core/package.json ./packages/agent-core/
COPY apps/sentinel-bot/package.json ./apps/sentinel-bot/
RUN pnpm install --frozen-lockfile --filter @botguild/sentinel-bot...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/agent-core ./packages/agent-core/
COPY apps/sentinel-bot ./apps/sentinel-bot/
RUN pnpm --filter @botguild/agent-core build
RUN pnpm --filter @botguild/sentinel-bot build
# Produce /app/deploy with workspace deps materialized as real packages.
RUN pnpm --filter @botguild/sentinel-bot deploy --prod /app/deploy

FROM mcr.microsoft.com/playwright:v1.49.0-noble AS runner
WORKDIR /app
COPY --from=build /app/deploy ./
RUN mkdir -p /app/data
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "dist/index.js"]
