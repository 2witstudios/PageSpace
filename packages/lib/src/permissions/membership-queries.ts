import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveRoles } from '@pagespace/db/schema/members';

export type CustomRolePerms = Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;
export type PagePerm = { canView: boolean; canEdit: boolean; canShare: boolean };

/**
 * Resolves the effective permissions for a pageId against a custom role.
 * Per-page entry wins; driveWidePermissions is the fallback for pages not
 * explicitly listed. Returns null when neither is set.
 */
export function resolveCustomRolePermissions(
  role: { permissions: CustomRolePerms; driveWidePermissions: PagePerm | null },
  pageId: string,
): PagePerm | null {
  const perPage = role.permissions[pageId];
  if (perPage !== undefined) return perPage;
  return role.driveWidePermissions ?? null;
}

export async function fetchDriveIdForPage(targetPageId: string): Promise<string> {
  const page = await db
    .select({ driveId: pages.driveId })
    .from(pages)
    .where(eq(pages.id, targetPageId))
    .limit(1);
  // If no page exists, treat targetPageId itself as a drive ID (drive-as-root-node pattern).
  return page.length > 0 ? page[0].driveId : targetPageId;
}

// driveId is required to prevent a custom role from one drive being applied to another.
export async function fetchCustomRolePermissions(
  customRoleId: string,
  driveId: string,
): Promise<{ permissions: CustomRolePerms; driveWidePermissions: PagePerm | null } | null> {
  const result = await db
    .select({ permissions: driveRoles.permissions, driveWidePermissions: driveRoles.driveWidePermissions })
    .from(driveRoles)
    .where(and(eq(driveRoles.id, customRoleId), eq(driveRoles.driveId, driveId)))
    .limit(1);
  if (result.length === 0) return null;
  return {
    permissions: result[0].permissions,
    driveWidePermissions: result[0].driveWidePermissions as PagePerm | null,
  };
}

// Returns true only when the custom role exists and belongs to the specified drive.
export async function customRoleBelongsToDrive(customRoleId: string, driveId: string): Promise<boolean> {
  const result = await db
    .select({ id: driveRoles.id })
    .from(driveRoles)
    .where(and(eq(driveRoles.id, customRoleId), eq(driveRoles.driveId, driveId)))
    .limit(1);
  return result.length > 0;
}
