import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Environment Variables",
  description: "Every environment variable PageSpace reads: required secrets, deployment mode, service URLs, storage limits, AI providers, email, Stripe, and monitoring.",
  path: "/docs/self-hosting/environment",
  keywords: ["environment variables", "configuration", "secrets", "CSRF_SECRET", "ENCRYPTION_KEY", "DEPLOYMENT_MODE"],
});

const content = `
# Environment Variables

Every variable below is read by at least one service in the stack. Sources cited inline. Authoritative files: \`packages/lib/src/config/env-validation.ts\` (web), \`.env.example\` (dev template), and the deploy repo's \`docker-compose.prod.yml\`.

PageSpace runs entirely on Postgres — no Redis, no external cache. Rate limits, session revocation, handoff tokens, and permissions all live in the same database.

## Deployment mode

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| \`DEPLOYMENT_MODE\` | No | \`cloud\` | \`cloud\` · \`onprem\` · \`tenant\`. Controls which routes and features are active. |
| \`NEXT_PUBLIC_DEPLOYMENT_MODE\` | No | \`cloud\` | Client-visible mirror; set to the same value. |

Source: \`packages/lib/src/deployment-mode.ts\`. \`onprem\` disables Stripe, OAuth, and self-registration. \`tenant\` expects an external control plane for billing.

## Required secrets

Web refuses to boot if either of these is missing or under 32 characters in non-test environments (\`packages/lib/src/config/env-validation.ts:67-82\`):

| Variable | Required | Description |
|----------|----------|-------------|
| \`DATABASE_URL\` | Yes | PostgreSQL connection string (must start with \`postgresql://\` or \`postgres://\`). |
| \`CSRF_SECRET\` | Yes | CSRF token signing key. Min 32 chars. |
| \`ENCRYPTION_KEY\` | Yes | AES key for encrypting per-user AI provider keys at rest. Min 32 chars. |

Generate each with \`openssl rand -hex 32\`. Never reuse across environments.

\`\`\`bash
DATABASE_URL=postgresql://user:password@postgres:5432/pagespace
CSRF_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
\`\`\`

There is no \`JWT_SECRET\`, \`SESSION_SECRET\`, or \`SERVICE_SECRET\`. Sessions use opaque tokens hashed in the \`sessions\` table; service-to-service auth uses short-lived \`ps_svc_*\` tokens, not a shared secret.

## Application URLs

| Variable | Required | Description |
|----------|----------|-------------|
| \`WEB_APP_URL\` | Yes (prod) | Canonical origin for the web service. Used for CSRF origin validation. |
| \`NEXT_PUBLIC_APP_URL\` | Yes | Public URL users see in links and OAuth redirects. |
| \`NEXT_PUBLIC_REALTIME_URL\` | Yes | Public WebSocket URL (same origin as the app if Caddy proxies \`/socket.io/*\`). |
| \`INTERNAL_REALTIME_URL\` | No | Web → realtime URL inside the Docker network (e.g. \`http://realtime:3001\`). Falls back to the public URL if unset. |
| \`PROCESSOR_URL\` | Yes | Web → processor URL inside the Docker network (e.g. \`http://processor:3003\`). |
| \`CORS_ORIGIN\` | Yes | Allowed origin on the realtime service (normally equals \`WEB_APP_URL\`). |
| \`ADDITIONAL_ALLOWED_ORIGINS\` | No | Comma-separated extra origins for multi-domain deployments. |
| \`ORIGIN_VALIDATION_MODE\` | No | \`block\` (default) or \`warn\` for CSRF origin checks. Use \`warn\` only for debugging. |

Source: \`.env.example:16-48\`, \`packages/lib/src/notifications/notifications.ts:14\`.

## Cookies

| Variable | Required | Description |
|----------|----------|-------------|
| \`COOKIE_DOMAIN\` | No | Domain for server-side auth cookies. Set to \`.example.com\` for cross-subdomain SSO. |
| \`NEXT_PUBLIC_COOKIE_DOMAIN\` | No | Same value for client-side theme-sync cookies. |

## Service-to-service and broadcast auth

| Variable | Required | Description |
|----------|----------|-------------|
| \`REALTIME_BROADCAST_SECRET\` | Yes (realtime broadcasts) | Min 32 chars. Web uses this to authenticate broadcast writes to the realtime service. |
| \`CRON_SECRET\` | Yes (cron container) | Random string; the cron container uses it to authenticate to web endpoints. |
| \`INTERNAL_API_SECRET\` | No | Used by marketing → web internal calls. |

Source: \`packages/lib/src/config/env-validation.ts:60-62\`, \`.env.example:126-134\`.

## File storage

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| \`FILE_STORAGE_PATH\` | Yes | — | Directory on the shared volume. Web: \`/app/storage\`. Processor: \`/data/files\`. |
| \`CACHE_PATH\` | No (processor) | \`/data/cache\` | Scratch directory for image/PDF processing. |
| \`STORAGE_MAX_FILE_SIZE_MB\` | No | \`20\` | Per-file upload cap, in MB. |
| \`NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB\` | No | \`20\` | Client-visible mirror; set to the same value. |
| \`STORAGE_DEFAULT_QUOTA_MB\` | No | \`500\` | Per-user quota default. |
| \`STORAGE_MAX_CONCURRENT_UPLOADS\` | No | \`5\` | Parallel upload cap. |
| \`STORAGE_MIN_FREE_MEMORY_MB\` | No | \`500\` | Refuse uploads below this free-memory threshold. |
| \`STORAGE_ENABLE_QUOTAS\` | No | \`true\` | Toggle quota enforcement. |

Source: \`.env.example:22-31\`, \`apps/processor/src/api/upload.ts:89\`. There is no \`UPLOAD_DIR\` or \`MAX_FILE_SIZE\` — nothing reads those names.

## Processor configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| \`PROCESSOR_AUTH_REQUIRED\` | No | \`true\` | Set to \`false\` in development only to skip bearer-token auth. Throws at startup if set in production. |
| \`PROCESSOR_UPLOAD_RATE_LIMIT\` | No | \`100\` | Per-window upload count cap. |
| \`PROCESSOR_UPLOAD_RATE_WINDOW\` | No | \`3600\` | Window length in seconds. |
| \`ENABLE_OCR\` | No | \`false\` | Enable local OCR (Tesseract). |
| \`ENABLE_EXTERNAL_OCR\` | No | \`false\` | Enable Gemini-backed OCR. Requires \`GOOGLE_AI_DEFAULT_API_KEY\`. |

Source: \`.env.example:4-7\`, \`apps/processor/src/middleware/auth.ts:10-22\`.

## AI providers

End users configure their own keys in Settings > AI; values are encrypted at rest with \`ENCRYPTION_KEY\`. The variables below set optional defaults so new users land on a working provider.

| Variable | Required | Description |
|----------|----------|-------------|
| \`GOOGLE_AI_DEFAULT_API_KEY\` | No | Default Gemini key for the built-in PageSpace provider. |
| \`GLM_DEFAULT_API_KEY\` | No | Default GLM key. |
| \`OPENROUTER_DEFAULT_API_KEY\` | No | Default OpenRouter key (legacy; prefer \`GOOGLE_AI_DEFAULT_API_KEY\`). |
| \`BRAVE_API_KEY\` | No | Enables the web-search tool. |

Source: \`packages/lib/src/config/env-validation.ts:44-45\`, \`.env.example:50-62\`.

## OAuth and magic links

OAuth is disabled automatically when \`DEPLOYMENT_MODE=onprem\`. Cloud deployments need:

| Variable | Required | Description |
|----------|----------|-------------|
| \`GOOGLE_OAUTH_CLIENT_ID\` | No | Web OAuth client ID. |
| \`GOOGLE_OAUTH_CLIENT_SECRET\` | No | Web OAuth client secret. |
| \`GOOGLE_OAUTH_REDIRECT_URI\` | No | e.g. \`https://pagespace.example.com/api/auth/google/callback\`. |
| \`NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID\` | No | Client-side mirror for One Tap. Must match the server value. |
| \`GOOGLE_OAUTH_IOS_CLIENT_ID\` / \`NEXT_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID\` | No | Native iOS Google Sign-In client IDs. |
| \`APPLE_SERVICE_ID\` | No | Apple Sign-In service ID. |
| \`OAUTH_STATE_SECRET\` | Yes (any OAuth) | Min 32 chars. Signs OAuth state parameters. Required for integration OAuth flows (GitHub, etc.). |

## Email (Resend)

PageSpace sends magic links and notifications via [Resend](https://resend.com). There is no SMTP client; do not set \`SMTP_HOST\` etc.

| Variable | Required | Description |
|----------|----------|-------------|
| \`RESEND_API_KEY\` | Yes (for email) | Resend API key (\`re_*\`). |
| \`FROM_EMAIL\` | Yes (for email) | Sender, e.g. \`PageSpace <noreply@example.com>\`. |
| \`CONTACT_EMAIL\` | No | Where contact-form submissions go. |

Source: \`.env.example:86-89\`, deploy compose \`marketing\` service.

## Stripe (cloud mode only)

Ignored when \`DEPLOYMENT_MODE\` is \`onprem\` or \`tenant\`.

| Variable | Required | Description |
|----------|----------|-------------|
| \`STRIPE_SECRET_KEY\` | Yes (cloud) | \`sk_*\`. |
| \`STRIPE_WEBHOOK_SECRET\` | Yes (cloud) | \`whsec_*\`. |
| \`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY\` | Yes (cloud) | \`pk_*\`. |
| \`NEXT_PUBLIC_STRIPE_PRICE_ID_PRO\` / \`_FOUNDER\` / \`_BUSINESS\` | Yes (cloud) | Stripe price IDs for checkout. |

## Monitoring and logging

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| \`LOG_LEVEL\` | No | \`info\` | \`debug\` · \`info\` · \`warn\` · \`error\`. Use \`warn\` in prod. |
| \`LOG_DESTINATION\` | No | \`both\` | \`stdout\` · \`db\` · \`both\`. |
| \`LOG_BATCH_SIZE\` | No | \`50\` | Batch size for async log flushes. |
| \`LOG_FLUSH_INTERVAL\` | No | \`5000\` | Flush interval in ms. |
| \`MONITORING_INGEST_KEY\` | Recommended | — | Authenticates the internal monitoring ingest endpoint. Without it, API metrics silently drop and \`/api/health\` reports degraded. |
| \`MONITORING_INGEST_PATH\` | No | \`/api/internal/monitoring/ingest\` | Override for the ingest path. |
| \`MONITORING_INGEST_DISABLED\` | No | — | Set to \`true\` to silence missing-key warnings explicitly. |
| \`RETENTION_API_METRICS_DAYS\` / \`_SYSTEM_LOGS_DAYS\` / \`_ERROR_LOGS_DAYS\` / \`_USER_ACTIVITIES_DAYS\` | No | see defaults | Monitoring-table retention overrides. |

## Image registry

| Variable | Required | Description |
|----------|----------|-------------|
| \`REGISTRY_TOKEN\` | Yes (GHCR pulls) | GitHub PAT with \`packages:read\`. Used for \`docker login ghcr.io\`. |
| \`GITHUB_USERNAME\` | Yes (prod compose) | Owner segment of the GHCR image names. |

## Example \`.env\` (on-prem)

\`\`\`bash
# Deployment
DEPLOYMENT_MODE=onprem
NEXT_PUBLIC_DEPLOYMENT_MODE=onprem

# Database
DATABASE_URL=postgresql://pagespace:$(openssl rand -hex 16)@postgres:5432/pagespace

# Required secrets
CSRF_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
REALTIME_BROADCAST_SECRET=$(openssl rand -hex 32)
CRON_SECRET=$(openssl rand -hex 32)
OAUTH_STATE_SECRET=$(openssl rand -hex 32)

# URLs
WEB_APP_URL=https://pagespace.example.com
NEXT_PUBLIC_APP_URL=https://pagespace.example.com
NEXT_PUBLIC_REALTIME_URL=https://pagespace.example.com
INTERNAL_REALTIME_URL=http://realtime:3001
PROCESSOR_URL=http://processor:3003
CORS_ORIGIN=https://pagespace.example.com
COOKIE_DOMAIN=.example.com
NEXT_PUBLIC_COOKIE_DOMAIN=.example.com

# Storage
FILE_STORAGE_PATH=/app/storage
STORAGE_MAX_FILE_SIZE_MB=20
NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB=20

# Optional: default AI provider
GOOGLE_AI_DEFAULT_API_KEY=

# Logging
LOG_LEVEL=warn
MONITORING_INGEST_KEY=$(openssl rand -hex 32)
\`\`\`

## Generating secrets

\`\`\`bash
# Any 32+ char secret
openssl rand -hex 32

# Or with Node
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
\`\`\`
`;

export default function EnvironmentPage() {
  return <DocsMarkdown content={content} />;
}
