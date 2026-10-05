# syntax=docker/dockerfile:1.6
FROM node:22.17.0-alpine AS deps
WORKDIR /app

COPY --from=oven/bun:1.3.12-alpine /usr/local/bin/bun /usr/local/bin/bun

COPY package.json bun.lock ./
COPY packages/db/package.json ./packages/db/
COPY packages/lib/package.json ./packages/lib/
COPY packages/editor/package.json ./packages/editor/
COPY packages/browser-worker/package.json ./packages/browser-worker/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/cli/package.json ./packages/cli/
COPY apps/admin/package.json ./apps/admin/
COPY apps/android/package.json ./apps/android/
COPY apps/atlas/package.json ./apps/atlas/
COPY apps/control-plane/package.json ./apps/control-plane/
COPY apps/desktop/package.json ./apps/desktop/
COPY apps/e2e/package.json ./apps/e2e/
COPY apps/imago/package.json ./apps/imago/
COPY apps/ios/package.json ./apps/ios/
COPY apps/marketing/package.json ./apps/marketing/
COPY apps/processor/package.json ./apps/processor/
COPY apps/realtime/package.json ./apps/realtime/
COPY apps/web/package.json ./apps/web/

RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile

COPY packages ./packages
COPY apps/imago ./apps/imago
COPY tsconfig.json ./
COPY types ./types

FROM node:22.17.0-alpine AS builder
WORKDIR /app

COPY --from=oven/bun:1.3.12-alpine /usr/local/bin/bun /usr/local/bin/bun

COPY --from=deps /app .

# NEXT_PUBLIC_* are inlined at build time; the runtime env cannot override them.
ARG NEXT_PUBLIC_REALTIME_URL=""
ENV NEXT_PUBLIC_REALTIME_URL=$NEXT_PUBLIC_REALTIME_URL
# Classic's cookie domain (apps/web/Dockerfile): the theme cookie must carry the
# same Domain in both apps, or imago leaves a host-only duplicate beside it.
ARG NEXT_PUBLIC_COOKIE_DOMAIN=""
ENV NEXT_PUBLIC_COOKIE_DOMAIN=$NEXT_PUBLIC_COOKIE_DOMAIN
ENV NEXT_TELEMETRY_DISABLED=1

RUN bun run --filter '@pagespace/db' build && bun run --filter '@pagespace/lib' build && bun run --filter '@pagespace/editor' build
RUN cd apps/imago && NODE_OPTIONS="--max-old-space-size=2048" bun run build

ENV NODE_ENV=production

FROM node:22.17.0-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN mkdir -p /app/apps/imago/.next/cache && chown -R node:node /app/apps/imago/.next

COPY --from=builder /app/apps/imago/.next/standalone .
COPY --from=builder /app/apps/imago/.next/static ./apps/imago/.next/static

USER node

EXPOSE 3006
ENV PORT=3006
# Docker sets HOSTNAME to the container id and the standalone server binds to
# it, which would leave 127.0.0.1 (the healthcheck) unanswered.
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3006/imago/api/health || exit 1

CMD ["node", "apps/imago/server.js"]
