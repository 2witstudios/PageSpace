# @pagespace/db - Database Layer

This package centralizes all database-related concerns for the pagespace application.

```typescript
// Centralized database concerns
export { db } from './src/index.ts';           // Drizzle client
export * from './src/schema';                  // All table schemas

// Re-exported Drizzle ORM utilities for convenience
export {
  eq, and, or, not, inArray, sql, asc, desc, count, sum, avg, max, min,
  like, ilike, exists, between, gt, gte, lt, lte, ne, isNull, isNotNull
} from 'drizzle-orm';
```

### Responsibilities:
- PostgreSQL connection & client configuration via pg Pool
- Drizzle ORM schema definitions organized by domain
- Database migrations and schema versioning
- Type-safe query builders and relations
- Common Drizzle ORM function re-exports for convenience

### Schema Modules:
- `src/schema/core.ts` - Core entities (users, pages, drives)
- `src/schema/auth.ts` - Authentication tables (sessions, tokens)
- `src/schema/chat.ts` - Chat messages and conversations
- `src/schema/ai.ts` - AI-related data and settings
- `src/schema/permissions.ts` - Access control and permissions
- `src/schema/members.ts` - Drive membership
- `src/schema/dashboard.ts` - Dashboard and widget configurations
- `src/schema/conversations.ts` - Conversation management
- `src/schema/notifications.ts` - Notification system
- `src/schema/monitoring.ts` - System monitoring and metrics

### Key Files:
- `src/index.ts` - Main export file with database client and schema
- `src/schema.ts` - Aggregates all schema modules
- `src/migrate.ts` - Database migration runner script
- `src/migrate-permissions.ts` - Permission migration utilities
- `src/promote-admin.ts` - Admin user promotion script
- `drizzle.config.ts` - Drizzle Kit configuration