# syntax=docker/dockerfile:1.6
FROM node:22.17.0-alpine AS deps
WORKDIR /app

COPY --from=oven/bun:1.3.12-alpine /usr/local/bin/bun /usr/local/bin/bun

COPY package.json bun.lock ./
COPY packages/db/package.json ./packages/db/
COPY packages/lib/package.json ./packages/lib/
COPY apps/admin/package.json ./apps/admin/

RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile

COPY packages ./packages
COPY apps/admin ./apps/admin
COPY tsconfig.json ./
COPY types ./types

FROM node:22.17.0-alpine AS builder
WORKDIR /app

COPY --from=oven/bun:1.3.12-alpine /usr/local/bin/bun /usr/local/bin/bun

COPY --from=deps /app .

ARG NEXT_PUBLIC_WEB_APP_URL=""
ENV NEXT_PUBLIC_WEB_APP_URL=$NEXT_PUBLIC_WEB_APP_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN bun run --filter '@pagespace/db' build && bun run --filter '@pagespace/lib' build
RUN cd apps/admin && NODE_OPTIONS="--max-old-space-size=2048" bun run build

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
