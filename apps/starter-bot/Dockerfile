# Multi-stage build for StarterBot (template).
#
# `deps` installs workspace deps, `build` compiles TypeScript and runs
# `pnpm deploy` to materialize a self-contained app directory (workspace
# packages like @botguild/agent-core are copied in as real directories), and
# `runner` ships only the built output.
#
# Build from the REPO ROOT so the monorepo is the Docker context:
#   flyctl deploy . --remote-only --config apps/starter-bot/fly.toml

FROM node:22-slim AS deps
WORKDIR /app
RUN npm install -g pnpm@9.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
COPY packages/agent-core/package.json ./packages/agent-core/
COPY apps/starter-bot/package.json ./apps/starter-bot/
RUN pnpm install --frozen-lockfile --filter @botguild/starter-bot...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/agent-core ./packages/agent-core/
COPY apps/starter-bot ./apps/starter-bot/
RUN pnpm --filter @botguild/agent-core build
RUN pnpm --filter @botguild/starter-bot build
RUN pnpm --filter @botguild/starter-bot deploy --prod /app/deploy

FROM node:22-slim AS runner
WORKDIR /app
COPY --from=build /app/deploy ./
RUN mkdir -p /app/data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
