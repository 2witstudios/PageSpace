# syntax=docker/dockerfile:1.6
# Multi-stage build for the realtime Socket.IO service

# Stage 1: Install dependencies and build
FROM node:22.17.0-alpine AS builder
WORKDIR /app

COPY --from=oven/bun:1.3.12-alpine /usr/local/bin/bun /usr/local/bin/bun

COPY package.json bun.lock ./
COPY packages/db/package.json ./packages/db/
COPY packages/lib/package.json ./packages/lib/
COPY apps/admin/package.json ./apps/admin/
COPY apps/android/package.json ./apps/android/
COPY apps/atlas/package.json ./apps/atlas/
COPY apps/control-plane/package.json ./apps/control-plane/
COPY apps/desktop/package.json ./apps/desktop/
COPY apps/e2e/package.json ./apps/e2e/
COPY apps/ios/package.json ./apps/ios/
COPY apps/marketing/package.json ./apps/marketing/
COPY apps/processor/package.json ./apps/processor/
COPY apps/realtime/package.json ./apps/realtime/
COPY apps/web/package.json ./apps/web/

RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile

COPY types ./types
COPY packages/db ./packages/db
COPY packages/lib ./packages/lib
COPY apps/realtime ./apps/realtime
COPY tsconfig.json ./

# Build shared packages and the realtime service
RUN bun run --filter '@pagespace/db' build && \
    bun run --filter '@pagespace/lib' build && \
    bun run --filter 'realtime' build

# Stage 2: Production runner
FROM node:22.17.0-alpine AS runner
WORKDIR /app

COPY --from=oven/bun:1.3.12-alpine /usr/local/bin/bun /usr/local/bin/bun

# Copy manifests and lockfile for production install
COPY --from=builder /app/package.json /app/bun.lock ./
COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/packages/lib/package.json ./packages/lib/
COPY --from=builder /app/apps/admin/package.json ./apps/admin/
COPY --from=builder /app/apps/android/package.json ./apps/android/
COPY --from=builder /app/apps/atlas/package.json ./apps/atlas/
COPY --from=builder /app/apps/control-plane/package.json ./apps/control-plane/
COPY --from=builder /app/apps/desktop/package.json ./apps/desktop/
COPY --from=builder /app/apps/e2e/package.json ./apps/e2e/
COPY --from=builder /app/apps/ios/package.json ./apps/ios/
COPY --from=builder /app/apps/marketing/package.json ./apps/marketing/
COPY --from=builder /app/apps/processor/package.json ./apps/processor/
COPY --from=builder /app/apps/realtime/package.json ./apps/realtime/
COPY --from=builder /app/apps/web/package.json ./apps/web/

# Install production-only dependencies
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile --production

# Copy only compiled runtime artifacts from builder
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/lib/dist ./packages/lib/dist
COPY --from=builder /app/apps/realtime/dist ./apps/realtime/dist

ENV NODE_ENV=production

USER node

EXPOSE 3001

CMD ["node", "apps/realtime/dist/apps/realtime/src/index.js"]
