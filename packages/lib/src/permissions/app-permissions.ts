import { db } from '@pagespace/db/db';
import { eq, and, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { mcpTokenDrives } from '@pagespace/db/schema/members';
import { resolveRolePermissions } from './resolve-role-permissions';
import { fetchDriveIdForPage, fetchCustomRolePermissions, resolveCustomRolePermissions } from './membership-queries';
import type { PermissionLevel, PageWithPermissions } from './permissions';

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
  const { driveId, isPrivate } = await fetchDriveIdForPage(targetPageId);
  const membership = await fetchAppMembership(tokenId, driveId);
  if (!membership) return null;

  const role = membership.customRoleId
    ? await fetchCustomRolePermissions(membership.customRoleId, driveId)
    : null;

  // Mirror user-side membership semantics: a plain MEMBER (no resolvable custom
  // role) sees only non-private pages, so a token never out-reads the member who
  // granted it. ADMIN/OWNER and explicit custom-role grants keep the same parity
  // they already have with the user-side paths.
  if (!role && membership.role !== 'ADMIN' && membership.role !== 'OWNER' && isPrivate) {
    return null;
  }

  if (role && membership.role !== 'ADMIN' && membership.role !== 'OWNER') {
    const resolved = resolveCustomRolePermissions(role, targetPageId);
    if (resolved !== null) {
      // driveWidePermissions fallback must not grant access to private pages
      if (isPrivate && role.permissions[targetPageId] === undefined) return null;
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

export interface AppDriveMembership {
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  customRoleId: string | null;
}

export async function getAppDriveMembership(
  tokenId: string,
  driveId: string,
): Promise<AppDriveMembership | null> {
  const membership = await fetchAppMembership(tokenId, driveId);
  if (!membership) return null;
  return { role: membership.role, customRoleId: membership.customRoleId ?? null };
}

/**
 * Drive-level permission for a token, used where there is no specific target
 * page (drive listing, drive-root creation gates). OWNER/ADMIN → full access;
 * plain MEMBER → view-only; custom role → its driveWidePermissions (never
 * canDelete), or no access at all when the role grants nothing drive-wide.
 */
export async function getAppDriveAccessLevel(
  tokenId: string,
  driveId: string,
): Promise<PermissionLevel | null> {
  const membership = await fetchAppMembership(tokenId, driveId);
  if (!membership) return null;

  if (membership.role === 'ADMIN' || membership.role === 'OWNER') {
    return { canView: true, canEdit: true, canShare: true, canDelete: true };
  }

  if (membership.customRoleId) {
    const role = await fetchCustomRolePermissions(membership.customRoleId, driveId);
    if (role) {
      const driveWide = role.driveWidePermissions;
      if (!driveWide) {
        return { canView: false, canEdit: false, canShare: false, canDelete: false };
      }
      return { ...driveWide, canDelete: false };
    }
    // Custom role with no resolvable permissions ⇒ no access.
    return { canView: false, canEdit: false, canShare: false, canDelete: false };
  }

  return { canView: true, canEdit: false, canShare: false, canDelete: false };
}

/**
 * All pages in a drive visible to the token, with the token's own permissions.
 * Mirrors getAgentAccessiblePagesInDrive — the token is its own drive member,
 * independent of the owning user's access.
 */
export async function getAppAccessiblePagesInDrive(
  tokenId: string,
  driveId: string,
): Promise<PageWithPermissions[]> {
  const membership = await fetchAppMembership(tokenId, driveId);
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
    const customRole = await fetchCustomRolePermissions(customRoleId, driveId);
    if (customRole) {
      const { permissions: rolePerms, driveWidePermissions } = customRole;

      if (driveWidePermissions?.canView) {
        // Drive-wide view access: start with all non-private pages at the drive-wide level
        const nonPrivatePages = await db
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

        const pageMap = new Map<string, PageWithPermissions>();
        for (const p of nonPrivatePages) {
          pageMap.set(p.id, { ...p, permissions: { ...driveWidePermissions, canDelete: false } });
        }

        // Per-page explicit entries add private pages and override drive-wide perms
        const explicitIds = Object.entries(rolePerms).filter(([, p]) => p.canView).map(([id]) => id);
        if (explicitIds.length > 0) {
          const explicitPages = await db
            .select({
              id: pages.id,
              title: pages.title,
              type: pages.type,
              parentId: pages.parentId,
              position: pages.position,
              isTrashed: pages.isTrashed,
            })
            .from(pages)
            .where(and(inArray(pages.id, explicitIds), eq(pages.driveId, driveId), eq(pages.isTrashed, false)));
          for (const p of explicitPages) {
            pageMap.set(p.id, { ...p, permissions: { ...rolePerms[p.id]!, canDelete: false } });
          }
        }
        // Explicit denials remove pages even if covered by drive-wide
        for (const [id, p] of Object.entries(rolePerms)) {
          if (!p.canView) pageMap.delete(id);
        }

        return Array.from(pageMap.values());
      }

      // No drive-wide view: only per-page explicit entries
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
        .where(and(inArray(pages.id, visiblePageIds), eq(pages.driveId, driveId), eq(pages.isTrashed, false)));

      return visiblePages.map((p) => ({
        ...p,
        permissions: { ...rolePerms[p.id]!, canDelete: false },
      }));
    }
    // Custom role with no resolvable permissions ⇒ no access.
    return [];
  }

  // Plain MEMBER (no custom role): view-only over the drive's non-private pages —
  // the same set a plain MEMBER *user* sees, consistent with getAppAccessLevel
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
