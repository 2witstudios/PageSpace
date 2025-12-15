# syntax=docker/dockerfile:1.6
# This Dockerfile runs the realtime service.
# It uses the same pattern as the working migrate container.
FROM node:22.17.0-alpine

# Set working directory
WORKDIR /app

# Install basic tools and configure npm
RUN apk add --no-cache git && \
    npm config set fetch-timeout 300000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-retry-mintimeout 10000

# Enable corepack and prepare specific pnpm version
RUN corepack enable && \
    (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

# Copy package files first for better Docker layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/lib/package.json ./packages/lib/
COPY apps/web/package.json ./apps/web/
COPY apps/realtime/package.json ./apps/realtime/

# Install ALL dependencies for the entire monorepo
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile --prod=false

# Copy only the source code needed (avoid copying node_modules)
COPY packages ./packages
COPY apps ./apps
COPY tsconfig.json ./

# Copy .env file for environment variables
COPY .env ./

EXPOSE 3001

# Run the realtime service with tsx
CMD ["pnpm", "--filter", "realtime", "start"]
