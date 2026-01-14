/**
 * @module @pagespace/lib/permissions
 * @description Access control and permissions
 */

// Export cached permissions as the primary API (preferred)
export * from './permissions-cached';

// Export specific functions from original permissions that aren't in cached version
export {
  getDriveIdsForUser,
  getUserAccessiblePagesInDriveWithDetails,
  getUserAccessiblePagesInDrive,
  isDriveOwnerOrAdmin,
  isUserDriveMember,
  grantPagePermissions,
  revokePagePermissions,
} from './permissions';

// Export rollback permissions
export * from './rollback-permissions';

// Export enforced auth context
export * from './enforced-context';
