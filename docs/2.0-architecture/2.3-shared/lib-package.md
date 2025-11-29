# @pagespace/lib - Shared Utilities

This package contains cross-application business logic and shared utilities organized into semantic directories with separate entry points for client and server environments.

> **Note:** This package was reorganized in November 2025 from flat files to semantic directories for better maintainability.

## Directory Structure

```
packages/lib/src/
├── auth/                    # Authentication & security
│   ├── auth-utils.ts        # JWT authentication and session management
│   ├── broadcast-auth.ts    # Real-time broadcasting authentication
│   ├── csrf-utils.ts        # CSRF token generation and validation
│   ├── device-auth-utils.ts # Device-specific authentication
│   ├── device-fingerprint-utils.ts
│   ├── oauth-types.ts       # OAuth type definitions
│   ├── oauth-utils.ts       # OAuth provider utilities
│   ├── rate-limit-utils.ts  # API rate limiting
│   └── verification-utils.ts # Email/account verification
├── content/                 # Page content processing
│   ├── index.ts             # Barrel export
│   ├── page-content-parser.ts
│   ├── page-type-validators.ts
│   └── page-types.config.ts
├── encryption/              # Cryptographic utilities
│   └── encryption-utils.ts
├── file-processing/         # File upload & processing
│   └── index.ts
├── logging/                 # Logging infrastructure
│   ├── index.ts
│   ├── logger.ts
│   ├── logger-browser.ts
│   ├── logger-config.ts
│   └── logger-database.ts
├── monitoring/              # Analytics & activity tracking
│   ├── activity-tracker.ts
│   ├── ai-context-calculator.ts
│   └── ai-monitoring.ts
├── notifications/           # Notification system
│   └── index.ts
├── permissions/             # Access control
│   ├── permissions.ts       # Core permission logic
│   └── permissions-cached.ts # Cached permission checks (preferred)
├── services/                # Shared services
│   ├── date-utils.ts
│   ├── email-service.ts
│   ├── memory-monitor.ts
│   ├── permission-cache.ts
│   ├── rate-limit-cache.ts
│   ├── service-auth.ts      # Service-to-service authentication
│   ├── storage-limits.ts
│   ├── subscription-utils.ts
│   └── upload-semaphore.ts
├── sheets/                  # Spreadsheet logic
│   └── index.ts
├── utils/                   # General utilities
│   ├── api-utils.ts
│   ├── enums.ts
│   ├── environment.ts
│   ├── file-security.ts
│   ├── tree-utils.ts
│   └── utils.ts
├── pages/                   # Page-specific utilities
│   └── circular-reference-guard.ts
├── types.ts                 # Common TypeScript types
├── index.ts                 # Main entry (server-side)
├── server.ts                # Server-only exports
├── client.ts                # Client-safe exports
└── client-safe.ts           # Explicit client-safe exports
```

## Export Strategy

The package provides multiple entry points for different environments:

### 1. Default Export (`@pagespace/lib`)

Main entry point - includes server-side modules. **Do not use in client components.**

```typescript
import {
  getUserAccessLevel,
  canUserEditPage,
  createAccessToken,
  verifyAccessToken,
  encrypt,
  decrypt
} from '@pagespace/lib';
```

### 2. Client-Safe Export (`@pagespace/lib/client-safe`)

Safe for browser/client components - no Node.js dependencies:

```typescript
import {
  PageType,
  buildPageTree,
  parsePageContent,
  PAGE_TYPE_CONFIG
} from '@pagespace/lib/client-safe';
```

### 3. Server Export (`@pagespace/lib/server`)

Explicit server-only exports:

```typescript
import {
  createAccessToken,
  verifyAccessToken,
  encryptApiKey,
  decryptApiKey
} from '@pagespace/lib/server';
```

### 4. Subpath Exports

Direct imports for specific modules (tree-shakeable):

```typescript
// Authentication
import { createAccessToken } from '@pagespace/lib/auth-utils';
import { authenticateDevice } from '@pagespace/lib/device-auth-utils';
import { verifyBroadcastToken } from '@pagespace/lib/broadcast-auth';

// Logging
import { logger } from '@pagespace/lib/logger';
import { LogLevel } from '@pagespace/lib/logger-config';

// Monitoring
import { trackActivity } from '@pagespace/lib/activity-tracker';
import { trackAiUsage } from '@pagespace/lib/ai-monitoring';

// Permissions (cached version - preferred)
import { getUserAccessLevel } from '@pagespace/lib/permissions-cached';

// Services
import { getStorageLimits } from '@pagespace/lib/services/storage-limits';
import { getSubscriptionTier } from '@pagespace/lib/services/subscription-utils';

// Utilities
import { isProduction } from '@pagespace/lib/utils/environment';
import { validateFileUpload } from '@pagespace/lib/utils/file-security';
```

