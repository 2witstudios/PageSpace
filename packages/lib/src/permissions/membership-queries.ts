import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveRoles } from '@pagespace/db/schema/members';

type CustomRolePerms = Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;

export async function fetchDriveIdForPage(targetPageId: string): Promise<string> {
  const page = await db
    .select({ driveId: pages.driveId })
    .from(pages)
    .where(eq(pages.id, targetPageId))
    .limit(1);
  return page.length > 0 ? page[0].driveId : targetPageId;
}

// driveId is required to prevent a custom role from one drive being applied to another.
export async function fetchCustomRolePermissions(
  customRoleId: string,
  driveId: string,
): Promise<CustomRolePerms | null> {
  const result = await db
    .select({ permissions: driveRoles.permissions })
    .from(driveRoles)
    .where(and(eq(driveRoles.id, customRoleId), eq(driveRoles.driveId, driveId)))
    .limit(1);
  return result.length > 0 ? result[0].permissions : null;
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
