import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { mcpTokenDrives } from '@pagespace/db/schema/members';
import { resolveRolePermissions } from './resolve-role-permissions';
import { fetchDriveIdForPage, fetchCustomRolePermissions, resolveCustomRolePermissions } from './membership-queries';
import type { PermissionLevel } from './permissions';

async function fetchAppMembership(tokenId: string, driveId: string) {
  const rows = await db
    .select()
    .from(mcpTokenDrives)
    .where(and(eq(mcpTokenDrives.tokenId, tokenId), eq(mcpTokenDrives.driveId, driveId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAppAccessLevel(
  tokenId: string,
  targetPageId: string,
): Promise<PermissionLevel | null> {
  const driveId = await fetchDriveIdForPage(targetPageId);
  const membership = await fetchAppMembership(tokenId, driveId);
  if (!membership) return null;

  const role = membership.customRoleId
    ? await fetchCustomRolePermissions(membership.customRoleId, driveId)
    : null;

  if (role && membership.role !== 'ADMIN' && membership.role !== 'OWNER') {
    const resolved = resolveCustomRolePermissions(role, targetPageId);
    if (resolved !== null) {
      return resolved.canView ? { ...resolved, canDelete: false } : null;
    }
    // No per-page or drive-wide grant — custom roles limit access to explicitly listed pages
    return { canView: false, canEdit: false, canShare: false, canDelete: false };
  }

  return resolveRolePermissions(membership.role, role?.permissions ?? null, targetPageId);
}

export async function hasAppDriveMembership(tokenId: string, driveId: string): Promise<boolean> {
  const row = await db
    .select({ id: mcpTokenDrives.id })
    .from(mcpTokenDrives)
    .where(and(eq(mcpTokenDrives.tokenId, tokenId), eq(mcpTokenDrives.driveId, driveId)))
    .limit(1);
  return row.length > 0;
}