## Module Responsibilities

### Authentication (`auth/`)
- **auth-utils.ts** - JWT token creation/verification, session management
- **csrf-utils.ts** - CSRF token generation and validation
- **rate-limit-utils.ts** - Request throttling with predefined configs (LOGIN, SIGNUP, REFRESH)
- **oauth-utils.ts** - Google OAuth integration utilities
- **device-auth-utils.ts** - Device-specific authentication flows
- **broadcast-auth.ts** - Socket.IO authentication for real-time features

### Content (`content/`)
- **page-content-parser.ts** - Parse and extract content from pages
- **page-types.config.ts** - Centralized page type configuration (DOCUMENT, FOLDER, AI_CHAT, etc.)
- **page-type-validators.ts** - Validation logic for page creation/updates

### Permissions (`permissions/`)
- **permissions.ts** - Core access control: `getUserAccessLevel`, `canUserViewPage`, `canUserEditPage`
- **permissions-cached.ts** - Cached permission checks for performance (preferred for hot paths)

### Logging (`logging/`)
- **logger.ts** - Structured logging with log levels
- **logger-config.ts** - Logger configuration and levels
- **logger-database.ts** - Database logging for audit trails
- **logger-browser.ts** - Browser-safe logging utilities

### Monitoring (`monitoring/`)
- **activity-tracker.ts** - User activity monitoring and analytics
- **ai-monitoring.ts** - AI usage tracking, token counting, cost calculation
- **ai-context-calculator.ts** - Context window calculation for AI models

### Services (`services/`)
- **service-auth.ts** - Service-to-service authentication (internal APIs)
- **rate-limit-cache.ts** - Redis-backed rate limiting
- **permission-cache.ts** - Permission caching for performance
- **storage-limits.ts** - File storage quota management
- **subscription-utils.ts** - Subscription tier utilities
- **email-service.ts** - Email sending via Resend

### Utilities (`utils/`)
- **utils.ts** - General helper functions
- **enums.ts** - Shared enum definitions (PageType, etc.)
- **tree-utils.ts** - Page hierarchy manipulation
- **api-utils.ts** - API response helpers
- **environment.ts** - Environment detection utilities
- **file-security.ts** - File upload validation and security

## Dependency Philosophy

- **Minimal external dependencies** - Core utilities have few dependencies
- **jose** for JWT operations (lightweight, modern)
- **No framework-specific code** - Works in Next.js, Socket.IO, and standalone contexts
- **Tree-shakeable** - Subpath exports allow importing only what you need
- **Separate entry points** - Prevents bundling Node.js modules in browser builds

## Usage Examples

### Permission Checking

```typescript
import { getUserAccessLevel, canUserEditPage } from '@pagespace/lib/permissions-cached';

const access = await getUserAccessLevel(userId, pageId);
if (access?.canEdit) {
  // User can edit the page
}

// Or use the convenience function
const canEdit = await canUserEditPage(userId, pageId);
```

### Authentication

```typescript
import { createAccessToken, verifyAccessToken } from '@pagespace/lib/auth-utils';

// Create token
const token = await createAccessToken({ userId, role: 'user' });

// Verify token
const claims = await verifyAccessToken(token);
```

### Rate Limiting

```typescript
import { checkRateLimit, RATE_LIMIT_CONFIGS } from '@pagespace/lib/auth/rate-limit-utils';

const result = await checkRateLimit(
  identifier,
  RATE_LIMIT_CONFIGS.LOGIN
);

if (!result.allowed) {
  return Response.json({ error: 'Too many attempts' }, { status: 429 });
}
```

### Logging

```typescript
import { logger } from '@pagespace/lib/logger';

logger.info('User logged in', { userId, ip: request.ip });
logger.error('Failed to process file', { error, fileId });
```

## Migration Notes

If migrating from the old flat structure, update imports:

```typescript
// Old (no longer works)
import { authUtils } from '@pagespace/lib';

// New - use specific imports
import { createAccessToken } from '@pagespace/lib/auth-utils';
// Or from main entry
import { createAccessToken } from '@pagespace/lib';
```

The main `@pagespace/lib` entry still re-exports commonly used functions for backward compatibility, but prefer specific subpath imports for better tree-shaking.
