# syntax=docker/dockerfile:1.6
# Install dependencies only when needed
FROM node:22.17.0-alpine AS deps
WORKDIR /app

# Enable corepack and pin pnpm
RUN corepack enable && (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

# Copy workspace manifests — marketing depends on @pagespace/lib,
# which in turn depends on @pagespace/db. pnpm needs all three
# package.json files present before it can resolve the workspace graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/lib/package.json ./packages/lib/
COPY apps/marketing/package.json ./apps/marketing/

# Install dependencies for marketing and its transitive workspace deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile --filter marketing...

# Copy source code after dependencies are installed
COPY packages ./packages
COPY apps/marketing ./apps/marketing
COPY tsconfig.json ./
COPY types ./types

# Build stage
FROM node:22.17.0-alpine AS builder
WORKDIR /app
RUN corepack enable && (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

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
RUN pnpm --filter @pagespace/db build && pnpm --filter @pagespace/lib build

RUN cd apps/marketing && pnpm build

# Production image
FROM node:22.17.0-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy the standalone output
COPY --from=builder /app/apps/marketing/.next/standalone .
COPY --from=builder /app/apps/marketing/.next/static ./apps/marketing/.next/static
COPY --from=builder /app/apps/marketing/public ./apps/marketing/public

USER node

EXPOSE 3004

ENV PORT=3004
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/marketing/server.js"]
