# syntax=docker/dockerfile:1.6
FROM node:22.17.0-alpine AS deps
WORKDIR /app

RUN corepack enable && (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/lib/package.json ./packages/lib/
COPY apps/admin/package.json ./apps/admin/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

COPY packages ./packages
COPY apps/admin ./apps/admin
COPY tsconfig.json ./
COPY types ./types

FROM node:22.17.0-alpine AS builder
WORKDIR /app
RUN corepack enable && (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

COPY --from=deps /app .

ARG NEXT_PUBLIC_WEB_APP_URL=""
ENV NEXT_PUBLIC_WEB_APP_URL=$NEXT_PUBLIC_WEB_APP_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter @pagespace/db build && pnpm --filter @pagespace/lib build
RUN cd apps/admin && NODE_OPTIONS="--max-old-space-size=2048" pnpm build

ENV NODE_ENV=production

FROM node:22.17.0-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN mkdir -p /app/apps/admin/.next/cache && chown -R node:node /app/apps/admin/.next

COPY --from=builder /app/apps/admin/.next/standalone .
COPY --from=builder /app/apps/admin/.next/static ./apps/admin/.next/static

USER node

EXPOSE 3005
ENV PORT=3005

CMD ["node", "apps/admin/server.js"]
