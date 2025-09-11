# Install dependencies only when needed  
FROM node:22.17.0-alpine AS deps
WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Copy only package files for dependency installation
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/lib/package.json ./packages/lib/
COPY apps/web/package.json ./apps/web/
COPY apps/realtime/package.json ./apps/realtime/

# Install ALL dependencies for the entire monorepo
RUN pnpm install --frozen-lockfile

# Now copy source code AFTER dependencies are installed
COPY packages ./packages
COPY apps ./apps
COPY tsconfig.json ./

# Rebuild the source code only when needed
FROM node:22.17.0-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

# Copy the installed dependencies and the entire source code
COPY --from=deps /app .

# Accept build arguments for Next.js environment variables
ARG NEXT_PUBLIC_REALTIME_URL
ENV NEXT_PUBLIC_REALTIME_URL=$NEXT_PUBLIC_REALTIME_URL

# Next.js collects telemetry data by default.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry.
# ENV NEXT_TELEMETRY_DISABLED 1

# We are installing devDependencies via the --prod=false flag, so this is not needed
# ENV NODE_ENV=development

# Build with development env to ensure Tailwind v4 processes correctly
RUN cd apps/web && NODE_OPTIONS="--max-old-space-size=1024" pnpm build

# Reset NODE_ENV for production runtime
ENV NODE_ENV=production

# Production image, copy all the files and run next
FROM node:22.17.0-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Uncomment the following line in case you want to disable telemetry.
# ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Create storage directory with proper permissions
RUN mkdir -p /app/storage && chown -R nextjs:nodejs /app/storage

# Copy the standalone output
COPY --from=builder /app/apps/web/.next/standalone .
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000

ENV PORT=3000

# Start the server
CMD ["node", "apps/web/server.js"]