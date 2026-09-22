import { db } from '@pagespace/db/db';
import { eq, and, isNotNull, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveRoles, driveMembers } from '@pagespace/db/schema/members';

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

export async function fetchDriveIdForPage(targetPageId: string): Promise<{ driveId: string; isPrivate: boolean }> {
  const page = await db
    .select({ driveId: pages.driveId, isPrivate: pages.isPrivate })
    .from(pages)
    .where(eq(pages.id, targetPageId))
    .limit(1);
  // If no page exists, treat targetPageId itself as a drive ID (drive-as-root-node pattern).
  return page.length > 0
    ? { driveId: page[0].driveId, isPrivate: page[0].isPrivate ?? false }
    : { driveId: targetPageId, isPrivate: false };
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

// Returns the customRoleId assigned to the user in this drive, or null if none / not a member.
export async function getMemberCustomRoleId(driveId: string, userId: string): Promise<string | null> {
  const result = await db
    .select({ customRoleId: driveMembers.customRoleId })
    .from(driveMembers)
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt)))
    .limit(1);
  return result.length > 0 ? (result[0].customRoleId ?? null) : null;
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

/**
 * The drive-wide canEdit rule (#2627) as one pure decision. Every caller —
 * {@link resolveDriveWideCanEdit} (the drives DTO flag and the session
 * drive-root check) and the token resolvers' drive-root branch
 * (resolveExplicitAppRoleAccess) — decides through this, so they cannot drift.
 *
 * `customRole` must already be bound to the drive being decided: pass null when
 * the role id is set but did not resolve there (unresolvable, deleted, or
 * another drive's role), which fails closed.
 */
export function driveWideCanEdit(input: {
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  hasCustomRole: boolean;
  customRole: { driveWidePermissions: PagePerm | null } | null;
}): boolean {
  if (input.role === 'OWNER' || input.role === 'ADMIN' || !input.hasCustomRole) return true;
  return input.customRole?.driveWidePermissions?.canEdit === true;
}

export interface DriveWideEditEntry {
  driveId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  customRoleId?: string | null;
}

/**
 * The single drive-wide canEdit rule (#2627).
 *
 * OWNER, ADMIN and a plain MEMBER (no custom role) can edit drive-wide — and
 * therefore create root-level pages, which the API authorizes as edit on the
 * drive-as-root. A custom role bounds a MEMBER to what the role's
 * driveWidePermissions explicitly grant; an unresolvable role or a null
 * driveWidePermissions fails closed. The token resolvers (getAppAccessLevel /
 * getScopedAccessLevel) decide the drive root through the same pure
 * {@link driveWideCanEdit}, so the drives DTO flag, the session check and the
 * token checks can never disagree.
 *
 * Callers pass ONE entry per drive the user actually owns or holds a
 * membership in. Page-collaborator-only drives are NOT memberships and must
 * not be passed — they fail closed at the call site.
 *
 * A custom role only counts for the drive it belongs to — the same binding
 * fetchCustomRolePermissions enforces — so a membership pointing at another
 * drive's role fails closed.
 *
 * Batched: one query regardless of how many custom roles are involved.
 */
export async function resolveDriveWideCanEdit(
  entries: DriveWideEditEntry[],
): Promise<Map<string, boolean>> {
  const customRoleIds = [
    ...new Set(entries.filter((entry) => entry.customRoleId).map((entry) => entry.customRoleId as string)),
  ];

  const roles = new Map<string, { driveId: string; driveWidePermissions: PagePerm | null }>();
  if (customRoleIds.length > 0) {
    const rows = await db
      .select({ id: driveRoles.id, driveId: driveRoles.driveId, driveWidePermissions: driveRoles.driveWidePermissions })
      .from(driveRoles)
      .where(inArray(driveRoles.id, customRoleIds))
      .limit(customRoleIds.length);
    for (const row of rows) {
      roles.set(row.id, {
        driveId: row.driveId,
        driveWidePermissions: (row.driveWidePermissions as PagePerm | null) ?? null,
      });
    }
  }

  const result = new Map<string, boolean>();
  for (const entry of entries) {
    // A role bound to another drive counts as unresolved: it fails closed.
    const role = entry.customRoleId ? roles.get(entry.customRoleId) : undefined;
    result.set(entry.driveId, driveWideCanEdit({
      role: entry.role,
      hasCustomRole: !!entry.customRoleId,
      customRole: role?.driveId === entry.driveId ? role : null,
    }));
  }
  return result;
}
