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

Before ANY code change:
1. Review architecture and guides in the `docs/` directory
2. Understand existing patterns and conventions

After code changes:
1. Update relevant documentation:
   - `docs/1.0-overview/1.5-functions-list.md`
   - `docs/1.0-overview/1.4-api-routes-list.md` 
   - `docs/2.0-architecture/2.2-backend/database.md`
2. Log ALL changes in `docs/1.0-overview/changelog.md` with timestamp

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

Claude Code has access to several Model Context Protocol (MCP) tools that enhance development capabilities:

**context7 MCP:**
- `resolve-library-id`: Resolves package names to Context7-compatible library IDs
- `get-library-docs`: Fetches up-to-date documentation for libraries
- **Usage**: Always use for researching current documentation before implementation decisions

**sequential-thinking MCP:**
- Provides structured thinking and planning capabilities for complex problems
- **Usage**: Use for breaking down complex tasks, analyzing trade-offs, and systematic problem-solving

**ide MCP:**
- `getDiagnostics`: Get language diagnostics from VS Code
- `executeCode`: Execute Python code in Jupyter kernel
- **Usage**: Integrate with development environment for real-time feedback

### 5.2. Claude Code Sub-Agents

Claude Code provides specialized sub-agents for different development tasks:

**Orchestration Agent:**
- **point-guard**: Orchestrates multiple sub-agents for complex, multi-step tasks requiring coordination
- **Usage**: Default choice for complex features, refactoring, or multi-component implementations

**Consultant Agents:**
- **linus-advisor**: Provides brutally honest technical guidance in Linus Torvalds style
- **codebase-researcher**: Deep analysis of existing codebase patterns and architecture
- **technical-researcher**: Initial research using context7 MCP for current best practices
- **Usage**: Consult before major architectural decisions or when understanding existing patterns

**Specialized Agents:**
- **ai-sdk-expert**: Vercel AI SDK implementation, streaming patterns, and optimization
- **coding-standards-auditor**: Verify code compliance with established standards
- **technical-debate-moderator**: Structure debates between multiple AI perspectives for complex decisions
- **general-purpose**: General research and multi-step task execution

### 5.3. Development Workflow Patterns

**Research-First Approach:**
1. Use **technical-researcher** with context7 MCP for current documentation
2. Use **codebase-researcher** to understand existing patterns
3. Consult **linus-advisor** for architectural guidance
4. Proceed with implementation

**Complex Task Delegation:**
1. Use **point-guard** to orchestrate multi-step tasks
2. Let point-guard delegate to appropriate specialized agents
3. Verify with **coding-standards-auditor** before completion

**Decision-Making Process:**
1. Use **technical-debate-moderator** for complex architectural choices
2. Research options with **technical-researcher** and context7
3. Get brutally honest assessment from **linus-advisor**
4. Make informed decision with multiple perspectives

## 6. PROJECT STRUCTURE

### 6.1. Database Schema (`packages/db/src/schema/`)

- `core.ts`: Main entities (users, pages, drives)
- `auth.ts`: Authentication tables (sessions, tokens)
- `chat.ts`: Chat messages and conversations
- `ai.ts`: AI-related data and settings
- `permissions.ts`: Access control and permissions

### 6.2. API Routes (`apps/web/src/app/api/`)

- `auth/`: Authentication endpoints
- `ai/`: AI chat and assistant endpoints
- `pages/`: Page CRUD operations
- `drives/`: Drive and workspace management
- `channels/`: Real-time messaging
- `mentions/`: Mention system and search

### 6.3. Components (`apps/web/src/components/`)

- `ai/`: AI-related components (chat, settings, providers)
- `editors/`: Rich text and code editors
- `layout/`: Main application layout components
- `ui/`: shadcn/ui component library
- `dialogs/`: Modal dialogs and confirmations

## 7. TESTING & BUILD COMMANDS

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

## 8. LOCAL DEPLOYMENT

The project runs entirely locally using Docker:

```yaml
# docker-compose.yml services:
- PostgreSQL database
- Web application (Next.js)
- Realtime service (Socket.IO)
- Ollama for local AI models
```

## 9. SECURITY & COMPLIANCE

- **Local-first architecture**: All data stays on your local machine
- **JWT-based authentication**: Secure session management
- **Permission system**: Role-based access control (RBAC)
- **Input sanitization**: All user content is sanitized before storage/display
- **No cloud dependencies**: Complete data sovereignty

## 10. AI INTEGRATION

### 10.1. Supported Providers

- **Ollama**: Local models (llama3, codellama, etc.)
- **OpenRouter**: Cloud models access
- **Google AI**: Gemini models
- **Anthropic**: Claude models (via OpenRouter)

### 10.2. AI Features

- **AI Assistant**: Persistent conversations with context
- **AI Pages**: Interactive AI-powered documents
- **Mention System**: @ai mentions for inline AI assistance
- **Code Generation**: AI-powered code editing and suggestions

## 11. IMPORTANT NOTES

- This is a **local-first application** - no cloud services required
- All AI processing can be done locally via Ollama
- Database runs in Docker container for easy setup
- Real-time collaboration via Socket.IO
- Comprehensive permission system for multi-user scenarios
- Rich text editing with markdown support
- File storage is filesystem-based with PostgreSQL metadata

## 12. COMMON WORKFLOWS

### 12.1. Development Workflows

1. **Adding new API routes**: Follow Next.js 15 async params pattern
2. **Database changes**: Update schema in `packages/db`, generate migrations
3. **New components**: Follow existing patterns in `components/` directory
4. **AI provider integration**: See `docs/3.0-guides-and-tools/adding-ai-provider.md`
5. **Permission changes**: Update centralized logic in `@pagespace/lib/permissions`

### 12.2. Claude Code Enhanced Workflows

**Complex Feature Implementation:**
1. Use **point-guard** agent to orchestrate the implementation
2. Let point-guard delegate research to **technical-researcher** + context7 MCP
3. Use **codebase-researcher** to understand existing patterns
4. Implement with appropriate specialized agents (e.g., **ai-sdk-expert** for AI features)
5. Verify with **coding-standards-auditor** before completion

**Architecture Decision Making:**
1. Use **technical-researcher** with context7 MCP for current best practices
2. Consult **codebase-researcher** for existing system patterns
3. Use **technical-debate-moderator** for complex decisions requiring multiple perspectives
4. Get final brutally honest assessment from **linus-advisor**
5. Document decision rationale

**Code Quality Assurance:**
1. Use **coding-standards-auditor** to verify compliance with project standards
2. Consult **linus-advisor** for performance and maintainability concerns
3. Use **codebase-researcher** to ensure consistency with existing patterns

**Research and Planning:**
1. Use **sequential-thinking** MCP for complex problem breakdown
2. Use **technical-researcher** + context7 MCP for up-to-date documentation
3. Use **codebase-researcher** for understanding existing architecture
4. Use **point-guard** for coordinating multi-step research tasks
