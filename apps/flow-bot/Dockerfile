# Multi-stage build for FlowBot.
#
# `deps` installs workspace deps. `build` compiles TypeScript and then runs
# `pnpm deploy` to materialize a self-contained app directory — workspace
# packages (`@botguild/agent-core`) get copied in as real directories so the
# runner stage doesn't need pnpm symlinks to resolve them.

FROM node:22-slim AS deps
WORKDIR /app
RUN npm install -g pnpm@9.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
# pnpm-lock.yaml registers patchedDependencies; install fails without the patch files.
COPY patches ./patches/
COPY packages/agent-core/package.json ./packages/agent-core/
COPY apps/flow-bot/package.json ./apps/flow-bot/
RUN pnpm install --frozen-lockfile --filter @botguild/flow-bot...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/agent-core ./packages/agent-core/
COPY apps/flow-bot ./apps/flow-bot/
RUN pnpm --filter @botguild/agent-core build
RUN pnpm --filter @botguild/flow-bot build
RUN pnpm --filter @botguild/flow-bot deploy --prod /app/deploy

FROM node:22-slim AS runner
WORKDIR /app
COPY --from=build /app/deploy ./
RUN mkdir -p /app/data
ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "dist/index.js"]
