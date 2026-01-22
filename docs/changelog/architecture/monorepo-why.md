# Why Monorepo

> pnpm workspaces, Turbo, package structure

## The Decision

PageSpace is structured as a pnpm monorepo with Turbo for build orchestration. This wasn't accidental - it was chosen to support the multi-service architecture.

## Key Architectural Choices

### pnpm Over npm/yarn

**The Choice**: pnpm as the package manager.

**Why**:
- Disk space efficiency (content-addressable storage)
- Strict dependency resolution
- Native workspace support
- Faster than npm
- Symbolic link approach prevents phantom dependencies

**Critical Rule**:
> ALWAYS use `pnpm` - NEVER use `npm` for install, run, or any commands

### Turbo for Build Orchestration

**The Choice**: Turborepo for task running and caching.

**Why**:
- Parallel task execution
- Intelligent caching (only rebuild what changed)
- Dependency-aware task ordering
- Remote caching possible

### Package Structure

```
PageSpace/
├── apps/
│   ├── web/         # Next.js main app
│   ├── realtime/    # Socket.IO service
│   ├── processor/   # File processing
│   └── desktop/     # Electron app
├── packages/
│   ├── db/          # Drizzle ORM, schema, migrations
│   └── lib/         # Shared utilities
```

**Why This Split**:
- **apps/**: Deployable services, each can run independently
- **packages/**: Shared code, consumed by multiple apps

### Shared Packages

#### `@pagespace/db`

**Purpose**: Centralized database access.

**Contains**:
- Drizzle schema definitions
- Migration files (auto-generated)
- Database client
- Query utilities

**Used By**: web, realtime, processor

#### `@pagespace/lib`

**Purpose**: Shared utilities and types.

**Contains**:
- TypeScript types
- Permission logic
- Utility functions
- Constants

**Used By**: All apps and packages

## Cross-App Patterns

### Type Sharing

Types defined in `@pagespace/lib` are available everywhere:

```typescript
import { PageType, User } from '@pagespace/lib';
```

### Database Access

All apps use the same database client:

```typescript
import { db, pages } from '@pagespace/db';
```

## Evolution Through Commits

*This section will track monorepo evolution:*
- Initial structure decisions
- Package additions
- Build optimization
- Dependency management

---

*Last updated: 2026-01-21 | Version: 0*
