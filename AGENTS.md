# PageSpace Codebase Guidelines

## 1. TECH STACK & ARCHITECTURE

### 1.1. Core Technology Stack

- **Full-Stack**: Next.js 15 App Router + TypeScript + Tailwind + shadcn/ui
- **Database**: PostgreSQL + Drizzle ORM (local deployment via Docker)
- **AI**: Ollama (local models) + Vercel AI SDK + OpenRouter + Google AI SDK
- **Auth**: Custom JWT-based authentication (local user management)
- **File Storage**: Local filesystem with metadata in PostgreSQL
- **Real-time**: Socket.IO for live collaboration
- **Deployment**: Docker containers on Mac Studio (local deployment)

### 1.2. Monorepo Architecture

This project uses a pnpm workspace with the following structure:

- `apps/web`: The main Next.js 15 frontend and backend application
- `apps/realtime`: A dedicated Socket.IO service for real-time communication
- `apps/processor`: Express-based file/OCR processing pipeline
- `packages/db`: The centralized Drizzle ORM package containing database schema, migrations, and query logic
- `packages/lib`: Shared utilities, types, and functions used across the monorepo
- `docs/`: Design notes and documentation
- `types/`: Global TypeScript types
- `scripts/`: Helper scripts

**Database Schema**: Entry point at `packages/db/src/schema.ts`; migrations emit to `packages/db/drizzle/`.

### 1.3. Key Dependencies

**Frontend & UI:**
- Next.js 15.3.5 with App Router
- React ^19.0.0 + TypeScript ^5.8.3
- Tailwind CSS ^4 + shadcn/ui components
- TipTap rich text editor with markdown support
- Monaco Editor for code editing
- @dnd-kit for drag-and-drop functionality

**Backend & Database:**
- Drizzle ORM ^0.32.2 with PostgreSQL
- Custom JWT authentication with jose ^6.0.11
- bcryptjs ^3.0.2 for password hashing

**AI & Real-time:**
- Vercel AI SDK ^4.3.17
- Ollama AI provider ^1.2.0 for local models
- @ai-sdk/google ^1.2.22, @ai-sdk/anthropic ^1.2.12, @ai-sdk/openai ^1.3.23
- @openrouter/ai-sdk-provider 0.7.2 for cloud models
- Socket.IO ^4.7.5 for real-time collaboration

**State Management:**
- Zustand for client state
- SWR for server state and caching

## 2. NEXT.JS 15 ROUTE HANDLER REQUIREMENTS

### 2.1. Breaking Change: Dynamic Route params are Promises

**CRITICAL**: In Next.js 15, `params` in dynamic routes are Promise objects. You MUST await `context.params` before destructuring.

```typescript
// ✅ CORRECT Pattern
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params; // Must await params
  return Response.json({ id });
}

// ❌ INCORRECT Pattern
export async function GET(
  request: Request,
  { params }: { params: { id: string } } // WRONG: params is a Promise
) {
  // This will fail in Next.js 15
}
```

### 2.2. Request Handling Standards

- **Get Request Body**: `const body = await request.json();`
- **Get Search Params**: `const { searchParams } = new URL(request.url);`
- **Return JSON**: `return Response.json(data)` or `return NextResponse.json(data)`

## 3. DEVELOPMENT STANDARDS

### 3.1. Code Quality Principles

- **No `any` types** - Always use proper TypeScript types
- **Explicit over implicit** - Clear, self-documenting code
- **Right-first approach** - Build the ideal solution from the start
- **Consistent patterns** - Follow established conventions

### 3.2. Coding Style & Naming Conventions

- TypeScript strict mode; ESM modules
- **Filenames**: kebab-case (`image-processor.ts`)
- **React components**: PascalCase
- **Variables/functions**: camelCase
- **Constants**: UPPER_SNAKE_CASE
- **Types/enums**: PascalCase
- Format with Prettier; lint with Next/ESLint (`apps/web/eslint.config.mjs`)
- Keep diffs minimal and focused

### 3.3. Critical Patterns

**Message Content Structure:**
```typescript
// ✅ CORRECT - Always use message parts structure
const message = {
  parts: [
    { type: 'text', text: "Hello world" }
  ]
};
```

**Permission Logic:**
```typescript
// ✅ CORRECT - Use centralized permissions
import { getUserAccessLevel, canUserEditPage } from '@pagespace/lib/permissions';
const accessLevel = await getUserAccessLevel(userId, pageId);
```

**Database Access:**
```typescript
// ✅ CORRECT - Always use Drizzle client from @pagespace/db
import { db, pages } from '@pagespace/db';
const page = await db.select().from(pages);
```

