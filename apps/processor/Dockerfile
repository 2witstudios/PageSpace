# syntax=docker/dockerfile:1.6
FROM node:22.17.0-bookworm-slim AS base

# Build-time tools needed by node-gyp / node-pre-gyp for any native addon
# that has to fall back to compiling from source (notably @tensorflow/tfjs-node
# when no prebuilt is available for the target arch). Sharp and tesseract.js
# ship self-contained glibc prebuilds and need no runtime libs on Debian.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      python3 \
      make \
      g++ \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Enable corepack and pin pnpm (with basic retry for transient network issues)
RUN corepack enable && (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

# Copy only manifests for dependency install caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/lib/package.json ./packages/lib/
COPY apps/processor/package.json ./apps/processor/

# Install dependencies
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile --prod=false

# Now copy source code AFTER dependencies are installed
COPY tsconfig.json ./
COPY types ./types
COPY packages ./packages
COPY apps/processor ./apps/processor

# Build shared workspaces before compiling the processor
RUN pnpm --filter @pagespace/db build \
  && pnpm --filter @pagespace/lib build

# Build the processor service
WORKDIR /app/apps/processor
RUN pnpm build

# Production stage
FROM node:22.17.0-bookworm-slim AS production

# Sharp 0.33+ and tesseract.js ship self-contained glibc prebuilds; no extra
# runtime libs are needed. ca-certificates is kept for outbound HTTPS from
# any worker that fetches over the network.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built application
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages ./packages
COPY --from=base /app/apps/processor ./apps/processor

# Create data directories with correct ownership (using UID 1000 for node user)
RUN mkdir -p /data/cache /data/files && \
    chown -R 1000:1000 /data

# Declare volumes AFTER setting ownership
# This ensures Docker preserves permissions when creating new volumes
VOLUME ["/data/files", "/data/cache"]

# The node:22.17.0-bookworm-slim base image already ships a `node` user
# with UID/GID 1000, matching the /data ownership set above.
USER node

# Set environment variables
ENV NODE_ENV=production \
    PORT=3003 \
    CACHE_PATH=/data/cache \
    FILE_STORAGE_PATH=/data/files

# Expose port
EXPOSE 3003

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3003/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)})"

# Start the processor service
WORKDIR /app/apps/processor
CMD ["node", "dist/server.js"]
