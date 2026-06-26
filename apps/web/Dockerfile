# syntax=docker/dockerfile:1.6
# Install dependencies only when needed
FROM node:24.16.0-alpine AS deps
WORKDIR /app

COPY --from=oven/bun:1.3.12-alpine /usr/local/bin/bun /usr/local/bin/bun

# Copy only package files for dependency installation
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

# Install ALL dependencies for the entire monorepo
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile

# Now copy source code AFTER dependencies are installed
COPY packages ./packages
COPY apps ./apps
COPY tsconfig.json ./
COPY types ./types

# Rebuild the source code only when needed
FROM node:24.16.0-alpine AS builder
WORKDIR /app

COPY --from=oven/bun:1.3.12-alpine /usr/local/bin/bun /usr/local/bin/bun

# Copy the installed dependencies and the entire source code
COPY --from=deps /app .

# Accept build arguments for Next.js environment variables
# NEXT_PUBLIC_* vars must be available at build time for Next.js to inline them
# Note: Stripe keys are hardcoded in stripe-config.ts to simplify Docker builds
ARG NEXT_PUBLIC_REALTIME_URL=""
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB
ARG NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID
ARG NEXT_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID=""
ARG NEXT_PUBLIC_ADMIN_APP_URL=""
ARG NEXT_PUBLIC_PUBLISH_EDGE_IPV4=""
ARG NEXT_PUBLIC_PUBLISH_EDGE_IPV6=""
ARG NEXT_PUBLIC_PUBLISH_EDGE_CNAME_TARGET=""
ARG NEXT_PUBLIC_COOKIE_DOMAIN=""

ENV NEXT_PUBLIC_REALTIME_URL=$NEXT_PUBLIC_REALTIME_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB=$NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB
ENV NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID
ENV NEXT_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID
ENV NEXT_PUBLIC_ADMIN_APP_URL=$NEXT_PUBLIC_ADMIN_APP_URL
ENV NEXT_PUBLIC_PUBLISH_EDGE_IPV4=$NEXT_PUBLIC_PUBLISH_EDGE_IPV4
ENV NEXT_PUBLIC_PUBLISH_EDGE_IPV6=$NEXT_PUBLIC_PUBLISH_EDGE_IPV6
ENV NEXT_PUBLIC_PUBLISH_EDGE_CNAME_TARGET=$NEXT_PUBLIC_PUBLISH_EDGE_CNAME_TARGET
ENV NEXT_PUBLIC_COOKIE_DOMAIN=$NEXT_PUBLIC_COOKIE_DOMAIN
ARG NEXT_PUBLIC_SENTRY_DSN=""
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ARG SENTRY_AUTH_TOKEN=""
ENV SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN
ARG SENTRY_ORG=""
ENV SENTRY_ORG=$SENTRY_ORG
ARG SENTRY_PROJECT=""
ENV SENTRY_PROJECT=$SENTRY_PROJECT

# Next.js collects telemetry data by default.
# Learn more here: https://nextjs.org/telemetry
ENV NEXT_TELEMETRY_DISABLED=1

# Build dependent packages first (db + lib must compile before web)
RUN bun run --filter '@pagespace/db' build && bun run --filter '@pagespace/lib' build

# Build with development env to ensure Tailwind v4 processes correctly
# Increased memory for Scribe.js and other heavy dependencies
RUN cd apps/web && NODE_OPTIONS="--max-old-space-size=4096" bun run build

# Reset NODE_ENV for production runtime
ENV NODE_ENV=production

# Production image, copy all the files and run next
FROM node:24.16.0-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Use the existing node user (UID 1000) from the base image
# This matches the processor container's UID for shared volume access
RUN mkdir -p /app/storage && chown -R node:node /app/storage

# Ensure Next.js image cache directory is writable by node user
RUN mkdir -p /app/apps/web/.next/cache && chown -R node:node /app/apps/web/.next

# Copy the standalone output
COPY --from=builder /app/apps/web/.next/standalone .
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

USER node

EXPOSE 3000

ENV PORT=3000

# Start the server
CMD ["node", "apps/web/server.js"]
