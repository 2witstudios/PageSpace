// Server-side exports (includes Node.js modules)
// For client-safe exports, use '@pagespace/lib/client-safe'

/**
 * @module @pagespace/lib
 * @description Main entry point for PageSpace shared library
 *
 * Organized by domain:
 * - auth/         - Authentication & security
 * - content/      - Page content processing
 * - encryption/   - Cryptographic utilities
 * - file-processing/ - File upload & processing
 * - logging/      - Logging infrastructure
 * - monitoring/   - Analytics & activity tracking
 * - notifications/ - Notification system
 * - permissions/  - Access control
 * - sheets/       - Spreadsheet logic
 * - utils/        - General utilities
 */

// Content processing
export * from './content';

// Permissions (export cached version by default)
export * from './permissions/permissions-cached'; // Server-only: cached permissions (preferred)

// Export specific functions from original permissions that aren't in cached version
export {
  getUserAccessiblePagesInDriveWithDetails,
  getUserAccessiblePagesInDrive,
  isDriveOwnerOrAdmin,
  isUserDriveMember,
} from './permissions/permissions';

// Utilities
export * from './utils';

// Types
export * from './types';

// Notifications
export * from './notifications';

// Sheets
export * from './sheets';

// Auth and security utilities (server-only)
export * from './auth/auth-utils';
export * from './auth/device-auth-utils';
export { secureCompare } from './auth/secure-compare';
export {
  createServiceToken as createServiceTokenV2,
  verifyServiceToken as verifyServiceTokenV2,
  authenticateServiceToken,
  decodeServiceTokenHeader,
  hasScope,
  assertScope,
  hasScope as hasServiceScope,
  assertScope as assertServiceScope,
  type ServiceTokenClaims,
  type ServiceTokenOptions,
  type ServiceScope,
} from './services/service-auth';
export * from './auth/csrf-utils';
export * from './encryption';
export * from './auth/rate-limit-utils';
export * from './auth/verification-utils';

// OAuth utilities (server-only)
export * from './auth/oauth-utils';
export * from './auth/oauth-types';

// Logging utilities (server-only)
export * from './logging/logger';
export * from './logging/logger-config';
export * from './logging/logger-database';

// Monitoring and tracking utilities (server-only)
export * from './monitoring/ai-monitoring';
export * from './monitoring/activity-tracker';
export * from './monitoring/activity-logger';
export * from './monitoring/hash-chain-verifier';

// Repository seams (server-only)
export * from './repositories';

// Rate limiting and caching services (server-only)
export { rateLimitCache } from './services/rate-limit-cache';
export type { ProviderType, UsageTrackingResult } from './services/rate-limit-cache';
export { getTodayUTC, getTomorrowMidnightUTC, getSecondsUntilMidnightUTC } from './services/date-utils';

// Agent awareness caching (server-only)
export { agentAwarenessCache, AgentAwarenessCache } from './services/agent-awareness-cache';
export type { CachedAgent, CachedDriveAgents } from './services/agent-awareness-cache';

// Page tree caching (server-only)
export { pageTreeCache, PageTreeCache } from './services/page-tree-cache';
export type { CachedTreeNode, CachedPageTree } from './services/page-tree-cache';

// File processing utilities (server-only)
export * from './file-processing';

// Real-time and broadcasting utilities (server-only)
export * from './auth/broadcast-auth';

// Note: This index includes server-side dependencies and should NOT be imported
// from client-side components. Use '@pagespace/lib/client-safe' for client-side imports.
