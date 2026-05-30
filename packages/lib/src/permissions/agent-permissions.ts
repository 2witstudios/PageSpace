import { db } from '@pagespace/db/db';
import { eq, and, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { resolveRolePermissions } from './resolve-role-permissions';
import { fetchCustomRolePermissions } from './membership-queries';
import type { PermissionLevel, PageWithPermissions } from './permissions';

async function fetchAgentMembership(agentPageId: string, driveId: string) {
  const rows = await db
    .select()
    .from(driveAgentMembers)
    .where(and(eq(driveAgentMembers.agentPageId, agentPageId), eq(driveAgentMembers.driveId, driveId)))
    .limit(1);
  return rows[0] ?? null;
}

async function fetchPageDriveAndPrivacy(
  targetPageId: string,
): Promise<{ driveId: string; isPrivate: boolean }> {
  const rows = await db
    .select({ driveId: pages.driveId, isPrivate: pages.isPrivate })
    .from(pages)
    .where(eq(pages.id, targetPageId))
    .limit(1);
  // No page row ⇒ treat targetPageId as a drive id (drive-as-root-node pattern).
  return rows[0] ?? { driveId: targetPageId, isPrivate: false };
}

export async function getAgentAccessLevel(
  agentPageId: string,
  targetPageId: string,
): Promise<PermissionLevel | null> {
  const { driveId, isPrivate } = await fetchPageDriveAndPrivacy(targetPageId);
  const membership = await fetchAgentMembership(agentPageId, driveId);
  if (!membership) return null;

  const customPerms = membership.customRoleId
    ? await fetchCustomRolePermissions(membership.customRoleId, driveId)
    : null;

  // Mirror user-side membership semantics: a plain MEMBER (no resolvable custom
  // role) sees only non-private pages, so an agent never out-reads the member who
  // granted it. ADMIN/OWNER and explicit custom-role grants keep the same parity
  // they already have with the user-side paths.
  if (!customPerms && membership.role !== 'ADMIN' && membership.role !== 'OWNER' && isPrivate) {
    return null;
  }

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

  if (role === 'ADMIN' || role === 'OWNER') {
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
    const customPerms = await fetchCustomRolePermissions(customRoleId, driveId);
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
    // Custom role with no resolvable permissions ⇒ no access.
    return [];
  }

  // Plain MEMBER (no custom role): view-only over the drive's non-private pages —
  // the same set a plain MEMBER *user* sees, consistent with getAgentAccessLevel
  // denying a plain member access to private pages.
  const memberPages = await db
    .select({
      id: pages.id,
      title: pages.title,
      type: pages.type,
      parentId: pages.parentId,
      position: pages.position,
      isTrashed: pages.isTrashed,
    })
    .from(pages)
    .where(and(eq(pages.driveId, driveId), eq(pages.isTrashed, false), eq(pages.isPrivate, false)));

  return memberPages.map((p) => ({
    ...p,
    permissions: resolveRolePermissions('MEMBER', null, p.id),
  }));
}
