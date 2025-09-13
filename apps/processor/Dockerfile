FROM node:20-alpine AS base

# Install system dependencies for Sharp and Tesseract
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev \
    pangomm-dev \
    libjpeg-turbo-dev \
    freetype-dev

# Set working directory
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace configuration files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.json ./
COPY packages ./packages
COPY apps/processor/package.json ./apps/processor/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy processor source code
COPY apps/processor ./apps/processor

# Build the processor service
WORKDIR /app/apps/processor
RUN pnpm build

# Production stage
FROM node:20-alpine AS production

# Install runtime dependencies for Sharp
RUN apk add --no-cache \
    cairo \
    jpeg \
    pango \
    giflib \
    pixman \
    pangomm \
    libjpeg-turbo \
    freetype

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

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

# Switch to non-root user
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