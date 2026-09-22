import { db } from '@pagespace/db/db';
import { eq, and, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { mcpTokenDrives } from '@pagespace/db/schema/members';
import { mcpTokens } from '@pagespace/db/schema/auth';
import {
  getUserAccessLevel,
  isUserDriveMember,
  getUserAccessiblePagesInDriveWithDetails,
} from './permissions';
import { driveWideCanEdit, fetchCustomRolePermissions, resolveCustomRolePermissions, type CustomRolePerms, type PagePerm } from './membership-queries';
import type { PermissionLevel, PageWithPermissions } from './permissions';
import type { DriveScopeRow } from '../auth/oauth/scopes';

/**
 * App-member permission resolution for MCP tokens.
 *
 * Model: a key is the user it belongs to, narrowed by scope, optionally
 * weakened by an explicit role.
 *  - role === NULL  → INHERIT: the token resolves with its OWNER's access in
 *    that drive (a scoped key "is me, only here").
 *  - explicit role  → means EXACTLY what the same role means for a human
 *    drive member (parity oracle: getUserAccessLevel) — channels editable by
 *    members, drive-root creation for members, admin sees private pages, etc.
 *    — and never MORE than the token's user can do right now: every explicit
 *    answer is intersected with the user's live access (see
 *    {@link intersectPermissionLevels}). A demoted user's ADMIN key is capped at
 *    what the user now is; a revoked private-page grant or a removed custom
 *    role reaches every credential the user holds on the next request.
 */

export type AppMemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';

interface AppMembershipContext {
  role: AppMemberRole | null;
  customRoleId: string | null;
  ownerUserId: string;
}

async function fetchAppMembershipContext(
  tokenId: string,
  driveId: string,
): Promise<AppMembershipContext | null> {
  const rows = await db
    .select({
      role: mcpTokenDrives.role,
      customRoleId: mcpTokenDrives.customRoleId,
      ownerUserId: mcpTokens.userId,
    })
    .from(mcpTokenDrives)
    .innerJoin(mcpTokens, eq(mcpTokenDrives.tokenId, mcpTokens.id))
    .where(and(eq(mcpTokenDrives.tokenId, tokenId), eq(mcpTokenDrives.driveId, driveId)))
    .limit(1);
  return rows[0] ?? null;
}

interface PageTarget {
  driveId: string;
  isPrivate: boolean;
  pageType: string | null;
  /** No page row matched — the id is treated as a drive id (drive-as-root-node). */
  isDriveRoot: boolean;
}

export async function fetchPageTarget(targetPageId: string): Promise<PageTarget> {
  const rows = await db
    .select({ driveId: pages.driveId, isPrivate: pages.isPrivate, type: pages.type })
    .from(pages)
    .where(eq(pages.id, targetPageId))
    .limit(1);
  if (rows.length === 0) {
    return { driveId: targetPageId, isPrivate: false, pageType: null, isDriveRoot: true };
  }
  return {
    driveId: rows[0].driveId,
    isPrivate: rows[0].isPrivate ?? false,
    pageType: rows[0].type,
    isDriveRoot: false,
  };
}

/**
 * Pure parity resolver for EXPLICIT roles. Mirrors getUserAccessLevel
 * (permissions.ts:92-280) cell for cell:
 *  - drive-root target: ANY membership → view+edit (members may create root
 *    pages); share/delete only for ADMIN/OWNER; customRoleId is not consulted
 *    at the drive root, same as the user branch.
 *  - ADMIN/OWNER → full access, including private pages.
 *  - custom role: per-page grant wins; driveWidePermissions fallback (never on
 *    private pages); no grant at all → all-false; canDelete always false.
 *  - plain MEMBER: private → null; otherwise view-only EXCEPT channels, which
 *    grant canEdit so members can post ("Discord/Slack semantics").
 */
export function resolveExplicitAppRoleAccess(input: {
  role: AppMemberRole;
  customRole: { permissions: CustomRolePerms; driveWidePermissions: PagePerm | null } | null;
  /** True when the custom role id was set but did not resolve to a role in this drive. */
  customRoleUnresolved: boolean;
  targetPageId: string;
  pageType: string | null;
  isPrivate: boolean;
  isDriveRoot: boolean;
}): PermissionLevel | null {
  const { role, customRole, customRoleUnresolved, targetPageId, pageType, isPrivate, isDriveRoot } = input;
  const isAdminLike = role === 'ADMIN' || role === 'OWNER';

  if (isDriveRoot) {
    // Root-page create is edit on the drive root, decided by the one drive-wide
    // canEdit rule (#2627) — the answer a human member bound by the same role
    // gets from getUserAccessLevel. A custom role that did not resolve in this
    // drive grants nothing.
    if (!isAdminLike && customRoleUnresolved) {
      return { canView: false, canEdit: false, canShare: false, canDelete: false };
    }
    return {
      canView: true,
      canEdit: driveWideCanEdit({ role, hasCustomRole: customRole !== null || customRoleUnresolved, customRole }),
      canShare: isAdminLike,
      canDelete: isAdminLike,
    };
  }

  if (isAdminLike) {
    return { canView: true, canEdit: true, canShare: true, canDelete: true };
  }

  if (customRole) {
    const resolved = resolveCustomRolePermissions(customRole, targetPageId);
    if (resolved !== null) {
      // driveWidePermissions fallback must not grant access to private pages
      if (isPrivate && customRole.permissions[targetPageId] === undefined) return null;
      return resolved.canView ? { ...resolved, canDelete: false } : null;
    }
    // No per-page or drive-wide grant — custom roles limit access to explicitly listed pages
    return { canView: false, canEdit: false, canShare: false, canDelete: false };
  }
  if (customRoleUnresolved) {
    // Custom role id set but not resolvable in this drive ⇒ no access.
    return { canView: false, canEdit: false, canShare: false, canDelete: false };
  }

  // Plain MEMBER: mirrors the user member rule — no private pages, view-only,
  // channels editable so members can post.
  if (isPrivate) return null;
  return { canView: true, canEdit: pageType === 'CHANNEL', canShare: false, canDelete: false };
}

/**
 * A credential never exceeds its user: the flag-wise AND of what an explicit
 * role grants and what the user can do right now. `null` from either side (no
 * access at all) is `null`. Pure.
 */
export function intersectPermissionLevels(
  granted: PermissionLevel | null,
  userLive: PermissionLevel | null,
): PermissionLevel | null {
  if (!granted || !userLive) return null;
  return {
    canView: granted.canView && userLive.canView,
    canEdit: granted.canEdit && userLive.canEdit,
    canShare: granted.canShare && userLive.canShare,
    canDelete: granted.canDelete && userLive.canDelete,
  };
}

export async function getAppAccessLevel(
  tokenId: string,
  targetPageId: string,
): Promise<PermissionLevel | null> {
  const target = await fetchPageTarget(targetPageId);
  const membership = await fetchAppMembershipContext(tokenId, target.driveId);
  if (!membership) return null;

  // Inherit: the token acts as its owner in this drive.
  if (membership.role === null) {
    return getUserAccessLevel(membership.ownerUserId, targetPageId);
  }

  const customRole = membership.customRoleId
    ? await fetchCustomRolePermissions(membership.customRoleId, target.driveId)
    : null;

  const granted = resolveExplicitAppRoleAccess({
    role: membership.role,
    customRole,
    customRoleUnresolved: !!membership.customRoleId && !customRole,
    targetPageId,
    pageType: target.pageType,
    isPrivate: target.isPrivate,
    isDriveRoot: target.isDriveRoot,
  });
  return intersectPermissionLevels(granted, await getUserAccessLevel(membership.ownerUserId, targetPageId));
}

/**
 * Whether the token has usable access to the drive. An inherit row counts only
 * while its OWNER still has drive access — a dangling inherit row (owner
 * removed/demoted out of the drive) grants nothing.
 */
export async function hasAppDriveMembership(tokenId: string, driveId: string): Promise<boolean> {
  const membership = await fetchAppMembershipContext(tokenId, driveId);
  if (!membership) return false;
  if (membership.role === null) {
    return isUserDriveMember(membership.ownerUserId, driveId);
  }
  return true;
}

export interface AppDriveMembership {
  /** NULL = inherit the owner's access. */
  role: AppMemberRole | null;
  customRoleId: string | null;
  ownerUserId: string;
}

export async function getAppDriveMembership(
  tokenId: string,
  driveId: string,
): Promise<AppDriveMembership | null> {
  const membership = await fetchAppMembershipContext(tokenId, driveId);
  if (!membership) return null;
  return {
    role: membership.role,
    customRoleId: membership.customRoleId ?? null,
    ownerUserId: membership.ownerUserId,
  };
}

/**
 * Drive-level access. Inherit → the owner's drive-root access (user rule);
 * explicit → user drive-root parity: any membership gets view+edit, ADMIN/
 * OWNER add share+delete.
 */
export async function getAppDriveAccessLevel(
  tokenId: string,
  driveId: string,
): Promise<PermissionLevel | null> {
  const membership = await fetchAppMembershipContext(tokenId, driveId);
  if (!membership) return null;

  if (membership.role === null) {
    return getUserAccessLevel(membership.ownerUserId, driveId);
  }

  const isAdminLike = membership.role === 'ADMIN' || membership.role === 'OWNER';
  return intersectPermissionLevels(
    { canView: true, canEdit: true, canShare: isAdminLike, canDelete: isAdminLike },
    await getUserAccessLevel(membership.ownerUserId, driveId),
  );
}

/**
 * All pages in a drive visible to the token, with the token's own permissions.
 * Inherit → exactly the owner's accessible set. Explicit roles mirror the
 * corresponding user role (plain MEMBER additionally gets canEdit on channels,
 * matching getAppAccessLevel — the user-side LISTING function lacks that
 * exception, but access-level semantics are what gate actions).
 */
export async function getAppAccessiblePagesInDrive(
  tokenId: string,
  driveId: string,
): Promise<PageWithPermissions[]> {
  const membership = await fetchAppMembershipContext(tokenId, driveId);
  if (!membership) return [];
  return resolveAccessiblePagesForMembership(membership, driveId);
}

/**
 * Shared body for {@link getAppAccessiblePagesInDrive} (MCP token, membership
 * sourced from a `mcp_token_drives` DB row) and
 * {@link getScopedAccessiblePagesInDrive} (OAuth token, membership sourced
 * from a parsed `ScopeSet` — no DB row exists for it). Both entry points
 * resolve membership their own way, then defer to this one body so the
 * listing logic (drive-wide fallback, per-page overrides, etc.) is never
 * duplicated between token types.
 */
async function resolveAccessiblePagesForMembership(
  membership: AppMembershipContext,
  driveId: string,
): Promise<PageWithPermissions[]> {
  if (membership.role === null) {
    return getUserAccessiblePagesInDriveWithDetails(membership.ownerUserId, driveId);
  }
  const granted = await resolveExplicitRolePagesInDrive({ ...membership, role: membership.role }, driveId);
  if (granted.length === 0) return granted;
  return intersectWithUserPages(granted, membership.ownerUserId, driveId);
}

/**
 * The listing side of {@link intersectPermissionLevels}: keep only the pages the
 * user can see right now, AND-ing each flag with the user's own. The user
 * LISTING under-reports a member's channel canEdit (see
 * getAppAccessiblePagesInDrive), so channel pages take the user's access LEVEL —
 * the semantics that gate actions — instead of the listing row.
 */
async function intersectWithUserPages(
  granted: PageWithPermissions[],
  ownerUserId: string,
  driveId: string,
): Promise<PageWithPermissions[]> {
  const userPages = new Map(
    (await getUserAccessiblePagesInDriveWithDetails(ownerUserId, driveId)).map((p) => [p.id, p.permissions]),
  );
  const result: PageWithPermissions[] = [];
  for (const page of granted) {
    const userLive = page.type === 'CHANNEL'
      ? await getUserAccessLevel(ownerUserId, page.id)
      : userPages.get(page.id) ?? null;
    const level = intersectPermissionLevels(page.permissions, userLive);
    if (level?.canView) result.push({ ...page, permissions: level });
  }
  return result;
}

/** What an explicit role grants in the drive, before the user intersection. */
async function resolveExplicitRolePagesInDrive(
  membership: AppMembershipContext & { role: AppMemberRole },
  driveId: string,
): Promise<PageWithPermissions[]> {
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

  // Plain MEMBER: the drive's non-private pages, view-only except channels
  // (canEdit so members can post — parity with getAppAccessLevel).
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
    permissions: { canView: true, canEdit: p.type === 'CHANNEL', canShare: false, canDelete: false },
  }));
}

