# syntax=docker/dockerfile:1.6
# Install dependencies only when needed
FROM node:22.17.0-alpine AS deps
WORKDIR /app

# Enable corepack and pin pnpm (with basic retry for transient network issues)
RUN corepack enable && (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

# Copy only package files for dependency installation
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/lib/package.json ./packages/lib/
COPY apps/web/package.json ./apps/web/
COPY apps/realtime/package.json ./apps/realtime/

# Install ALL dependencies for the entire monorepo
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

# Now copy source code AFTER dependencies are installed
COPY packages ./packages
COPY apps ./apps
COPY tsconfig.json ./

# Rebuild the source code only when needed
FROM node:22.17.0-alpine AS builder
WORKDIR /app
RUN corepack enable && (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

# Copy the installed dependencies and the entire source code
COPY --from=deps /app .

# Accept build arguments for Next.js environment variables
# NEXT_PUBLIC_* vars must be available at build time for Next.js to inline them
# Note: Stripe keys are hardcoded in stripe-config.ts to simplify Docker builds
ARG NEXT_PUBLIC_REALTIME_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB
ARG NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID

ENV NEXT_PUBLIC_REALTIME_URL=$NEXT_PUBLIC_REALTIME_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB=$NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB
ENV NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID

# Next.js collects telemetry data by default.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry.
# ENV NEXT_TELEMETRY_DISABLED 1

# We are installing devDependencies via the --prod=false flag, so this is not needed
# ENV NODE_ENV=development

# Build with development env to ensure Tailwind v4 processes correctly
# Increased memory for Scribe.js and other heavy dependencies
RUN cd apps/web && NODE_OPTIONS="--max-old-space-size=2048" pnpm build

# Reset NODE_ENV for production runtime
ENV NODE_ENV=production

# Production image, copy all the files and run next
FROM node:22.17.0-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Uncomment the following line in case you want to disable telemetry.
# ENV NEXT_TELEMETRY_DISABLED 1

# Use the existing node user (UID 1000) from the base image
# This matches the processor container's UID for shared volume access
RUN mkdir -p /app/storage && chown -R node:node /app/storage

# Copy the standalone output
COPY --from=builder /app/apps/web/.next/standalone .
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

USER node

EXPOSE 3000

ENV PORT=3000

# Start the server
CMD ["node", "apps/web/server.js"]
