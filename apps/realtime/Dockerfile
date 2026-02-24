# syntax=docker/dockerfile:1.6
# Multi-stage build for the realtime Socket.IO service

# Stage 1: Install dependencies
FROM node:22.17.0-alpine AS deps
WORKDIR /app

RUN apk add --no-cache git && \
    npm config set fetch-timeout 300000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-retry-mintimeout 10000

RUN corepack enable && \
    (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/lib/package.json ./packages/lib/
COPY apps/web/package.json ./apps/web/
COPY apps/realtime/package.json ./apps/realtime/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile --prod=false

# Stage 2: Build shared packages
FROM node:22.17.0-alpine AS builder
WORKDIR /app
RUN corepack enable && \
    (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

COPY --from=deps /app .

COPY packages ./packages
COPY apps ./apps
COPY tsconfig.json ./

# Stage 3: Production runner
FROM node:22.17.0-alpine AS runner
WORKDIR /app

RUN corepack enable && \
    (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

COPY --from=builder /app .

ENV NODE_ENV=production

USER node

EXPOSE 3001

CMD ["pnpm", "--filter", "realtime", "start"]
