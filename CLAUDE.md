# PageSpace Local Development Guide

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
- `packages/db`: The centralized Drizzle ORM package containing database schema, migrations, and query logic
- `packages/lib`: Shared utilities, types, and functions used across the monorepo

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

## 3. MANDATORY DOCUMENTATION WORKFLOW

- When changes land, update the changelog and any user-visible notes.

## 4. DEVELOPMENT STANDARDS

### 4.1. Code Quality Principles

- **No `any` types** - Always use proper TypeScript types
- **Explicit over implicit** - Clear, self-documenting code
- **Right-first approach** - Build the ideal solution from the start
- **Consistent patterns** - Follow established conventions

### 4.2. Critical Patterns

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

## 5. CLAUDE CODE INTEGRATION & MCP TOOLS

### 5.1. MCP Tools Integration

Claude Code can invoke the MCP/DevTools integration whenever browser automation or diagnostics are needed.

### 5.2. PageSpace Domain Expert Agents

PageSpace has 17 specialized domain expert agents with deep knowledge of specific subsystems.

**Core Infrastructure (5 agents):**
- **Authentication & Security Expert**: JWT tokens, CSRF protection, encryption, rate limiting, session management
- **Database & Schema Expert**: Drizzle ORM, PostgreSQL, migrations, schema design, query optimization
- **Permissions & Authorization Expert**: RBAC, drive membership, page permissions, access control logic
- **Real-time Collaboration Expert**: Socket.IO, live sync, conflict resolution, event broadcasting
- **Monitoring & Analytics Expert**: Logging, tracking, performance metrics, error handling, usage analytics

**AI Intelligence (3 agents):**
- **AI System Architect**: AI providers, message flow, streaming, model capabilities, provider factory
- **AI Tools Integration Expert**: Tool calling, PageSpace tools, batch operations, search tools
- **AI Agents Communication Expert**: Agent roles, agent-to-agent communication, custom agents

**Content & Workspace (4 agents):**
- **Pages & Content Expert**: Page types, content management, CRUD operations, tree structure
- **Drives & Workspace Expert**: Drive management, membership, invitations, workspace organization
- **File Processing Expert**: File uploads, processor service, image optimization, content-addressed storage
- **Search & Discovery Expert**: Regex search, glob patterns, multi-drive search, mention system

**Frontend & UX (3 agents):**
- **Frontend Architecture Expert**: Next.js 15, App Router, components, state management, Zustand, SWR
- **Editor System Expert**: Tiptap, Monaco, document state, auto-save, Prettier integration
- **Canvas Dashboard Expert**: Shadow DOM, custom HTML/CSS, navigation, security sanitization

**API & Integration (2 agents):**
- **API Routes Expert**: Next.js routes, async params, request handling, error responses, middleware
- **MCP Integration Expert**: MCP tokens, document operations, protocol integration, external tools

### 5.3. Development Workflow Patterns

Use the Task tool to launch domain experts; each agent advertises its own capabilities and workflow.

## 6. PROJECT STRUCTURE

Atypical roots worth noting: `apps/realtime`, `apps/processor`, `packages/db`, `packages/lib`, plus supporting `docs/`, `scripts/`, and `types/` directories.

## 7. COMMANDS

```bash
# Development
pnpm dev                    # Start all services
pnpm --filter web dev       # Start web app only

# Build
pnpm build                  # Build all apps
pnpm --filter web build     # Build web app only

# Database
pnpm db:generate            # Generate Drizzle migrations
pnpm db:migrate             # Run database migrations
pnpm --filter @pagespace/db db:studio  # Open Drizzle Studio

# Linting
pnpm --filter web lint      # Run ESLint on web app
```

## 8. COMMON WORKFLOWS

### 8.1. Development Workflows

1. **Adding new API routes**: Follow Next.js 15 async params pattern
2. **Database changes**: Update schema in `packages/db`, generate migrations
3. **New components**: Follow existing patterns in `components/` directory
4. **AI provider integration**: See `docs/3.0-guides-and-tools/adding-ai-provider.md`
5. **Permission changes**: Update centralized logic in `@pagespace/lib/permissions`

### 8.2. Domain Expert Agent Workflows

Lean on Section 5.2 and each agent’s self-description; selection emerges from the query context.
