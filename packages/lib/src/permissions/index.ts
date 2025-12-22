/**
 * @module @pagespace/lib/permissions
 * @description Access control and permissions
 */

// Export cached permissions as the primary API (preferred)
export * from './permissions-cached';

// Export specific functions from original permissions that aren't in cached version
export {
  getUserAccessiblePagesInDriveWithDetails,
  getUserAccessiblePagesInDrive,
  isDriveOwnerOrAdmin,
  isUserDriveMember,
  grantPagePermissions,
  revokePagePermissions,
} from './permissions';

// Export rollback permissions
export * from './rollback-permissions';
