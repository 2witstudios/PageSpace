import { db } from '@pagespace/db/db';
import { eq, and, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveAgentMembers, driveRoles } from '@pagespace/db/schema/members';
import type { PermissionLevel, PageWithPermissions } from './permissions';

export async function getAgentAccessLevel(
  agentPageId: string,
  targetPageId: string,
): Promise<PermissionLevel | null> {
  const page = await db
    .select({ driveId: pages.driveId })
    .from(pages)
    .where(eq(pages.id, targetPageId))
    .limit(1);

  if (page.length === 0) return null;
  const { driveId } = page[0];

  const membership = await db
    .select()
    .from(driveAgentMembers)
    .where(
      and(
        eq(driveAgentMembers.agentPageId, agentPageId),
        eq(driveAgentMembers.driveId, driveId),
      ),
    )
    .limit(1);

  if (membership.length === 0) return null;

  const { role, customRoleId } = membership[0];

  if (role === 'ADMIN') {
    return { canView: true, canEdit: true, canShare: true, canDelete: true };
  }

  if (customRoleId) {
    const driveRole = await db
      .select({ permissions: driveRoles.permissions })
      .from(driveRoles)
      .where(eq(driveRoles.id, customRoleId))
      .limit(1);

    if (driveRole.length > 0) {
      const perms = driveRole[0].permissions[targetPageId];
      return {
        canView: perms?.canView ?? false,
        canEdit: perms?.canEdit ?? false,
        canShare: perms?.canShare ?? false,
        canDelete: false,
      };
    }
  }

  return { canView: true, canEdit: false, canShare: false, canDelete: false };
}

export async function hasAgentDriveMembership(agentPageId: string, driveId: string): Promise<boolean> {
  const row = await db
    .select({ id: driveAgentMembers.id })
    .from(driveAgentMembers)
    .where(and(eq(driveAgentMembers.agentPageId, agentPageId), eq(driveAgentMembers.driveId, driveId)))
    .limit(1);
  return row.length > 0;
}

export async function getAgentAccessiblePagesInDrive(
  agentPageId: string,
  driveId: string,
): Promise<PageWithPermissions[]> {
  const membership = await db
    .select()
    .from(driveAgentMembers)
    .where(
      and(
        eq(driveAgentMembers.agentPageId, agentPageId),
        eq(driveAgentMembers.driveId, driveId),
      ),
    )
    .limit(1);

  if (membership.length === 0) return [];

  const { role, customRoleId } = membership[0];

  if (role === 'ADMIN') {
    const allPages = await db
      .select({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        parentId: pages.parentId,
        position: pages.position,
        isTrashed: pages.isTrashed,
      })
      .from(pages)
      .where(and(eq(pages.driveId, driveId), eq(pages.isTrashed, false)));

    return allPages.map((p) => ({
      ...p,
      permissions: { canView: true, canEdit: true, canShare: true, canDelete: true },
    }));
  }

  if (customRoleId) {
    const driveRole = await db
      .select({ permissions: driveRoles.permissions })
      .from(driveRoles)
      .where(eq(driveRoles.id, customRoleId))
      .limit(1);

    if (driveRole.length > 0) {
      const rolePerms = driveRole[0].permissions;
      const visiblePageIds = Object.entries(rolePerms)
        .filter(([, p]) => p.canView)
        .map(([id]) => id);

      if (visiblePageIds.length === 0) return [];

      const visiblePages = await db
        .select({
          id: pages.id,
          title: pages.title,
          type: pages.type,
          parentId: pages.parentId,
          position: pages.position,
          isTrashed: pages.isTrashed,
        })
        .from(pages)
        .where(
          and(
            inArray(pages.id, visiblePageIds),
            eq(pages.driveId, driveId),
            eq(pages.isTrashed, false),
          ),
        );

      return visiblePages.map((p) => ({
        ...p,
        permissions: {
          canView: rolePerms[p.id]?.canView ?? false,
          canEdit: rolePerms[p.id]?.canEdit ?? false,
          canShare: rolePerms[p.id]?.canShare ?? false,
          canDelete: false,
        },
      }));
    }
  }

  return [];
}
