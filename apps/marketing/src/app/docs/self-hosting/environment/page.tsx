import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Environment Variables",
  description: "Complete reference for PageSpace environment variables: database, authentication, AI providers, file storage, and service configuration.",
  path: "/docs/self-hosting/environment",
  keywords: ["environment variables", "configuration", "secrets", "database", "AI providers"],
});

const content = `
# Environment Variables

Complete reference for all PageSpace configuration variables.

## Database

| Variable | Required | Description |
|----------|----------|-------------|
| \`DATABASE_URL\` | Yes | PostgreSQL connection string |

\`\`\`bash
DATABASE_URL=postgresql://user:password@localhost:5432/pagespace
\`\`\`

PageSpace runs entirely on Postgres — no Redis or other external cache is required. Rate limits, session revocation, and handoff tokens all live in the same database.

## Authentication

| Variable | Required | Description |
|----------|----------|-------------|
| \`SESSION_SECRET\` | Yes | Secret for session token signing (min 32 chars) |
| \`COOKIE_DOMAIN\` | No | Domain for server-side authentication cookies |
| \`NEXT_PUBLIC_COOKIE_DOMAIN\` | No | Domain for client-side cookies (theme sync) |
| \`GOOGLE_CLIENT_ID\` | No | Google OAuth client ID |
| \`GOOGLE_CLIENT_SECRET\` | No | Google OAuth client secret |

\`\`\`bash
SESSION_SECRET=your-random-secret-at-least-32-characters-long
COOKIE_DOMAIN=.example.com
NEXT_PUBLIC_COOKIE_DOMAIN=.example.com
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
\`\`\`

## Service URLs

| Variable | Required | Description |
|----------|----------|-------------|
| \`NEXT_PUBLIC_APP_URL\` | Yes | Public URL of the web app |
| \`REALTIME_URL\` | Yes | Internal URL of the realtime service |
| \`PROCESSOR_URL\` | Yes | Internal URL of the processor service |
| \`SERVICE_SECRET\` | Yes | Shared secret for service-to-service auth |

\`\`\`bash
NEXT_PUBLIC_APP_URL=https://pagespace.example.com
REALTIME_URL=http://realtime:3001
PROCESSOR_URL=http://processor:3003
SERVICE_SECRET=your-service-to-service-secret
\`\`\`

## AI Providers

AI provider keys are configured per-user in the web UI, not via environment variables. However, the default PageSpace provider uses:

| Variable | Required | Description |
|----------|----------|-------------|
| \`OPENROUTER_DEFAULT_API_KEY\` | No | OpenRouter API key for the built-in PageSpace provider |
| \`ENCRYPTION_KEY\` | Yes | Key for encrypting user AI API keys at rest |

\`\`\`bash
OPENROUTER_DEFAULT_API_KEY=sk-or-v1-your-openrouter-key
ENCRYPTION_KEY=your-32-byte-encryption-key
\`\`\`

Users configure their own API keys via Settings > AI. These are encrypted with \`ENCRYPTION_KEY\` before storage.

## File Storage

| Variable | Required | Description |
|----------|----------|-------------|
| \`UPLOAD_DIR\` | Yes | Directory for uploaded files (processor service) |
| \`MAX_FILE_SIZE\` | No | Maximum upload size in bytes (default: 104857600 / 100 MB) |

\`\`\`bash
UPLOAD_DIR=/data/uploads
MAX_FILE_SIZE=104857600
\`\`\`

## Email

| Variable | Required | Description |
|----------|----------|-------------|
| \`SMTP_HOST\` | No | SMTP server hostname |
| \`SMTP_PORT\` | No | SMTP server port |
| \`SMTP_USER\` | No | SMTP authentication user |
| \`SMTP_PASSWORD\` | No | SMTP authentication password |
| \`EMAIL_FROM\` | No | Sender email address |

Email is used for invitations and notifications. If not configured, email features are disabled.

## Monitoring

| Variable | Required | Description |
|----------|----------|-------------|
| \`LOG_LEVEL\` | No | Logging level: \`debug\`, \`info\`, \`warn\`, \`error\` (default: \`info\`) |

## Example .env

\`\`\`bash
# Database
DATABASE_URL=postgresql://pagespace:secret@localhost:5432/pagespace

# Auth
SESSION_SECRET=generate-a-random-string-at-least-32-characters
ENCRYPTION_KEY=generate-another-random-32-byte-key

# Service URLs
NEXT_PUBLIC_APP_URL=https://pagespace.example.com
REALTIME_URL=http://localhost:3001
PROCESSOR_URL=http://localhost:3003
SERVICE_SECRET=generate-a-service-secret

# File storage
UPLOAD_DIR=./uploads

# Optional: Google OAuth
GOOGLE_CLIENT_ID=your-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-secret

# Optional: Default AI provider
OPENROUTER_DEFAULT_API_KEY=sk-or-v1-your-key
\`\`\`

## Generating Secrets

Use a cryptographically secure random generator:

\`\`\`bash
# Generate a 32-byte random secret
openssl rand -base64 32

# Or using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
\`\`\`

Never reuse secrets across environments. Each deployment should have unique values for \`SESSION_SECRET\`, \`ENCRYPTION_KEY\`, and \`SERVICE_SECRET\`.
`;

export default function EnvironmentPage() {
  return <DocsMarkdown content={content} />;
}
