// All exports including Node.js-only utilities
export * from './auth/device-auth-utils';
export * from './auth/csrf-utils';
export * from './encryption';
export * from './content';
export * from './permissions/permissions-cached';
export * from './auth/rate-limit-utils';
export * from './utils/utils';
export * from './utils/hash-utils';
export * from './utils/enums';
export * from './types';
export * from './file-processing';
export * from './services/subscription-utils';
export * from './services/page-content-store';
export {
  computePageStateHash,
  createPageVersion,
  type PageVersionSource,
  type PageStateInput,
  type CreatePageVersionInput,
} from './services/page-version-service';
export * from './sheets';

// Drive service
export * from './services/drive-service';

// Drive member service
export * from './services/drive-member-service';

// Drive role service
export * from './services/drive-role-service';

// Drive search service
export * from './services/drive-search-service';

// OAuth utilities (server-only)
export * from './auth/oauth-utils';
export * from './auth/oauth-types';

// Logging utilities (server-only)
export * from './logging';

// Monitoring (activity logging, AI monitoring)
export * from './monitoring';

// Repository seams for testable database access
export * from './repositories';

// Notifications
export * from './notifications';

// Agent awareness caching
export { agentAwarenessCache, AgentAwarenessCache } from './services/agent-awareness-cache';
export type { CachedAgent, CachedDriveAgents } from './services/agent-awareness-cache';

// Page tree caching
export { pageTreeCache, PageTreeCache } from './services/page-tree-cache';
export type { CachedTreeNode, CachedPageTree } from './services/page-tree-cache';

// Re-export specific functions for backward compatibility
export {
  getDriveIdsForUser,
  isUserDriveMember,
  getUserAccessiblePagesInDriveWithDetails,
  getUserAccessiblePagesInDrive,
  isDriveOwnerOrAdmin,
} from './permissions/permissions';

// Zero-trust permission mutations (replaces old grantPagePermissions/revokePagePermissions)
export {
  grantPagePermission,
  revokePagePermission,
  type GrantResult,
  type RevokeResult,
  type PermissionMutationError,
} from './permissions/permission-mutations';
export {
  GrantInputSchema,
  RevokeInputSchema,
  PermissionFlagsSchema,
  type GrantInput,
  type RevokeInput,
  type PermissionFlags,
} from './permissions/schemas';

// Enforced auth context
export { EnforcedAuthContext } from './permissions/enforced-context';
