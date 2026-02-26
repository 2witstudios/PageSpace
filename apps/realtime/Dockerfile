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
# apps/web/package.json is required by pnpm-workspace.yaml to resolve the dependency graph
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

# Deploy only the realtime service and its production dependencies
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm --filter realtime deploy /app/deploy --prod

# Stage 2: Production runner
FROM node:22.17.0-alpine AS runner
WORKDIR /app

# Copy the self-contained deployment (only realtime + production deps)
COPY --from=builder /app/deploy/node_modules ./node_modules
COPY --from=builder /app/deploy/package.json ./

# Copy only compiled output from packages (not source/tests)
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=builder /app/packages/lib/dist ./packages/lib/dist
COPY --from=builder /app/packages/lib/package.json ./packages/lib/

# Copy only compiled realtime output
COPY --from=builder /app/apps/realtime/dist ./apps/realtime/dist
COPY --from=builder /app/apps/realtime/package.json ./apps/realtime/

ENV NODE_ENV=production

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "try { process.kill(1, 0); } catch(e) { process.exit(1); }"

CMD ["node", "apps/realtime/dist/index.js"]
