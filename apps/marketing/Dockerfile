# syntax=docker/dockerfile:1.6
# Install dependencies only when needed
FROM node:22.17.0-alpine AS deps
WORKDIR /app

COPY --from=oven/bun:1.3.12-alpine /usr/local/bin/bun /usr/local/bin/bun

# Copy workspace manifests — marketing depends on @pagespace/lib,
# which in turn depends on @pagespace/db. bun needs all three
# package.json files present before it can resolve the workspace graph.
COPY package.json bun.lock ./
COPY packages/db/package.json ./packages/db/
COPY packages/lib/package.json ./packages/lib/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/cli/package.json ./packages/cli/
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

# Install all workspace dependencies
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile

# Copy source code after dependencies are installed
COPY packages ./packages
COPY apps/marketing ./apps/marketing
COPY tsconfig.json ./
COPY types ./types

# Build stage
FROM node:22.17.0-alpine AS builder
WORKDIR /app

COPY --from=oven/bun:1.3.12-alpine /usr/local/bin/bun /usr/local/bin/bun

COPY --from=deps /app .

# Accept build arguments for Next.js environment variables
ARG NEXT_PUBLIC_MARKETING_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_COOKIE_DOMAIN
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID
ARG NEXT_PUBLIC_ENABLE_ONE_TAP
ARG NEXT_PUBLIC_GA_MEASUREMENT_ID

ENV NEXT_PUBLIC_MARKETING_URL=$NEXT_PUBLIC_MARKETING_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_COOKIE_DOMAIN=$NEXT_PUBLIC_COOKIE_DOMAIN
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID
ENV NEXT_PUBLIC_ENABLE_ONE_TAP=$NEXT_PUBLIC_ENABLE_ONE_TAP
ENV NEXT_PUBLIC_GA_MEASUREMENT_ID=$NEXT_PUBLIC_GA_MEASUREMENT_ID

ENV NODE_ENV=production

# Build workspace deps first so their dist/ output (which marketing
# consumes via the package.json "exports" map) is available.
RUN bun run --filter '@pagespace/db' build && bun run --filter '@pagespace/lib' build

RUN cd apps/marketing && bun run build

# Production image
FROM node:22.17.0-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy the standalone output
COPY --from=builder /app/apps/marketing/.next/standalone .
COPY --from=builder /app/apps/marketing/.next/static ./apps/marketing/.next/static
COPY --from=builder /app/apps/marketing/public ./apps/marketing/public

RUN mkdir -p /app/apps/marketing/.next/cache && chown -R node:node /app/apps/marketing/.next

USER node

EXPOSE 3004

ENV PORT=3004
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/marketing/server.js"]
