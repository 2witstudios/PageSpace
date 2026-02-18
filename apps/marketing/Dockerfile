# syntax=docker/dockerfile:1.6
# Install dependencies only when needed
FROM node:22.17.0-alpine AS deps
WORKDIR /app

# Enable corepack and pin pnpm
RUN corepack enable && (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

# Copy only package files for dependency installation
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/marketing/package.json ./apps/marketing/

# Install dependencies
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile --filter marketing...

# Copy source code after dependencies are installed
COPY apps/marketing ./apps/marketing
COPY tsconfig.json ./

# Build stage
FROM node:22.17.0-alpine AS builder
WORKDIR /app
RUN corepack enable && (corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate || corepack prepare pnpm@10.13.1 --activate)

COPY --from=deps /app .

# Accept build arguments for Next.js environment variables
ARG NEXT_PUBLIC_MARKETING_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_COOKIE_DOMAIN

ENV NEXT_PUBLIC_MARKETING_URL=$NEXT_PUBLIC_MARKETING_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_COOKIE_DOMAIN=$NEXT_PUBLIC_COOKIE_DOMAIN

RUN cd apps/marketing && pnpm build

ENV NODE_ENV=production

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

CMD ["node", "apps/marketing/server.js"]
