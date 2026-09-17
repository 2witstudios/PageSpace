/**
 * Whether a credential's DRIVE SCOPE reaches a workspace — the token half of
 * the question `checkSessionAccess` answers for the user half.
 *
 * A workspace lives in one drive (`driveId`) or in none (a driveless Global
 * session). A drive-scoped token reaches only workspaces inside its drives;
 * a driveless workspace belongs to no drive, so only an UNSCOPED credential
 * (a cookie session, an unscoped token) reaches it. A manage-keys-only
 * credential reaches nothing.
 */

import { getAllowedDriveIds, isManageKeysOnly, type AuthResult } from '@/lib/auth';

export function isWorkspaceInCredentialScope(auth: AuthResult, driveId: string | null): boolean {
  if (isManageKeysOnly(auth)) return false;
  const allowedDriveIds = getAllowedDriveIds(auth);
  if (allowedDriveIds.length === 0) return true;
  return driveId !== null && allowedDriveIds.includes(driveId);
}