// ---------------------------------------------------------------------------
// OAuth-token entry points (Phase 1 task 10, ADR 0002 Decision 2).
//
// An OAuth access token's drive scope is a parsed `ScopeSet`, bridged to
// `DriveScopeRow[]` by `scopeSetToDriveScopes` — the exact `mcp_token_drives`
// row shape, but there is no DB row: the token id has no corresponding
// `mcp_token_drives` foreign key (that table's `tokenId` FK only points at
// `mcp_tokens`). These entry points source membership from the in-memory
// array instead of a DB join, then defer to the SAME resolver
// (`resolveExplicitAppRoleAccess`) and DB helpers (`fetchPageTarget`,
// `fetchCustomRolePermissions`, `getUserAccessLevel`) the MCP-token path
// uses, so a drive-narrowed OAuth token is indistinguishable in capability
// from an equivalent scoped MCP token.
// ---------------------------------------------------------------------------

function findScopeRow(driveScopes: DriveScopeRow[], driveId: string): DriveScopeRow | null {
  return driveScopes.find((row) => row.driveId === driveId) ?? null;
}

/**
 * The scope row for a drive, if it still grants anything.
 *
 * Grant-time authority is not resolution-time authority (ADR 0002 Decision 2):
 * an OAuth token's rows were frozen at consent, and there is no row to delete
 * when the user later stops being a member. So an EXPLICIT-role row counts only
 * while its user is still a member or owner of the drive — by whatever path
 * that membership ended (removal, leaving, transfer), the token loses the drive
 * at once, just as the user's explicit-role `mcp_token_drives` rows are deleted
 * on removal. An inherit row is returned as is: every consumer of an inherit row
 * already resolves the user's own live access.
 */
