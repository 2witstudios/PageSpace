import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
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

export async function fetchCustomRolePermissions(customRoleId: string): Promise<CustomRolePerms | null> {
  const result = await db
    .select({ permissions: driveRoles.permissions })
    .from(driveRoles)
    .where(eq(driveRoles.id, customRoleId))
    .limit(1);
  return result.length > 0 ? result[0].permissions : null;
}
