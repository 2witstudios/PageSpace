import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Self-Hosting",
  description: "Deploy PageSpace on your own infrastructure with Docker Compose. Service graph, required configuration, and deployment modes.",
  path: "/docs/self-hosting",
  keywords: ["self-hosting", "deployment", "Docker", "on-premise", "infrastructure", "DEPLOYMENT_MODE"],
});

const content = `
# Self-Hosting

PageSpace self-hosts on Docker Compose against a PostgreSQL database. There is no Redis dependency — rate limits, session revocation, permission checks, and handoff tokens all run through Postgres.

The reference production deployment pulls prebuilt images from GitHub Container Registry (\`ghcr.io/<org>/pagespace-*\`) and fronts them with Caddy. The compose file and Caddyfile live in a separate deploy repo.

## Deployment mode

Every self-hosted install picks one mode via the \`DEPLOYMENT_MODE\` env var:

| Mode | What it turns on | What it turns off |
|------|------------------|-------------------|
| \`cloud\` (default) | Stripe billing, OAuth (Google + Apple), self-registration | — |
| \`onprem\` | Admin-managed accounts, local AI providers (Ollama, Azure OpenAI) | Stripe, OAuth, self-registration |
| \`tenant\` | Business-tier features for every user; billing handled by an external control plane | Stripe checkout, cloud-only routes |

If you self-host for a company or clinic, you almost certainly want \`DEPLOYMENT_MODE=onprem\`. Source: \`packages/lib/src/deployment-mode.ts\`.

## Services

A production deployment runs seven containers plus one one-shot init:

| Container | Port | Role |
|-----------|------|------|
| \`postgres\` | — (internal) | PostgreSQL 17 — single source of truth |
| \`migrate\` | — | One-shot Drizzle migration runner; other services \`depends_on: service_completed_successfully\` |
| \`processor-permissions\` | — | One-shot volume chown for \`/data/files\` and \`/data/cache\` |
| \`web\` | 3000 | Next.js 15 app — API, UI, AI streaming, auth |
| \`realtime\` | 3001 | Socket.IO server — live editing, presence, broadcasts |
| \`processor\` | 3003 (internal) | Uploads, image optimization, text extraction |
| \`cron\` | — | Scheduled background jobs; authenticates to \`web\` with \`CRON_SECRET\` |
| \`marketing\` | 3004 | Marketing + docs site (optional — skip if you only need the app) |

All containers share a single Postgres instance. Web uses \`INTERNAL_REALTIME_URL\` to reach realtime over the internal network and \`PROCESSOR_URL\` to reach the processor. Clients hit \`NEXT_PUBLIC_REALTIME_URL\` through the reverse proxy.

## Required configuration

Web refuses to boot if either of these is missing or under 32 characters (\`packages/lib/src/config/env-validation.ts\`):

\`\`\`bash
DATABASE_URL=postgresql://user:password@postgres:5432/pagespace
CSRF_SECRET=<32+ chars, openssl rand -hex 32>
ENCRYPTION_KEY=<32+ chars, openssl rand -hex 32>
\`\`\`

Most deployments also need:

\`\`\`bash
DEPLOYMENT_MODE=onprem
REALTIME_BROADCAST_SECRET=<32+ chars>   # authenticates web → realtime broadcasts
CRON_SECRET=<random>                     # authenticates the cron container
WEB_APP_URL=https://pagespace.example.com
NEXT_PUBLIC_APP_URL=https://pagespace.example.com
NEXT_PUBLIC_REALTIME_URL=https://pagespace.example.com
INTERNAL_REALTIME_URL=http://realtime:3001
FILE_STORAGE_PATH=/app/storage
\`\`\`

Generate every secret with \`openssl rand -hex 32\`. Never reuse secrets across environments. The full reference lives in the [Environment Variables](/docs/self-hosting/environment) page.

## Service-to-service authentication

Web, realtime, and processor authenticate each other with short-lived opaque tokens prefixed \`ps_svc_*\`, not a shared \`SERVICE_SECRET\`. The processor's middleware validates every bearer token against the \`sessions\` table via \`sessionService.validateSession\` and rejects anything that isn't a \`service\`-type token (\`apps/processor/src/middleware/auth.ts\`).

There is no shared-secret mode for service auth. Do not set \`SERVICE_SECRET\` — nothing reads it.

## Quick start

\`\`\`bash
# Clone the deploy repo
git clone https://github.com/<org>/pagespace-deploy.git
cd pagespace-deploy

# Copy and edit the env template
cp .env.example .env
# At minimum set DATABASE_URL, CSRF_SECRET, ENCRYPTION_KEY, DEPLOYMENT_MODE

# Authenticate Docker to GHCR (read-only PAT with packages:read scope)
echo "$REGISTRY_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin

# Start the stack; migrations run automatically via the migrate container
docker compose -f docker-compose.prod.yml up -d
\`\`\`

With the Caddy example in [Docker Setup](/docs/self-hosting/docker), PageSpace will be reachable at your configured domain.

## Section overview

### [Docker Setup](/docs/self-hosting/docker)

Production compose with GHCR images, the \`migrate\` and \`processor-permissions\` init containers, internal/frontend network split, and a Caddy config matching pagespace.ai.

### [Environment Variables](/docs/self-hosting/environment)

Every variable the stack reads, cross-referenced against \`packages/lib/src/config/env-validation.ts\` and \`.env.example\`.

### [Architecture](/docs/self-hosting/architecture)

How each service is authenticated, which tables it reads, and how realtime broadcasting, processor auth, and socket tokens fit together.
`;

export default function SelfHostingPage() {
  return <DocsMarkdown content={content} />;
}
