import { db } from '@pagespace/db/db';
import { eq, and, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { resolveRolePermissions } from './resolve-role-permissions';
import { fetchDriveIdForPage, fetchCustomRolePermissions } from './membership-queries';
import type { PermissionLevel, PageWithPermissions } from './permissions';

async function fetchAgentMembership(agentPageId: string, driveId: string) {
  const rows = await db
    .select()
    .from(driveAgentMembers)
    .where(and(eq(driveAgentMembers.agentPageId, agentPageId), eq(driveAgentMembers.driveId, driveId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAgentAccessLevel(
  agentPageId: string,
  targetPageId: string,
): Promise<PermissionLevel | null> {
  const driveId = await fetchDriveIdForPage(targetPageId);
  const membership = await fetchAgentMembership(agentPageId, driveId);
  if (!membership) return null;

  const customPerms = membership.customRoleId
    ? await fetchCustomRolePermissions(membership.customRoleId)
    : null;

  return resolveRolePermissions(membership.role, customPerms, targetPageId);
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
  const membership = await fetchAgentMembership(agentPageId, driveId);
  if (!membership) return [];

  const { role, customRoleId } = membership;

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
    const customPerms = await fetchCustomRolePermissions(customRoleId);
    if (customPerms) {
      const visiblePageIds = Object.entries(customPerms)
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
        .where(and(inArray(pages.id, visiblePageIds), eq(pages.driveId, driveId), eq(pages.isTrashed, false)));

      return visiblePages.map((p) => ({
        ...p,
        permissions: resolveRolePermissions('MEMBER', customPerms, p.id),
      }));
    }
  }

  return [];
}
