import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Docker Setup",
  description: "Production Docker Compose for PageSpace using GHCR images, a migrate init container, internal/frontend network split, and a Caddy reverse proxy.",
  path: "/docs/self-hosting/docker",
  keywords: ["Docker", "Docker Compose", "GHCR", "Caddy", "PostgreSQL", "self-hosting"],
});

const content = `
# Docker Setup

The reference production deployment pulls prebuilt images from GitHub Container Registry and runs them behind Caddy. This page mirrors the compose file and Caddyfile used for pagespace.ai.

## Images

All service images are published to GHCR:

- \`ghcr.io/<org>/pagespace-migrate\`
- \`ghcr.io/<org>/pagespace-web\`
- \`ghcr.io/<org>/pagespace-realtime\`
- \`ghcr.io/<org>/pagespace-processor\`
- \`ghcr.io/<org>/pagespace-cron\`
- \`ghcr.io/<org>/pagespace-marketing\`

Authenticate Docker to GHCR with a read-only GitHub PAT (\`packages:read\` scope):

\`\`\`bash
echo "$REGISTRY_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
\`\`\`

## docker-compose.prod.yml

The shape below matches the deploy repo. Every service loads shared secrets from \`.env\` via \`env_file\`. Postgres and the processor are kept on an internal-only network; only \`web\`, \`realtime\`, and \`marketing\` join the \`frontend\` network that Caddy reaches.

\`\`\`yaml
services:
  postgres:
    image: postgres:17.5-alpine
    restart: unless-stopped
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: \${POSTGRES_DB:-pagespace}
      POSTGRES_USER: \${POSTGRES_USER:-user}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-user} -d \${POSTGRES_DB:-pagespace}"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks: [internal]

  migrate:
    image: ghcr.io/\${GITHUB_USERNAME}/pagespace-migrate:latest
    depends_on:
      postgres:
        condition: service_healthy
    env_file: .env
    environment:
      DATABASE_URL: postgresql://\${POSTGRES_USER:-user}:\${POSTGRES_PASSWORD}@postgres:5432/\${POSTGRES_DB:-pagespace}
    command: sh -c "pnpm run db:migrate"
    networks: [internal]

  # One-shot: fixes ownership on persistent volumes so the processor can write as UID 1000.
  processor-permissions:
    image: ghcr.io/\${GITHUB_USERNAME}/pagespace-processor:latest
    user: root
    volumes:
      - file_storage:/data/files
      - cache_storage:/data/cache
    command: sh -c 'chown -R 1000:1000 /data/files /data/cache'
    restart: "no"
    networks: [internal]

  processor:
    image: ghcr.io/\${GITHUB_USERNAME}/pagespace-processor:latest
    restart: unless-stopped
    expose: ["3003"]
    depends_on:
      migrate: { condition: service_completed_successfully }
      postgres: { condition: service_healthy }
      processor-permissions: { condition: service_completed_successfully }
    volumes:
      - file_storage:/data/files
      - cache_storage:/data/cache
    env_file: .env
    environment:
      DATABASE_URL: postgresql://\${POSTGRES_USER:-user}:\${POSTGRES_PASSWORD}@postgres:5432/\${POSTGRES_DB:-pagespace}
      FILE_STORAGE_PATH: /data/files
      CACHE_PATH: /data/cache
      PORT: 3003
      STORAGE_MAX_FILE_SIZE_MB: \${STORAGE_MAX_FILE_SIZE_MB:-20}
      PROCESSOR_AUTH_REQUIRED: "true"
    user: "1000:1000"
    read_only: true
    tmpfs: ["/tmp:noexec,nosuid,size=100m"]
    security_opt: ["no-new-privileges:true"]
    networks: [internal]

  web:
    image: ghcr.io/\${GITHUB_USERNAME}/pagespace-web:latest
    restart: unless-stopped
    ports: ["\${PORT:-3000}:3000"]
    depends_on:
      migrate: { condition: service_completed_successfully }
      processor: { condition: service_healthy }
    volumes:
      - file_storage:/app/storage
    env_file: .env
    environment:
      DATABASE_URL: postgresql://\${POSTGRES_USER:-user}:\${POSTGRES_PASSWORD}@postgres:5432/\${POSTGRES_DB:-pagespace}
      NEXT_PUBLIC_APP_URL: \${NEXT_PUBLIC_APP_URL}
      NEXT_PUBLIC_REALTIME_URL: \${NEXT_PUBLIC_REALTIME_URL}
      INTERNAL_REALTIME_URL: http://realtime:3001
      PROCESSOR_URL: http://processor:3003
      FILE_STORAGE_PATH: /app/storage
      CRON_SECRET: \${CRON_SECRET}
    networks: [internal, frontend]

  realtime:
    image: ghcr.io/\${GITHUB_USERNAME}/pagespace-realtime:latest
    restart: unless-stopped
    ports: ["\${REALTIME_PORT:-3001}:3001"]
    depends_on:
      migrate: { condition: service_completed_successfully }
    env_file: .env
    environment:
      DATABASE_URL: postgresql://\${POSTGRES_USER:-user}:\${POSTGRES_PASSWORD}@postgres:5432/\${POSTGRES_DB:-pagespace}
      PORT: 3001
      CORS_ORIGIN: \${WEB_APP_URL}
    networks: [internal, frontend]

  cron:
    image: ghcr.io/\${GITHUB_USERNAME}/pagespace-cron:latest
    restart: unless-stopped
    depends_on:
      web: { condition: service_started }
    environment:
      CRON_SECRET: \${CRON_SECRET}
    networks: [internal]

networks:
  internal: { driver: bridge, internal: true }
  frontend: { driver: bridge }

volumes:
  postgres_data:
  file_storage:
  cache_storage:
\`\`\`

Notes:
- **Postgres has no host port.** The \`internal\` network flag (\`internal: true\`) blocks egress too, so Postgres only talks to containers on the same network. Exposing 5432 to the host is a production footgun.
- **Migrations run in their own container.** Web, realtime, and processor wait on \`migrate\` with \`service_completed_successfully\`. Do not run \`pnpm db:migrate\` inside the web container.
- **\`processor-permissions\` runs once as root** to chown the persistent volumes before the processor starts as UID 1000 under \`read_only: true\`.

## Running

\`\`\`bash
# Start the stack; migrate runs to completion, then web/realtime/processor boot.
docker compose -f docker-compose.prod.yml up -d

# Logs
docker compose -f docker-compose.prod.yml logs -f web

# Stop
docker compose -f docker-compose.prod.yml down
\`\`\`

## Updating

\`\`\`bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
\`\`\`

Pulling a new \`migrate\` image triggers schema migrations automatically on the next \`up -d\`. Drizzle handles schema changes; never edit SQL files in \`packages/db/drizzle/\` by hand.

## Health checks

| Service | Endpoint | Expected |
|---------|----------|----------|
| Web | \`GET /api/health\` | 200 OK (JSON) |
| Processor | \`GET /health\` | 200 OK (JSON) |
| Realtime | Socket.IO handshake | successful connect |

Source: \`apps/web/src/app/api/health/route.ts\`, \`apps/processor/src/server.ts:143\`.

## Reverse proxy (Caddy)

The production deployment uses Caddy with path-specific routing: marketing pages and SEO assets go to \`marketing:3004\`, \`/socket.io/*\` goes to \`realtime:3001\`, everything else goes to \`web:3000\`. Caddy also strips the \`Cross-Origin-Embedder-Policy\` header on Stripe and auth paths so \`js.stripe.com\` resources aren't blocked.

\`\`\`caddy
pagespace.example.com {
    # Marketing pages and static assets (optional — only if you run the marketing container)
    @marketing {
        path / /pricing /pricing/* /blog /blog/* /docs /docs/*
        path /faq /privacy /terms /security /contact
    }
    handle @marketing {
        reverse_proxy marketing:3004
    }

    # WebSocket upgrade for realtime
    @websockets {
        header Connection *Upgrade*
        header Upgrade websocket
        path /socket.io/*
    }
    handle @websockets {
        reverse_proxy realtime:3001
    }
    handle /socket.io/* {
        reverse_proxy realtime:3001
    }

    # App + API
    handle {
        reverse_proxy web:3000
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        Cross-Origin-Embedder-Policy "require-corp"
        Cross-Origin-Opener-Policy "same-origin"
        Cross-Origin-Resource-Policy "same-origin"
    }

    # Stripe + auth routes embed js.stripe.com; strip COEP/COOP/CORP there.
    @stripe_paths {
        path /settings/plan /settings/plan/* /settings/billing /settings/billing/*
        path /auth /auth/*
    }
    header @stripe_paths {
        -Cross-Origin-Embedder-Policy
        -Cross-Origin-Opener-Policy
        -Cross-Origin-Resource-Policy
    }

    encode gzip
}
\`\`\`

Nginx or Traefik work too, but match this path layout — \`/socket.io/*\` must reach realtime with WebSocket upgrade headers, and the Stripe/auth paths must not enforce COEP. If you embed Stripe in billing pages without this carve-out, the free-to-paid upgrade flow breaks with \`ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep\`.

## File uploads

The processor caps individual uploads at \`STORAGE_MAX_FILE_SIZE_MB\` (default **20 MB**, set in \`.env.example\`). Size your proxy's request-body limit to match or exceed that value — e.g. set \`STORAGE_MAX_FILE_SIZE_MB=100\` plus a matching proxy limit if you need larger files.

Files are stored on the \`file_storage\` volume. Web mounts it at \`/app/storage\`; processor mounts it at \`/data/files\`.

## Tenant mode

If you need \`DEPLOYMENT_MODE=tenant\` (managed multi-tenant), there is a separate compose under \`infrastructure/docker-compose.tenant.yml\` and a generated env template. Tenant mode expects a control plane to provision databases and handle billing; don't run it standalone.
`;

export default function DockerPage() {
  return <DocsMarkdown content={content} />;
}
