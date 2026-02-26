# syntax=docker/dockerfile:1.6
# Multi-stage build for the realtime Socket.IO service

# Stage 1: Install dependencies and build
FROM node:22.17.0-alpine AS builder
WORKDIR /app

RUN corepack enable && \
    (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/lib/package.json ./packages/lib/
COPY apps/web/package.json ./apps/web/
COPY apps/realtime/package.json ./apps/realtime/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile --prod=false

COPY packages ./packages
COPY apps/realtime ./apps/realtime
COPY tsconfig.json ./

# Build shared packages and the realtime service
RUN pnpm --filter @pagespace/db build && \
    pnpm --filter @pagespace/lib build && \
    pnpm --filter realtime build

# Stage 2: Production runner
FROM node:22.17.0-alpine AS runner
WORKDIR /app

RUN corepack enable && \
    (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

# Copy manifests and lockfile for production install
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/packages/lib/package.json ./packages/lib/
COPY --from=builder /app/apps/web/package.json ./apps/web/
COPY --from=builder /app/apps/realtime/package.json ./apps/realtime/

# Install production-only dependencies
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile --prod

# Copy built artifacts from builder (only dist/ and package.json, not source/tests)
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/packages/lib/dist ./packages/lib/dist
COPY --from=builder /app/packages/lib/package.json ./packages/lib/
COPY --from=builder /app/apps/realtime/dist ./apps/realtime/dist
COPY --from=builder /app/apps/realtime/package.json ./apps/realtime/

ENV NODE_ENV=production

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3001/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)})"

CMD ["node", "apps/realtime/dist/index.js"]