async function findLiveScopeRow(
  driveScopes: DriveScopeRow[],
  ownerUserId: string,
  driveId: string,
): Promise<DriveScopeRow | null> {
  const row = findScopeRow(driveScopes, driveId);
  if (!row) return null;
  if (row.role !== null && !(await isUserDriveMember(ownerUserId, driveId))) return null;
  return row;
}

export async function getScopedAccessLevel(
  driveScopes: DriveScopeRow[],
  ownerUserId: string,
  targetPageId: string,
): Promise<PermissionLevel | null> {
  const target = await fetchPageTarget(targetPageId);
  const row = await findLiveScopeRow(driveScopes, ownerUserId, target.driveId);
  if (!row) return null;

  if (row.role === null) {
    return getUserAccessLevel(ownerUserId, targetPageId);
  }

  const customRole = row.customRoleId
    ? await fetchCustomRolePermissions(row.customRoleId, target.driveId)
    : null;

  const granted = resolveExplicitAppRoleAccess({
    role: row.role,
    customRole,
    customRoleUnresolved: !!row.customRoleId && !customRole,
    targetPageId,
    pageType: target.pageType,
    isPrivate: target.isPrivate,
    isDriveRoot: target.isDriveRoot,
  });
  return intersectPermissionLevels(granted, await getUserAccessLevel(ownerUserId, targetPageId));
}

