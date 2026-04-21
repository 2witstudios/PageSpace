import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Service Architecture",
  description: "How PageSpace's web, realtime, processor, cron, and migration services cooperate over a single PostgreSQL database, with opaque-token service auth and no Redis.",
  path: "/docs/self-hosting/architecture",
  keywords: ["architecture", "services", "Socket.IO", "opaque tokens", "PostgreSQL"],
});

const content = `
# Service Architecture

PageSpace runs as a set of cooperating Node services against a single PostgreSQL database. There is no Redis, no external message broker, and no shared-secret service auth.

## Service graph

\`\`\`
              ┌──────────────┐
              │    Client    │
              └──────┬───────┘
                     │ HTTPS + WebSocket
              ┌──────▼───────┐
              │     Caddy    │  (or nginx / Traefik)
              └──┬──────┬────┘
                 │      │
        frontend │      │ frontend
                 │      │
        ┌────────▼──┐ ┌─▼────────┐     ┌──────────────┐
        │    web    │ │ realtime │     │  marketing   │
        │   :3000   │ │   :3001  │     │    :3004     │
        └──┬─────┬──┘ └────┬─────┘     └──────────────┘
           │     │         │
  internal │     │ internal│ internal
           │     │         │
      ┌────▼──┐  │  ┌──────▼──────┐
      │ cron  │  │  │  processor  │
      │       │  │  │    :3003    │
      └────┬──┘  │  └──────┬──────┘
           │     │         │
           └──┬──┴─────┬───┘
              │        │
          ┌───▼────────▼────┐
          │   postgres:5432 │
          │   (internal)    │
          └─────────────────┘

  One-shot init containers:
  • migrate                → runs Drizzle migrations, exits
  • processor-permissions  → chowns /data/files and /data/cache, exits
\`\`\`

Networks mirror the reference deploy: \`postgres\`, \`processor\`, \`cron\` live on an internal-only bridge with no egress. \`web\`, \`realtime\`, and \`marketing\` join both \`internal\` and \`frontend\`, so only those three are reachable from the reverse proxy.

## Web service (:3000)

The Next.js 15 app. Hosts the UI, all \`/api/*\` routes, and AI streaming via the Vercel AI SDK. Authenticates requests from cookies (passkey + magic-link sessions) or bearer tokens (MCP, service).

Boot dependencies: \`migrate\` must complete, \`processor\` must be healthy. Reads \`PROCESSOR_URL\` to reach the processor and \`INTERNAL_REALTIME_URL\` to push broadcast events to the realtime service.

## Realtime service (:3001)

A Socket.IO server for collaborative editing, presence, and broadcast fan-out. Single-process design: no Redis adapter, no external broker. If you need to scale realtime horizontally, shard by drive at the load balancer and run independent instances — do not expect cross-instance broadcast.

**Client auth.** Browsers can't send cross-origin cookies with \`sameSite: 'strict'\`, so clients call \`GET /api/auth/socket-token\` on the web service (same origin, cookies sent) to mint a \`ps_sock_*\` token with a 5-minute TTL. The realtime service validates it against the \`socket_tokens\` table and opens the connection. The token is single-use per session; the client refreshes before expiry. Source: \`apps/web/src/app/api/auth/socket-token/route.ts\`, \`apps/realtime/src/index.ts:25-55\`.

**Web → realtime broadcasts.** The web service signs internal broadcast calls with \`REALTIME_BROADCAST_SECRET\`. The realtime service accepts those and fans out page-updated, message-sent, and permission-changed events to the appropriate rooms.

## Processor service (:3003)

Handles uploads, image optimization, text extraction, and content-addressed storage. Only reachable from other containers on the \`internal\` network — clients never hit it directly.

**Storage.** Files live on the \`file_storage\` volume, mounted at \`/data/files\` inside the processor (set via \`FILE_STORAGE_PATH\`). Files are named by SHA-256 hash, so identical uploads deduplicate automatically. Per-file cap: \`STORAGE_MAX_FILE_SIZE_MB\` (default 20).

**Authentication.** The processor validates every incoming bearer token against the \`sessions\` table via \`sessionService.validateSession\` and rejects anything whose \`type\` is not \`service\`. The web service mints short-lived \`ps_svc_*\` tokens scoped to the user and operation, and attaches them as \`Authorization: Bearer ps_svc_*\`. There is no \`SERVICE_SECRET\` shared key. Source: \`apps/processor/src/middleware/auth.ts:35-110\`.

In development only, \`PROCESSOR_AUTH_REQUIRED=false\` skips auth. The processor throws at startup if that flag is set in production.

## Cron service

A small container running scheduled background jobs (cleanup, retention, notification sweeps) against the web service's HTTP endpoints. Authenticates with \`CRON_SECRET\`. Not reachable from the internet; Caddy explicitly blocks \`/api/cron/*\` at the edge (see \`Caddyfile\`).

## Marketing service (:3004)

Next.js marketing + docs site. Optional — skip the container if you only need the app. Joins the \`frontend\` network so Caddy can route specific paths (\`/\`, \`/pricing\`, \`/blog\`, \`/docs\`, etc.) to it while sending everything else to \`web\`.

## Init containers

Both run once per stack boot and exit. Other services declare \`depends_on: service_completed_successfully\` so they wait.

- **\`migrate\`** — runs \`pnpm db:migrate\`, which applies Drizzle migrations from \`packages/db/drizzle/\`. Never edit SQL files by hand; always regenerate with \`pnpm db:generate\`.
- **\`processor-permissions\`** — runs as root, chowns \`/data/files\` and \`/data/cache\` on the shared volume to UID 1000 so the processor (which runs unprivileged under \`read_only: true\`) can write to them.

## Database

PostgreSQL 17 is the single source of truth. Some of the tables you're most likely to care about when operating the system:

| Table | Purpose |
|-------|---------|
| \`users\` | User accounts, token version, admin role version |
| \`sessions\` | Opaque session token hashes (all token types: sess, svc, mcp, dev) |
| \`socket_tokens\` | Short-lived Socket.IO auth tokens (5-min TTL) |
| \`verification_tokens\` | Magic-link and passkey verification tokens |
| \`revoked_service_tokens\` | Explicit service-token revocation list |
| \`drives\` | Workspaces |
| \`pages\` | All content (documents, folders, AI chats, etc.) |
| \`page_permissions\` | Direct user-to-page permissions |
| \`drive_members\` | Drive membership and roles |
| \`chat_messages\` | AI and channel messages |
| \`user_ai_settings\` | Encrypted per-user AI provider keys |
| \`mcp_tokens\` | MCP authentication tokens |
| \`rate_limit_buckets\` | Postgres-backed distributed rate limits |

The Postgres rate-limit implementation replaces what used to live in Redis (\`packages/lib/src/security/distributed-rate-limit.ts\`).

## Authentication model at a glance

- **User sessions** — opaque tokens (\`ps_sess_*\`), SHA-256 hashed in \`sessions\`. Delivered as httpOnly cookies.
- **Service-to-service** — opaque tokens (\`ps_svc_*\`), same table, \`type = 'service'\`, scoped to operations and resources.
- **MCP clients** — opaque tokens (\`ps_mcp_*\`).
- **Device tokens** — opaque tokens (\`ps_dev_*\`) for desktop/mobile.
- **Socket.IO** — \`ps_sock_*\` tokens with 5-minute TTL, stored separately in \`socket_tokens\` to work around same-site cookie restrictions on cross-origin WebSockets.

All five token families hash at rest and never leave the server in plaintext after issuance.

## Scaling

### Single host
The common deployment. All containers on one VM, Caddy in front. Memory budget in the reference compose totals roughly 3 GB across the services.

### Multiple web instances
Web is stateless and safe to scale horizontally behind a load balancer. Two things to keep in mind:
- Permission checks read from Postgres on every request. The workload is Postgres-bound; size the DB accordingly and enable connection pooling (e.g. PgBouncer) before the app.
- AI streaming responses use chunked transfer. Either configure sticky sessions or make sure your load balancer doesn't buffer responses.

### Realtime
Single-process by design. To scale further, shard drives across independent realtime instances at the load balancer — the architecture does not currently support cross-instance broadcast fan-out.

### Processor
Stateless; horizontally scalable as long as every instance mounts the same \`file_storage\` volume (NFS, EFS, or similar).

### Postgres
For large installations: connection pooling (PgBouncer), read replicas for read-heavy workloads, and \`pg_stat_statements\` to watch slow queries. All application data is here — plan backups accordingly.
`;

export default function ArchitecturePage() {
  return <DocsMarkdown content={content} />;
}
