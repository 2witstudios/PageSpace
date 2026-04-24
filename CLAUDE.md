# PageSpace

PageSpace is an AI-native knowledge management and collaboration platform. Humans and AI agents work together in shared workspaces using 33+ real tools — AI can create, edit, organize, and search content directly, not just answer questions. The platform supports 9 page types (Document, Code, Sheet, Canvas, Task List, Channel, AI Chat, File, Folder), 100+ AI models across multiple providers, and MCP protocol integration. Available as cloud SaaS (pagespace.ai), self-hosted, desktop (Electron), and mobile (Capacitor).

## Monorepo Structure

pnpm workspace + Turbo build system.

```
apps/
  web/              # Next.js 15 main app (frontend + API routes)
  realtime/         # Socket.IO real-time collaboration server
  processor/        # File processing (uploads, images, OCR, PDF extraction)
  control-plane/    # Fastify tenant provisioning, Stripe billing, lifecycle mgmt
  desktop/          # Electron wrapper (macOS, Windows, Linux)
  ios/              # Capacitor iOS wrapper
  android/          # Capacitor Android wrapper
  marketing/        # Marketing site (pagespace.ai landing pages)
  atlas/            # Internal architecture visualization (React Flow)

packages/
  db/               # Drizzle ORM schema + migrations (PostgreSQL)
  lib/              # Shared auth, permissions, services, integrations, utilities
```

## Tech Stack

- **Full-stack**: Next.js 15 App Router + TypeScript + Tailwind + shadcn/ui
- **Database**: PostgreSQL + Drizzle ORM
- **AI**: Vercel AI SDK + multi-provider (Anthropic, OpenAI, Google, xAI, OpenRouter, Ollama)
- **Auth**: Passwordless — passkeys (WebAuthn) + magic links. Opaque session tokens, SHA3-256 hashed at rest.
- **Real-time**: Socket.IO (single-process fanout; no external broker)
- **Editors**: TipTap (rich text), Monaco (code), custom sheet + canvas
- **State**: Zustand (client) + SWR (server cache)
- **Build**: pnpm + Turbo + Docker Compose
- **Deployment**: Docker images on GHCR (`ghcr.io/2witstudios/`), Caddy reverse proxy
- **Deploy repo**: Compose file, Caddyfile, deploy scripts at `/Users/jono/production/PageSpace-Deploy/`

## Deployment Modes

Three modes via `DEPLOYMENT_MODE` env var (see `packages/lib/src/deployment-mode.ts`):

- **`cloud`** (default) — SaaS at pagespace.ai. Stripe billing, OAuth, self-registration enabled.
- **`onprem`** — Self-hosted. Disables Stripe, OAuth, self-registration. Password auth, local AI, admin-managed accounts.
- **`tenant`** — Managed multi-tenant. Billing at the control plane. All users get business-tier features. Cloud-only routes blocked.

## Critical Rules

**Package manager**: Always use `pnpm`. Never `npm`. This is a pnpm workspace — everything breaks otherwise.

**Next.js 15 async params**: `params` in dynamic routes are Promises. You MUST await them:
```typescript
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
}
```
Destructuring params directly without await is a silent runtime bug.

**Database migrations**: Never manually create or edit SQL files in `packages/db/drizzle/`. Always use `pnpm db:generate` from schema changes in `packages/db/src/schema/`.

**No `any` types**: Always use proper TypeScript types.

**Message content**: Always use the `parts` array structure for message content. Read the message types in `packages/lib/src/types.ts` for the canonical shape.

**Permissions**: Always use the centralized permission functions from `packages/lib/src/permissions/`. Never roll your own access checks.

**UI refresh protection**: Any component that edits content or streams AI must register state with `useEditingStore` to prevent SWR from clobbering in-progress work. Read `apps/web/src/stores/useEditingStore.ts` for the API.

**Changelog**: When changes land, update the changelog and any user-visible notes.

## Key Source Locations

When you need to understand a subsystem, read these canonical sources (not docs that may be stale):

| Area | Path |
|------|------|
| Page types enum | `packages/lib/src/utils/enums.ts` |
| Permissions | `packages/lib/src/permissions/` |
| Auth (opaque tokens, sessions) | `packages/lib/src/auth/` |
| UI refresh protection | `apps/web/src/stores/useEditingStore.ts` |
| Integrations (GitHub, Calendar, OAuth) | `packages/lib/src/integrations/` |
| DB schema (all tables) | `packages/db/src/schema/` |
| Services (billing, search, calendar sync) | `packages/lib/src/services/` |
| Deployment mode detection | `packages/lib/src/deployment-mode.ts` |
| AI provider setup | `apps/web/src/lib/ai/` |
| Real-time events | `apps/realtime/src/` |

## Commands

```bash
# Development
pnpm dev                    # Start all services (web, realtime, processor — excludes control-plane)
pnpm dev:services           # Start Postgres, processor, realtime via Docker
pnpm --filter web dev       # Start web app only
pnpm --filter realtime dev  # Start realtime service only
pnpm --filter processor dev # Start processor service only
pnpm dev:desktop            # Start Electron desktop app

# Build
pnpm build                  # Build all apps (Turbo)
pnpm --filter web build     # Build web app only

# Database
pnpm db:generate            # Generate Drizzle migrations from schema changes
pnpm db:migrate             # Run database migrations
pnpm --filter @pagespace/db db:studio  # Open Drizzle Studio

# Testing
pnpm test                   # Run all tests (with DB setup)
pnpm test:unit              # Run unit tests (packages/lib + apps/web)
pnpm test:watch             # Run tests in watch mode
pnpm test:coverage          # Run tests with coverage report
pnpm test:security          # Run security tests

# Quality
pnpm lint                   # Lint all apps
pnpm typecheck              # TypeScript checks across monorepo
```