/**
 * Whether the scope has usable access to the drive: a row for it, and the
 * token's user still a member or owner — for an inherit row because it IS the
 * user's access (mirrors hasAppDriveMembership), for an explicit row because
 * the grant ends with the membership it was consented under.
 */
export async function hasScopedDriveMembership(
  driveScopes: DriveScopeRow[],
  ownerUserId: string,
  driveId: string,
): Promise<boolean> {
  const row = findScopeRow(driveScopes, driveId);
  if (!row) return false;
  return isUserDriveMember(ownerUserId, driveId);
}

/**
 * The row's role as granted, or null when the scope names no such drive or an
 * explicit-role row has outlived its user's membership (see findLiveScopeRow).
 */
export async function getScopedDriveMembership(
  driveScopes: DriveScopeRow[],
  ownerUserId: string,
  driveId: string,
): Promise<{ role: 'ADMIN' | 'MEMBER' | null; customRoleId: string | null } | null> {
  const row = await findLiveScopeRow(driveScopes, ownerUserId, driveId);
  if (!row) return null;
  return { role: row.role, customRoleId: row.customRoleId };
}

/**
 * Drive-level access. Inherit → the owner's drive-root access (user rule);
 * explicit → user drive-root parity: any membership gets view+edit, ADMIN
 * adds share+delete. Mirrors getAppDriveAccessLevel (OAuth's grammar has no
 * OWNER role — scopeSetToDriveScopes only ever emits 'ADMIN' | 'MEMBER' | null).
 */
export async function getScopedDriveAccessLevel(
  driveScopes: DriveScopeRow[],
  ownerUserId: string,
  driveId: string,
): Promise<PermissionLevel | null> {
  const row = await findLiveScopeRow(driveScopes, ownerUserId, driveId);
  if (!row) return null;

  if (row.role === null) {
    return getUserAccessLevel(ownerUserId, driveId);
  }

  const isAdminLike = row.role === 'ADMIN';
  return intersectPermissionLevels(
    { canView: true, canEdit: true, canShare: isAdminLike, canDelete: isAdminLike },
    await getUserAccessLevel(ownerUserId, driveId),
  );
}

/**
 * All pages in a drive visible to the OAuth-scoped principal. Delegates to
 * the same body getAppAccessiblePagesInDrive uses once membership is resolved.
 */
export async function getScopedAccessiblePagesInDrive(
  driveScopes: DriveScopeRow[],
  ownerUserId: string,
  driveId: string,
): Promise<PageWithPermissions[]> {
  const row = await findLiveScopeRow(driveScopes, ownerUserId, driveId);
  if (!row) return [];

  const membership: AppMembershipContext = { role: row.role, customRoleId: row.customRoleId, ownerUserId };
  return resolveAccessiblePagesForMembership(membership, driveId);
}