## 4. BUILD, TEST, AND DEVELOPMENT COMMANDS

### 4.1. Development Commands

```bash
# Install dependencies
pnpm install

# Environment setup
cp .env.example .env
# Also: apps/web/.env.example → apps/web/.env if needed

# Database (local)
pnpm dev:db                 # Starts Postgres + runs migrations
docker compose up -d        # Alternative

# Develop all apps
pnpm dev                    # Runs Turbo dev across packages

# Focus a single app
pnpm --filter web dev
pnpm --filter realtime dev
pnpm --filter @pagespace/processor dev

# Build and quality checks
pnpm build                  # Build all apps
pnpm typecheck              # TypeScript checks
pnpm lint                   # ESLint
pnpm --filter web build     # Build web app only
pnpm --filter web lint      # Lint web app only

# Database tasks
pnpm db:generate            # Create migrations
pnpm db:migrate             # Apply migrations
pnpm --filter @pagespace/db db:studio  # Browse schema
```

### 4.2. Testing Guidelines

- No global test runner is enforced yet. When adding tests:
  - Prefer unit tests for `packages/lib`/`apps/processor` (`*.test.ts` next to source or in `__tests__/`)
  - Add a `test` script in the target package and run with `pnpm --filter <pkg> test`
  - Use `pnpm typecheck` and `pnpm lint` as gates before PRs

## 5. PAGESPACE DOMAIN EXPERT AGENTS

PageSpace has 17 specialized domain expert agents with deep knowledge of specific subsystems.

### 5.1. Core Infrastructure (5 agents)

- **Authentication & Security Expert**: JWT tokens, CSRF protection, encryption, rate limiting, session management
- **Database & Schema Expert**: Drizzle ORM, PostgreSQL, migrations, schema design, query optimization
- **Permissions & Authorization Expert**: RBAC, drive membership, page permissions, access control logic
- **Real-time Collaboration Expert**: Socket.IO, live sync, conflict resolution, event broadcasting
- **Monitoring & Analytics Expert**: Logging, tracking, performance metrics, error handling, usage analytics

### 5.2. AI Intelligence (3 agents)

- **AI System Architect**: AI providers, message flow, streaming, model capabilities, provider factory
- **AI Tools Integration Expert**: Tool calling, PageSpace tools, batch operations, search tools
- **AI Agents Communication Expert**: Agent roles, agent-to-agent communication, custom agents

### 5.3. Content & Workspace (4 agents)

- **Pages & Content Expert**: Page types, content management, CRUD operations, tree structure
- **Drives & Workspace Expert**: Drive management, membership, invitations, workspace organization
- **File Processing Expert**: File uploads, processor service, image optimization, content-addressed storage
- **Search & Discovery Expert**: Regex search, glob patterns, multi-drive search, mention system

### 5.4. Frontend & UX (3 agents)

- **Frontend Architecture Expert**: Next.js 15, App Router, components, state management, Zustand, SWR
- **Editor System Expert**: Tiptap, Monaco, document state, auto-save, Prettier integration
- **Canvas Dashboard Expert**: Shadow DOM, custom HTML/CSS, navigation, security sanitization

### 5.5. API & Integration (2 agents)

- **API Routes Expert**: Next.js routes, async params, request handling, error responses, middleware
- **MCP Integration Expert**: MCP tokens, document operations, protocol integration, external tools

## 6. COMMON WORKFLOWS

### 6.1. Development Workflows

1. **Adding new API routes**: Follow Next.js 15 async params pattern (see Section 2.1)
2. **Database changes**: Update schema in `packages/db`, generate migrations with `pnpm db:generate`
3. **New components**: Follow existing patterns in `components/` directory
4. **AI provider integration**: See `docs/3.0-guides-and-tools/adding-ai-provider.md`
5. **Permission changes**: Update centralized logic in `@pagespace/lib/permissions`

### 6.2. Commit & Pull Request Guidelines

- **Commits**: short, imperative subject (≤72 chars), optional scope like `[web]`, `[processor]`
- **PRs**: clear description, linked issues, screenshots for UI, note DB migrations and any `.env` or config changes. Include reproduction/verification steps.
- **Before opening**: run `pnpm build`, `pnpm typecheck`, and relevant `db:*` tasks
- **Documentation**: When changes land, update the changelog and any user-visible notes

## 7. SECURITY & CONFIGURATION

- Never commit secrets. Base config in `.env.example`; runtime in `.env`
- Important vars: `DATABASE_URL`, encryption keys, `WEB_APP_URL`, `NEXT_PUBLIC_*`, service ports
- For self‑host, see `docker-compose.yml`
