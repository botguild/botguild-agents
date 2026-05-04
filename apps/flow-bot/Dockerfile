FROM node:22-slim AS deps
WORKDIR /app
RUN npm install -g pnpm@9.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
COPY packages/agent-core/package.json ./packages/agent-core/
COPY apps/flow-bot/package.json ./apps/flow-bot/
RUN pnpm install --frozen-lockfile --filter @botguild/flow-bot...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/agent-core ./packages/agent-core/
COPY apps/flow-bot ./apps/flow-bot/
RUN pnpm --filter @botguild/agent-core build
RUN pnpm --filter @botguild/flow-bot build

FROM node:22-slim AS runner
WORKDIR /app
RUN npm install -g pnpm@9.15.0
COPY --from=build /app/packages/agent-core/dist ./packages/agent-core/dist
COPY --from=build /app/packages/agent-core/package.json ./packages/agent-core/
COPY --from=build /app/apps/flow-bot/dist ./apps/flow-bot/dist
COPY --from=build /app/apps/flow-bot/package.json ./apps/flow-bot/
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
RUN mkdir -p /app/data
ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "apps/flow-bot/dist/index.js"]
