# @pagespace/lib - Shared Utilities

This package contains cross-application business logic and shared utilities with separate entry points for client and server environments.

## Export Strategy

The package provides three different entry points:

### 1. Default Export (`@pagespace/lib`)
Client-safe exports only (no Node.js modules):
```typescript
export * from './src/page-content-parser';
export * from './src/permissions';
export * from './src/tree-utils';
export * from './src/utils';
export * from './src/enums';
export * from './src/types';
export * from './src/notifications';
```

### 2. Server Export (`@pagespace/lib/server`)
All exports including Node.js-only utilities:
```typescript
export * from './src/auth-utils';      // JWT & authentication helpers
export * from './src/csrf-utils';      // CSRF protection utilities
export * from './src/encryption-utils';// Encryption and decryption
export * from './src/page-content-parser';
export * from './src/permissions';
export * from './src/rate-limit-utils';// Rate limiting utilities
export * from './src/tree-utils';
export * from './src/utils';
export * from './src/enums';
export * from './src/types';
```

### 3. Client Export (`@pagespace/lib/client`)
Explicitly client-safe exports (same as default):
```typescript
export * from './src/page-content-parser';
export * from './src/permissions';
export * from './src/tree-utils';
export * from './src/utils';
export * from './src/enums';
export * from './src/types';
```

## Responsibilities

### Core Utilities:
- **Types** (`types.ts`) - Common TypeScript types and interfaces
- **Enums** (`enums.ts`) - Shared enum definitions
- **Utils** (`utils.ts`) - General-purpose helper functions
- **Tree Utils** (`tree-utils.ts`) - Page hierarchy manipulation
- **Page Content Parser** (`page-content-parser.ts`) - Content parsing utilities
- **Permissions** (`permissions.ts`) - Permission checking and access control logic
- **Notifications** (`notifications.ts`) - Notification system utilities

### Server-Only Utilities:
- **Auth Utils** (`auth-utils.ts`) - JWT authentication and session management
- **Encryption Utils** (`encryption-utils.ts`) - Encryption/decryption operations
- **CSRF Utils** (`csrf-utils.ts`) - CSRF token generation and validation
- **Rate Limit Utils** (`rate-limit-utils.ts`) - API rate limiting

### Additional Server Modules:
- **Logger** (`logger.ts`, `logger-config.ts`, `logger-database.ts`) - Logging infrastructure
- **Activity Tracker** (`activity-tracker.ts`) - User activity monitoring
- **AI Monitoring** (`ai-monitoring.ts`) - AI usage tracking and metrics

## Dependency Philosophy
- Minimal external dependencies (jose for JWT)
- No framework-specific code (works in both Next.js and Socket.IO contexts)
- Pure TypeScript/JavaScript utilities
- Separate entry points for client/server to avoid bundling Node.js modules in browser