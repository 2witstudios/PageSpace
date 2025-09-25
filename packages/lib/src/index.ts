// Server-side exports (includes Node.js modules)
// For client-safe exports, use '@pagespace/lib/client-safe'

// All exports including server-side modules
export * from './page-content-parser';
export * from './permissions-cached'; // Server-only: cached permissions (preferred)

// Export specific functions from original permissions that aren't in cached version
export {
  getUserAccessiblePagesInDriveWithDetails,
  getUserAccessiblePagesInDrive
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
export * from './csrf-utils';
export * from './encryption-utils';
export * from './rate-limit-utils';

// Logging utilities (server-only)
export * from './logger';
export * from './logger-config';
export * from './logger-database';

// Monitoring and tracking utilities (server-only)
export * from './ai-monitoring';
export * from './activity-tracker';

// File processing utilities (server-only)
export * from './file-processor';

// Real-time and broadcasting utilities (server-only)
export * from './broadcast-auth';

// Note: This index includes server-side dependencies and should NOT be imported
// from client-side components. Use '@pagespace/lib/client-safe' for client-side imports.