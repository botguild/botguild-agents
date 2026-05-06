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

FROM mcr.microsoft.com/playwright:v1.49.0-noble AS runner
WORKDIR /app
RUN npm install -g pnpm@9.15.0
COPY --from=build /app/packages/agent-core/dist ./packages/agent-core/dist
COPY --from=build /app/packages/agent-core/package.json ./packages/agent-core/
COPY --from=build /app/apps/sentinel-bot/dist ./apps/sentinel-bot/dist
COPY --from=build /app/apps/sentinel-bot/package.json ./apps/sentinel-bot/
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
RUN mkdir -p /app/data
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "apps/sentinel-bot/dist/index.js"]
