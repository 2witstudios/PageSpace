import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Service Architecture",
  description: "PageSpace service architecture: web, realtime, and processor services. How they communicate, scale, and share data.",
  path: "/docs/self-hosting/architecture",
  keywords: ["architecture", "services", "microservices", "Socket.IO", "file processing"],
});

const content = `
# Service Architecture

PageSpace runs as three cooperating services sharing a PostgreSQL database.

## Service Overview

\`\`\`
                    ┌─────────────┐
                    │   Client    │
                    │  (Browser)  │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │   Web    │ │ Realtime │ │ Processor│
        │  :3000   │ │  :3001   │ │  :3003   │
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │            │            │
             └────────────┼────────────┘
                          │
                    ┌─────┴─────┐
                    │ PostgreSQL│
                    │  + Redis  │
                    └───────────┘
\`\`\`

## Web Service (Port 3000)

The main Next.js 15 application. Handles everything except real-time connections and file processing.

**Responsibilities:**
- All API routes (\`/api/*\`)
- Server-side rendering and static generation
- AI chat streaming (Vercel AI SDK)
- Authentication and session management
- Database migrations (Drizzle ORM)

**Stack:**
- Next.js 15 with App Router
- TypeScript
- Drizzle ORM for PostgreSQL
- Vercel AI SDK for multi-provider AI

## Realtime Service (Port 3001)

A dedicated Socket.IO server for real-time communication.

**Responsibilities:**
- WebSocket connections for live collaboration
- Document editing sync
- Chat message broadcasting
- Presence (who's online, who's typing)
- Page update notifications

**Authentication:**
- Clients authenticate with a short-lived socket token (\`ps_sock_*\`, 5-minute lifetime)
- Socket tokens are issued by the web service after validating the session
- The realtime service validates socket tokens via the database

**Communication with Web:**
- The web service sends events to the realtime service via internal HTTP
- Events include: page created, page updated, message sent, permission changed
- The realtime service broadcasts these to connected clients in the appropriate rooms

## Processor Service (Port 3003)

Handles file uploads, processing, and storage.

**Responsibilities:**
- File upload reception and validation
- Image optimization (resizing, format conversion)
- Text extraction from documents (PDF, DOCX, etc.)
- Content-addressed file storage (deduplication)
- File serving to authenticated clients

**Storage:**
- Files are stored on the local filesystem in \`UPLOAD_DIR\`
- File metadata is stored in PostgreSQL
- Content-addressed storage: files are named by their SHA-256 hash
- Identical files are stored only once (deduplication)

**Authentication:**
- The web service authenticates requests to the processor using \`SERVICE_SECRET\`
- Clients never access the processor directly — all file requests go through the web service

## Database

PostgreSQL is the single source of truth for all data.

**Key tables:**
- \`users\` — User accounts and authentication
- \`drives\` — Workspaces
- \`pages\` — All content (documents, folders, AI chats, etc.)
- \`chat_messages\` — AI and channel messages
- \`page_permissions\` — Direct user-to-page permissions
- \`drive_members\` — Drive membership and roles
- \`user_ai_settings\` — Encrypted AI provider keys
- \`mcp_tokens\` — MCP authentication tokens
- \`session_tokens\` — Opaque session token hashes

**Schema management:**
- Drizzle ORM for type-safe queries
- Migrations are auto-generated from schema changes: \`pnpm db:generate\`
- Applied via: \`pnpm db:migrate\`
- Never manually edit migration files

## Redis (Optional)

Used for permission caching. If Redis is unavailable, the system falls back to in-memory caching.

**Usage:**
- L2 permission cache (shared across web instances)
- Key format: \`pagespace:perms:{userId}:{pageId}\`
- TTL: 60 seconds

## Scaling Considerations

### Single Instance

The simplest deployment runs all three services on one machine. This is suitable for small teams (< 50 users).

### Horizontal Scaling

- **Web**: Can run multiple instances behind a load balancer. Requires Redis for shared permission cache and session affinity for AI streaming.
- **Realtime**: Can run multiple instances with Redis adapter for cross-instance message broadcasting.
- **Processor**: Can run multiple instances with shared \`UPLOAD_DIR\` (NFS or similar).

### Database

PostgreSQL handles the load for most deployments. For very large installations:
- Use connection pooling (PgBouncer)
- Add read replicas for read-heavy workloads
- Monitor slow queries with \`pg_stat_statements\`
`;

export default function ArchitecturePage() {
  return <DocsMarkdown content={content} />;
}
