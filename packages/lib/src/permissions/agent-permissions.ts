import { db } from '@pagespace/db/db';
import { eq, and, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveAgentMembers, driveRoles } from '@pagespace/db/schema/members';
import type { PermissionLevel, PageWithPermissions } from './permissions';

/**
 * Get agent access level for a specific page.
 *
 * Returns null if the agent has no drive_agent_members row for the page's drive
 * (caller should fall back to user permissions). Otherwise returns the effective
 * PermissionLevel based on the agent's role.
 */
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
      if (perms) {
        return {
          canView: perms.canView,
          canEdit: perms.canEdit,
          canShare: perms.canShare,
          canDelete: false,
        };
      }
    }
  }

  // MEMBER with no customRole — read-only access
  return { canView: true, canEdit: false, canShare: false, canDelete: false };
}

export async function canAgentViewPage(agentPageId: string, pageId: string): Promise<boolean> {
  const perms = await getAgentAccessLevel(agentPageId, pageId);
  return perms?.canView ?? false;
}

export async function canAgentEditPage(agentPageId: string, pageId: string): Promise<boolean> {
  const perms = await getAgentAccessLevel(agentPageId, pageId);
  return perms?.canEdit ?? false;
}

export async function canAgentDeletePage(agentPageId: string, pageId: string): Promise<boolean> {
  const perms = await getAgentAccessLevel(agentPageId, pageId);
  return perms?.canDelete ?? false;
}

/**
 * Get all pages an agent can access in a drive.
 *
 * Returns null if the agent has no drive_agent_members row (caller should fall
 * through to user permissions). Returns an empty array if the agent has a
 * MEMBER row with no customRole (membership exists but no enumerable pages).
 */
export async function getAgentAccessiblePagesInDrive(
  agentPageId: string,
  driveId: string,
): Promise<PageWithPermissions[] | null> {
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
        .where(and(inArray(pages.id, visiblePageIds), eq(pages.isTrashed, false)));

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

  // MEMBER with no customRole — has membership but no enumerable pages
  return [];
}
