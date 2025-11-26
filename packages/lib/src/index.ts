// Server-side exports (includes Node.js modules)
// For client-safe exports, use '@pagespace/lib/client-safe'

// All exports including server-side modules
export * from './page-content-parser';
export * from './permissions-cached'; // Server-only: cached permissions (preferred)

// Export specific functions from original permissions that aren't in cached version
export {
  getUserAccessiblePagesInDriveWithDetails,
  getUserAccessiblePagesInDrive,
  isDriveOwnerOrAdmin
} from './permissions';
export * from './tree-utils';
export * from './utils';
export * from './enums';
export * from './types';
export * from './notifications';
export * from './page-types.config';
export * from './page-type-validators';
export * from './sheet';

// Auth and security utilities (server-only)
export * from './auth-utils';
export * from './device-auth-utils';
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
export * from './csrf-utils';
export * from './encryption-utils';
export * from './rate-limit-utils';
export * from './verification-utils';

// OAuth utilities (server-only)
export * from './oauth-utils';
export * from './oauth-types';

// Logging utilities (server-only)
export * from './logger';
export * from './logger-config';
export * from './logger-database';

// Monitoring and tracking utilities (server-only)
export * from './ai-monitoring';
export * from './activity-tracker';

// Rate limiting and caching services (server-only)
export { rateLimitCache } from './services/rate-limit-cache';
export type { ProviderType, UsageTrackingResult } from './services/rate-limit-cache';
export { getTodayUTC, getTomorrowMidnightUTC, getSecondsUntilMidnightUTC } from './services/date-utils';

// File processing utilities (server-only)
export * from './file-processor';

// Export utilities (server-only)
export * from './export-utils';

// Real-time and broadcasting utilities (server-only)
export * from './broadcast-auth';

// Welcome documentation utilities (server-only)
export * from './welcome-docs';

// Note: This index includes server-side dependencies and should NOT be imported
// from client-side components. Use '@pagespace/lib/client-safe' for client-side imports.
