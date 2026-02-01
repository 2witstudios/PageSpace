/**
 * Pure Visibility Check Functions
 *
 * Checks if a user integration is visible in a given drive context.
 * This is a PURE function - no side effects, deterministic output.
 */

import type { ConnectionVisibility, DriveRole } from '../types';

/**
 * Check if a user integration is visible in a drive based on visibility setting.
 *
 * @param visibility - The integration's visibility setting
 * @param userDriveRole - The user's role in the drive (null if no access)
 * @returns Whether the integration is visible in this drive
 */
export const isUserIntegrationVisibleInDrive = (
  visibility: ConnectionVisibility,
  userDriveRole: DriveRole | null
): boolean => {
  switch (visibility) {
    case 'private':
      // Private integrations are never visible in drives
      // (they're only for personal use outside drive context)
      return false;

    case 'owned_drives':
      // Visible only in drives where user is OWNER or ADMIN
      return userDriveRole === 'OWNER' || userDriveRole === 'ADMIN';

    case 'all_drives':
      // Visible in all drives where user has any role
      return userDriveRole !== null;

    default:
      return false;
  }
};
