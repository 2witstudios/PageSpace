/**
 * FROZEN COPY of the sibling drive resolvers B7b routes through the shared org-aware membership, as
 * they were on pu/org-wallets at de988390e (after B7, before B7b), with only the names prefixed
 * `legacy` and the imports adjusted. Do not edit or "fix" these bodies: they are the reference the
 * dark-flag equivalence test compares the live resolvers against.
 */
import { db } from '@pagespace/db/db';
import { and, eq, or, isNull, isNotNull, gt, inArray } from '@pagespace/db/operators';
import { calendarEventDrives } from '@pagespace/db/schema/calendar';
import { pages, drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { driveMembers, pagePermissions, driveRoles } from '@pagespace/db/schema/members';
import { loggers } from '../../../logging/logger-config';
import { fetchCustomRolePermissions, resolveCustomRolePermissions } from '../../membership-queries';
import type { DrivePermissionLevel, PagePermissionRow, PageWithPermissions, PermissionLevel } from '../../permissions';
import type { PermissionMutationError } from '../../permission-mutations';
import { getDriveRecipientUserIds, type DriveAccessResult } from '../../../services/drive-member-service';
import type { DriveRoleAccessInfo } from '../../../services/drive-role-service';
import type { DriveMembership } from '../../../agent-workspaces/decide-workspace-access';

const LEGACY_VIEWER_BATCH_SIZE = 200;

interface PageForSharing {
  pageId: string;
  driveId: string;
  driveKind: string | null;
}

/**
 * Get all drive IDs that a user has access to
 * Includes owned drives, member drives, and drives with page permissions
 */
export async function legacyGetDriveIdsForUser(userId: string): Promise<string[]> {
  const driveIdSet = new Set<string>();

  const ownedDrives = await db.select({ id: drives.id })
    .from(drives)
    .where(eq(drives.ownerId, userId));

  for (const drive of ownedDrives) {
    driveIdSet.add(drive.id);
  }

  const memberDrives = await db.select({ driveId: driveMembers.driveId })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt),
    ));

  for (const membership of memberDrives) {
    driveIdSet.add(membership.driveId);
  }

  const pageDrives = await db.select({ driveId: pages.driveId })
    .from(pagePermissions)
    .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
    .where(and(
      eq(pagePermissions.userId, userId),
      eq(pagePermissions.canView, true),
      or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
    ));

  for (const page of pageDrives) {
    if (page.driveId) {
      driveIdSet.add(page.driveId);
    }
  }

  return Array.from(driveIdSet);
}

/**
 * Check if user is owner or admin of a drive
 */
export async function legacyIsDriveOwnerOrAdmin(
  userId: string,
  driveId: string
): Promise<boolean> {
  const drive = await db.select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  if (drive.length > 0 && drive[0].ownerId === userId) {
    return true;
  }

  const membership = await db.select()
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId),
      eq(driveMembers.role, 'ADMIN'),
      isNotNull(driveMembers.acceptedAt)
    ))
    .limit(1);

  return membership.length > 0;
}

/**
 * Check if user is a member of a drive (accepted members only)
 */
export async function legacyIsUserDriveMember(
  userId: string,
  driveId: string
): Promise<boolean> {
  const drive = await db.select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  if (drive.length > 0 && drive[0].ownerId === userId) {
    return true;
  }

  const membership = await db.select()
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt)
    ))
    .limit(1);

  return membership.length > 0;
}

/**
 * Get all pages a user has access to in a drive
 */
export async function legacyGetUserAccessiblePagesInDrive(
  userId: string,
  driveId: string
): Promise<string[]> {
  const drive = await db.select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  const isOwner = drive.length > 0 && drive[0].ownerId === userId;

  let isAdmin = false;
  if (!isOwner && drive.length > 0) {
    const adminMembership = await db.select()
      .from(driveMembers)
      .where(and(
        eq(driveMembers.driveId, driveId),
        eq(driveMembers.userId, userId),
        eq(driveMembers.role, 'ADMIN'),
        isNotNull(driveMembers.acceptedAt)
      ))
      .limit(1);

    isAdmin = adminMembership.length > 0;
  }

  if (isOwner || isAdmin) {
    const allPages = await db.select({ id: pages.id })
      .from(pages)
      .where(eq(pages.driveId, driveId));

    return allPages.map((page: { id: string }) => page.id);
  }

  const memberCheck = await db.select({ id: driveMembers.id, customRoleId: driveMembers.customRoleId })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt)
    ))
    .limit(1);

  const memberRow = memberCheck[0] ?? null;

  const pageIdSet = new Set<string>();

  if (memberRow) {
    const nonPrivatePages = await db.select({ id: pages.id })
      .from(pages)
      .where(and(
        eq(pages.driveId, driveId),
        eq(pages.isPrivate, false),
        eq(pages.isTrashed, false)
      ));
    for (const p of nonPrivatePages) pageIdSet.add(p.id);

    if (memberRow.customRoleId) {
      const role = await fetchCustomRolePermissions(memberRow.customRoleId, driveId);
      if (role) {
        const { permissions: rolePerms } = role;
        const visiblePageIds = Object.entries(rolePerms)
          .filter(([, p]) => p.canView)
          .map(([id]) => id);

        if (visiblePageIds.length > 0) {
          // Validate IDs against the DB to exclude stale, trashed, or out-of-drive pages
          const validRolePages = await db.select({ id: pages.id })
            .from(pages)
            .where(and(
              inArray(pages.id, visiblePageIds),
              eq(pages.driveId, driveId),
              eq(pages.isTrashed, false)
            ));
          for (const page of validRolePages) pageIdSet.add(page.id);
        }

        // Explicit deny beats Rule 4: remove non-private pages the role disallows
        for (const [id, p] of Object.entries(rolePerms)) {
          if (!p.canView) pageIdSet.delete(id);
        }

        // driveWidePermissions deny: remove Rule-4 pages not explicitly granted
        if (role.driveWidePermissions?.canView === false) {
          for (const id of [...pageIdSet]) {
            if (rolePerms[id]?.canView !== true) pageIdSet.delete(id);
          }
        }
      }
    }
  }

  const explicitPermissions = await db.select({ pageId: pagePermissions.pageId })
    .from(pagePermissions)
    .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
    .where(and(
      eq(pagePermissions.userId, userId),
      eq(pages.driveId, driveId),
      eq(pagePermissions.canView, true),
      or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
    ));

  for (const entry of explicitPermissions) pageIdSet.add(entry.pageId);

  return Array.from(pageIdSet);
}

/**
 * Get all pages a user has access to in a drive with full page details and permissions
 * Optimized to avoid N+1 queries by using batch permission checks
 */
export async function legacyGetUserAccessiblePagesInDriveWithDetails(
  userId: string,
  driveId: string
): Promise<PageWithPermissions[]> {
  const drive = await db.select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  if (drive.length === 0) {
    return [];
  }

  const isOwner = drive[0].ownerId === userId;

  let isAdmin = false;
  if (!isOwner) {
    const adminMembership = await db.select()
      .from(driveMembers)
      .where(and(
        eq(driveMembers.driveId, driveId),
        eq(driveMembers.userId, userId),
        eq(driveMembers.role, 'ADMIN'),
        isNotNull(driveMembers.acceptedAt)
      ))
      .limit(1);

    isAdmin = adminMembership.length > 0;
  }

  if (isOwner || isAdmin) {
    const allPages = await db.select({
      id: pages.id,
      title: pages.title,
      type: pages.type,
      parentId: pages.parentId,
      position: pages.position,
      isTrashed: pages.isTrashed,
    })
    .from(pages)
    .where(and(
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false)
    ));

    return allPages.map((page): PageWithPermissions => ({
      ...page,
      permissions: {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      }
    }));
  }

  const memberCheck = await db.select({ id: driveMembers.id, customRoleId: driveMembers.customRoleId })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt)
    ))
    .limit(1);

  const isMember = memberCheck.length > 0;

  const pageMap = new Map<string, PageWithPermissions>();

  // Rule 4: MEMBER gets implicit canView on non-private pages
  if (isMember) {
    const nonPrivatePages = await db.select({
      id: pages.id,
      title: pages.title,
      type: pages.type,
      parentId: pages.parentId,
      position: pages.position,
      isTrashed: pages.isTrashed,
    })
    .from(pages)
    .where(and(
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false),
      eq(pages.isPrivate, false)
    ));

    for (const page of nonPrivatePages) {
      pageMap.set(page.id, {
        ...page,
        permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
      });
    }
  }

  const memberCustomRoleId = memberCheck[0]?.customRoleId ?? null;
  if (memberCustomRoleId) {
    const role = await fetchCustomRolePermissions(memberCustomRoleId, driveId);
    if (role) {
      const { permissions: rolePerms, driveWidePermissions } = role;

      // Apply driveWidePermissions as default for non-private pages already in the map
      // that don't have an explicit per-page entry (per-page wins over drive-wide)
      if (driveWidePermissions) {
        for (const [pageId, pageData] of pageMap.entries()) {
          if (rolePerms[pageId] === undefined) {
            pageMap.set(pageId, {
              ...pageData,
              permissions: { ...driveWidePermissions, canDelete: false },
            });
          }
        }
      }

      const visiblePageIds = Object.entries(rolePerms)
        .filter(([, p]) => p.canView)
        .map(([id]) => id);

      if (visiblePageIds.length > 0) {
        const rolePages = await db.select({
          id: pages.id,
          title: pages.title,
          type: pages.type,
          parentId: pages.parentId,
          position: pages.position,
          isTrashed: pages.isTrashed,
        })
        .from(pages)
        .where(and(inArray(pages.id, visiblePageIds), eq(pages.driveId, driveId), eq(pages.isTrashed, false)));

        for (const page of rolePages) {
          const resolved = resolveCustomRolePermissions(role, page.id);
          pageMap.set(page.id, {
            ...page,
            permissions: { ...(resolved ?? rolePerms[page.id]!), canDelete: false },
          });
        }
      }

      // Explicit deny beats Rule 4: remove non-private pages the role disallows
      for (const [id, p] of Object.entries(rolePerms)) {
        if (!p.canView) {
          pageMap.delete(id);
        }
      }

      // driveWidePermissions deny: remove pages not covered by an explicit per-page grant
      if (driveWidePermissions?.canView === false) {
        for (const pageId of [...pageMap.keys()]) {
          if (rolePerms[pageId] === undefined) pageMap.delete(pageId);
        }
      }
    }
  }

  // Explicit pagePermissions override the defaults
  const explicitPages = await db.select({
    id: pages.id,
    title: pages.title,
    type: pages.type,
    parentId: pages.parentId,
    position: pages.position,
    isTrashed: pages.isTrashed,
    canView: pagePermissions.canView,
    canEdit: pagePermissions.canEdit,
    canShare: pagePermissions.canShare,
    canDelete: pagePermissions.canDelete,
  })
  .from(pages)
  .innerJoin(pagePermissions, eq(pages.id, pagePermissions.pageId))
  .where(and(
    eq(pages.driveId, driveId),
    eq(pages.isTrashed, false),
    eq(pagePermissions.userId, userId),
    eq(pagePermissions.canView, true),
    or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
  ));

  for (const page of explicitPages) {
    pageMap.set(page.id, {
      id: page.id,
      title: page.title,
      type: page.type,
      parentId: page.parentId,
      position: page.position,
      isTrashed: page.isTrashed,
      permissions: {
        canView: page.canView,
        canEdit: page.canEdit,
        canShare: page.canShare,
        canDelete: page.canDelete,
      },
    });
  }

  return Array.from(pageMap.values());
}

/**
 * Check if user has access to a drive by drive ID.
 * Returns true when the user owns the drive, is a drive member, or has
 * page-level permissions within the drive.
 */
export async function legacyGetUserDriveAccess(
  userId: string,
  driveId: string,
  options: { silent?: boolean } = {}
): Promise<boolean> {
  const { silent = true } = options;

  try {
    if (!silent) {
      loggers.api.debug(`[DRIVE_ACCESS] Checking access for userId: ${userId}, driveId: ${driveId}`);
    }

    const drive = await db.select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      if (!silent) {
        loggers.api.debug(`[DRIVE_ACCESS] Drive not found: ${driveId}`);
      }
      return false;
    }

    const driveData = drive[0];

    if (!silent) {
      loggers.api.debug(`[DRIVE_ACCESS] Drive found - id: ${driveData.id}, ownerId: ${driveData.ownerId}`);
    }

    if (driveData.ownerId === userId) {
      if (!silent) {
        loggers.api.debug(`[DRIVE_ACCESS] User is drive owner - granting access`);
      }
      return true;
    }

    if (!silent) {
      loggers.api.debug('[DRIVE_ACCESS] User is NOT drive owner - checking drive membership');
    }

    const membership = await db.select({ id: driveMembers.id })
      .from(driveMembers)
      .where(and(
        eq(driveMembers.driveId, driveData.id),
        eq(driveMembers.userId, userId),
        isNotNull(driveMembers.acceptedAt)
      ))
      .limit(1);

    if (membership.length > 0) {
      if (!silent) {
        loggers.api.debug('[DRIVE_ACCESS] User is a drive member - granting access');
      }
      return true;
    }

    if (!silent) {
      loggers.api.debug('[DRIVE_ACCESS] User is not a drive member - checking page permissions');
    }

    const pageAccess = await db.select({ id: pagePermissions.id })
      .from(pagePermissions)
      .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
      .where(and(
        eq(pages.driveId, driveData.id),
        eq(pagePermissions.userId, userId),
        eq(pagePermissions.canView, true),
        or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
      ))
      .limit(1);

    const hasAccess = pageAccess.length > 0;

    if (!silent) {
      loggers.api.debug(`[DRIVE_ACCESS] Page access check result: ${hasAccess}`);
    }

    return hasAccess;

  } catch (error) {
    loggers.api.error('[DRIVE_ACCESS] Error checking user drive access', {
      userId,
      driveId,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

/**
 * Get user's granular permissions for a drive (for service token validation).
 *
 * Page-level collaborators are NOT considered to have drive-wide access —
 * they must use page-scoped tokens instead. Use this for service token scope
 * validation where we need to distinguish owner / admin / member / viewer /
 * page-collaborator.
 */
export async function legacyGetUserDrivePermissions(
  userId: string,
  driveId: string,
  options: { silent?: boolean } = {}
): Promise<DrivePermissionLevel | null> {
  const { silent = true } = options;

  try {
    const drive = await db
      .select({ id: drives.id, ownerId: drives.ownerId })
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      if (!silent) {
        loggers.api.debug(`[DRIVE_PERMISSIONS] Drive not found: ${driveId}`);
      }
      return null;
    }

    const driveData = drive[0];
    const isOwner = driveData.ownerId === userId;

    if (isOwner) {
      if (!silent) {
        loggers.api.debug(`[DRIVE_PERMISSIONS] User is drive owner`);
      }
      return {
        hasAccess: true,
        isOwner: true,
        isAdmin: false,
        isMember: false,
        canEdit: true,
      };
    }

    const membership = await db
      .select({ role: driveMembers.role, customRoleId: driveMembers.customRoleId })
      .from(driveMembers)
      .where(
        and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, userId),
          isNotNull(driveMembers.acceptedAt)
        )
      )
      .limit(1);

    if (membership.length > 0) {
      const { role, customRoleId } = membership[0];
      const isAdmin = role === 'ADMIN';
      let canEdit = isAdmin || role === 'MEMBER';

      // A custom role bounds a MEMBER's drive-wide edit to what the role's
      // driveWidePermissions explicitly grant (ADMINs bypass custom roles,
      // mirroring the agent/app permission paths). `canEdit` here answers the
      // DRIVE-WIDE question — drive-root uploads, sandbox/compute access —
      // so a view-only custom role must read false even though the member
      // may hold per-page edit grants (codex round 12). An unresolvable
      // custom role fails closed rather than degrading to plain-member edit.
      if (!isAdmin && customRoleId) {
        const customRole = await fetchCustomRolePermissions(customRoleId, driveId);
        canEdit = customRole?.driveWidePermissions?.canEdit === true;
      }

      if (!silent) {
        loggers.api.debug(
          `[DRIVE_PERMISSIONS] User is drive member with role: ${role}`
        );
      }

      return {
        hasAccess: true,
        isOwner: false,
        isAdmin,
        isMember: true,
        canEdit,
      };
    }

    if (!silent) {
      loggers.api.debug(
        `[DRIVE_PERMISSIONS] User has no drive-level membership (page collaborator or no access)`
      );
    }
    return null;
  } catch (error) {
    loggers.api.error('[DRIVE_PERMISSIONS] Error checking drive permissions', {
      userId,
      driveId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The page-access decision itself, with no database in it.
 *
 * Extracted so the two directions of the same question — "which of these pages
 * can this user see?" (getBatchPagePermissions) and "which of these users can
 * see this page?" (getUsersWhoCanViewPage) — resolve through one implementation
 * and cannot drift apart. They had drifted: the channel inbox fan-out grew its
 * own recipient query that knew about owners, admins and explicit grants but
 * not about rule 4 or custom roles, so ordinary drive members silently stopped
 * receiving events for channels they can plainly read.
 *
 * Returns null when the row grants nothing (the caller's default deny stands).
 */
export function legacyResolvePagePermissionRow(
  row: PagePermissionRow,
  userId: string
): PermissionLevel | null {
  if (row.isTrashed) return null;

  const isOwner = row.driveOwnerId === userId;
  const isAdmin = row.memberRole === 'ADMIN';
  const isMember = row.memberRole !== null;

  if (isOwner || isAdmin) {
    return { canView: true, canEdit: true, canShare: true, canDelete: true };
  }

  if (row.explicitCanView !== null) {
    return {
      canView: row.explicitCanView ?? false,
      canEdit: row.explicitCanEdit ?? false,
      canShare: row.explicitCanShare ?? false,
      canDelete: row.explicitCanDelete ?? false,
    };
  }

  if (row.customRolePerms) {
    const resolved = resolveCustomRolePermissions(
      {
        permissions: row.customRolePerms,
        driveWidePermissions: row.customRoleDriveWidePerms,
      },
      row.pageId,
    );
    if (resolved !== null) {
      return { ...resolved, canDelete: false };
    }
  }

  // Rule 4: any accepted drive member gets access to non-private pages.
  // Channels grant canEdit so members can post messages (Discord/Slack semantics).
  if (isMember && !row.isPrivate) {
    return {
      canView: true,
      canEdit: row.pageType === 'CHANNEL',
      canShare: false,
      canDelete: false,
    };
  }

  return null;
}

/**
 * Batch permission lookup for multiple pages in a single DB round-trip.
 *
 * One SQL statement joins `pages`, `drives`, `drive_members` (for ADMIN role,
 * accepted members only), and `page_permissions` (with `expires_at` filter)
 * across all requested page IDs. Ordering is irrelevant; the result map keys
 * on pageId.
 *
 * Returns an entry for every `pageId` in input — pages the user cannot access
 * (including non-existent, trashed, or expired-grant pages) are represented
 * with all four flags set to `false`. Callers can therefore read
 * `map.get(pageId)?.canView` without conditional-path handling for missing
 * entries.
 */
export async function legacyGetBatchPagePermissions(
  userId: string,
  pageIds: string[]
): Promise<Map<string, PermissionLevel>> {
  const results = new Map<string, PermissionLevel>();

  if (pageIds.length === 0) {
    return results;
  }

  const deny: PermissionLevel = {
    canView: false,
    canEdit: false,
    canShare: false,
    canDelete: false,
  };

  for (const pageId of pageIds) {
    results.set(pageId, { ...deny });
  }

  try {
    const rows = await db
      .select({
        pageId: pages.id,
        isTrashed: pages.isTrashed,
        isPrivate: pages.isPrivate,
        pageType: pages.type,
        driveOwnerId: drives.ownerId,
        memberRole: driveMembers.role,
        explicitCanView: pagePermissions.canView,
        explicitCanEdit: pagePermissions.canEdit,
        explicitCanShare: pagePermissions.canShare,
        explicitCanDelete: pagePermissions.canDelete,
        customRolePerms: driveRoles.permissions,
        customRoleDriveWidePerms: driveRoles.driveWidePermissions,
      })
      .from(pages)
      .leftJoin(drives, eq(drives.id, pages.driveId))
      .leftJoin(
        driveMembers,
        and(
          eq(driveMembers.driveId, pages.driveId),
          eq(driveMembers.userId, userId),
          isNotNull(driveMembers.acceptedAt)
        )
      )
      .leftJoin(
        pagePermissions,
        and(
          eq(pagePermissions.pageId, pages.id),
          eq(pagePermissions.userId, userId),
          or(
            isNull(pagePermissions.expiresAt),
            gt(pagePermissions.expiresAt, new Date())
          )
        )
      )
      .leftJoin(
        driveRoles,
        and(
          eq(driveRoles.id, driveMembers.customRoleId),
          eq(driveRoles.driveId, pages.driveId)
        )
      )
      .where(inArray(pages.id, pageIds));

    for (const row of rows) {
      const resolved = legacyResolvePagePermissionRow(row, userId);
      if (resolved) {
        results.set(row.pageId, resolved);
      }
    }

    return results;
  } catch (error) {
    loggers.api.error('[BATCH_PERMISSIONS] Error in batch permission check', {
      userId,
      pageCount: pageIds.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return results;
  }
}

/**
 * Which of `candidateUserIds` can view `pageId` — the inverse of
 * getBatchPagePermissions, for fan-out paths that must decide who to notify.
 *
 * Same joins, pivoted over users instead of pages, and the same decision via
 * resolvePagePermissionRow, so the two can never disagree about who has access.
 * Fails closed: on error nobody is returned.
 */
export async function legacyGetUsersWhoCanViewPage(
  pageId: string,
  candidateUserIds: string[]
): Promise<Set<string>> {
  const viewers = new Set<string>();
  if (candidateUserIds.length === 0) return viewers;

  try {
    for (let i = 0; i < candidateUserIds.length; i += LEGACY_VIEWER_BATCH_SIZE) {
      const chunk = candidateUserIds.slice(i, i + LEGACY_VIEWER_BATCH_SIZE);
      const rows = await db
        .select({
          pageId: pages.id,
          userId: users.id,
          isTrashed: pages.isTrashed,
          isPrivate: pages.isPrivate,
          pageType: pages.type,
          driveOwnerId: drives.ownerId,
          memberRole: driveMembers.role,
          explicitCanView: pagePermissions.canView,
          explicitCanEdit: pagePermissions.canEdit,
          explicitCanShare: pagePermissions.canShare,
          explicitCanDelete: pagePermissions.canDelete,
          customRolePerms: driveRoles.permissions,
          customRoleDriveWidePerms: driveRoles.driveWidePermissions,
        })
        .from(pages)
        // One row per candidate user for this single page, so every candidate is
        // evaluated even when they have no membership or grant rows at all.
        .innerJoin(users, inArray(users.id, chunk))
        .leftJoin(drives, eq(drives.id, pages.driveId))
        .leftJoin(
          driveMembers,
          and(
            eq(driveMembers.driveId, pages.driveId),
            eq(driveMembers.userId, users.id),
            isNotNull(driveMembers.acceptedAt)
          )
        )
        .leftJoin(
          pagePermissions,
          and(
            eq(pagePermissions.pageId, pages.id),
            eq(pagePermissions.userId, users.id),
            or(
              isNull(pagePermissions.expiresAt),
              gt(pagePermissions.expiresAt, new Date())
            )
          )
        )
        .leftJoin(
          driveRoles,
          and(
            eq(driveRoles.id, driveMembers.customRoleId),
            eq(driveRoles.driveId, pages.driveId)
          )
        )
        .where(eq(pages.id, pageId));

      for (const row of rows) {
        if (legacyResolvePagePermissionRow(row, row.userId)?.canView) {
          viewers.add(row.userId);
        }
      }
    }
  } catch (error) {
    loggers.api.error('[PAGE_VIEWERS] Error resolving page viewers', {
      pageId,
      candidateCount: candidateUserIds.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Set<string>();
  }

  return viewers;
}

// Returns the customRoleId assigned to the user in this drive, or null if none / not a member.
export async function legacyGetMemberCustomRoleId(driveId: string, userId: string): Promise<string | null> {
  const result = await db
    .select({ customRoleId: driveMembers.customRoleId })
    .from(driveMembers)
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt)))
    .limit(1);
  return result.length > 0 ? (result[0].customRoleId ?? null) : null;
}

/**
 * Check if user has access to drive and get their role
 */
export async function legacyCheckDriveAccess(
  driveId: string,
  userId: string
): Promise<DriveAccessResult> {
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
  });

  if (!drive) {
    return { isOwner: false, isAdmin: false, isMember: false, drive: null };
  }

  const isOwner = drive.ownerId === userId;

  if (isOwner) {
    return { isOwner: true, isAdmin: true, isMember: true, drive };
  }

  const membership = await db
    .select({ role: driveMembers.role })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt),
    ))
    .limit(1);

  if (membership.length === 0) {
    return { isOwner: false, isAdmin: false, isMember: false, drive };
  }

  const role = membership[0].role;
  return {
    isOwner: false,
    isAdmin: role === 'ADMIN',
    isMember: true,
    drive,
  };
}

/**
 * Check user's access level for a drive (reused from drive-member-service pattern)
 */
export async function legacyCheckDriveAccessForRoles(
  driveId: string,
  userId: string
): Promise<DriveRoleAccessInfo> {
  const driveResult = await db
    .select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  if (driveResult.length === 0) {
    return {
      isOwner: false,
      isAdmin: false,
      isMember: false,
      drive: null,
    };
  }

  const drive = driveResult[0];
  const isOwner = drive.ownerId === userId;

  if (isOwner) {
    return {
      isOwner: true,
      isAdmin: true,
      isMember: true,
      drive: {
        id: drive.id,
        name: drive.name,
        slug: drive.slug,
        ownerId: drive.ownerId,
      },
    };
  }

  // Check membership
  const membership = await db.query.driveMembers.findFirst({
    where: and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId)
    ),
  });

  if (!membership) {
    return {
      isOwner: false,
      isAdmin: false,
      isMember: false,
      drive: {
        id: drive.id,
        name: drive.name,
        slug: drive.slug,
        ownerId: drive.ownerId,
      },
    };
  }

  return {
    isOwner: false,
    isAdmin: membership.role === 'ADMIN',
    isMember: true,
    drive: {
      id: drive.id,
      name: drive.name,
      slug: drive.slug,
      ownerId: drive.ownerId,
    },
  };
}

/**
 * The requester's relationship to a drive: its owner, an accepted member, or
 * neither. The ONE membership read both access checks (main + end) share.
 */
export async function legacyResolveDriveMembership({
  userId,
  driveId,
}: {
  userId: string;
  driveId: string;
}): Promise<DriveMembership> {
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
    columns: { ownerId: true },
  });
  if (!drive) return 'none';
  if (drive.ownerId === userId) return 'owner';
  const membership = await db.query.driveMembers.findFirst({
    where: and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt)),
    columns: { role: true },
  });
  if (!membership) return 'none';
  // ADMIN is surfaced distinctly because the END decision requires drive
  // delete authority (owner/admin) — plain members may not tear down another
  // member's session (codex round 12).
  return membership.role === 'ADMIN' ? 'admin' : 'member';
}

/**
 * Check if a user is a member (or owner) of the event's home drive OR any shared drive.
 * Fast-path: skips junction query if home-drive membership/ownership is confirmed first.
 * Uses batched queries for shared drives — not N+1.
 */
export async function legacyIsUserMemberOfAnyEventDrive(
  userId: string,
  event: { id: string; driveId: string | null },
): Promise<boolean> {
  if (!event.driveId) return false;

  // getDriveRecipientUserIds includes the drive owner + all accepted members.
  const homeRecipients = new Set(await getDriveRecipientUserIds(event.driveId));
  if (homeRecipients.has(userId)) return true;

  const sharedRows = await db
    .select({ driveId: calendarEventDrives.driveId })
    .from(calendarEventDrives)
    .where(eq(calendarEventDrives.eventId, event.id));

  if (sharedRows.length === 0) return false;

  const sharedDriveIds = sharedRows.map((r) => r.driveId);
  const [sharedMembers, sharedOwners] = await Promise.all([
    db.select({ userId: driveMembers.userId })
      .from(driveMembers)
      .where(and(inArray(driveMembers.driveId, sharedDriveIds), isNotNull(driveMembers.acceptedAt))),
    db.select({ ownerId: drives.ownerId })
      .from(drives)
      .where(inArray(drives.id, sharedDriveIds)),
  ]);

  return sharedMembers.some((m) => m.userId === userId) ||
    sharedOwners.some((d) => d.ownerId === userId);
}

/**
 * Combined existence + authorization check.
 * Returns PAGE_NOT_ACCESSIBLE for both missing page and unauthorized user.
 * This prevents information leakage about page existence.
 */
export async function legacyGetPageIfCanShare(
  userId: string,
  pageId: string
): Promise<{ ok: true; page: PageForSharing } | { ok: false; error: PermissionMutationError }> {
  // Get page with drive info
  const pageWithDrive = await db
    .select({
      id: pages.id,
      driveId: pages.driveId,
      driveOwnerId: drives.ownerId,
      driveKind: drives.kind,
      createdBy: pages.createdBy,
    })
    .from(pages)
    .leftJoin(drives, eq(pages.driveId, drives.id))
    .where(eq(pages.id, pageId))
    .limit(1);

  if (pageWithDrive.length === 0 || !pageWithDrive[0].driveId) {
    // Page doesn't exist - same error as unauthorized
    return {
      ok: false,
      error: { code: 'PAGE_NOT_ACCESSIBLE', pageId },
    };
  }

  const page = pageWithDrive[0];

  // Check if user is drive owner (can share)
  if (page.driveOwnerId === userId) {
    return {
      ok: true,
      page: { pageId: page.id, driveId: page.driveId, driveKind: page.driveKind },
    };
  }

  // Check if user is the page creator AND still has active drive membership
  if (page.createdBy === userId) {
    const creatorMembership = await db
      .select({ id: driveMembers.id })
      .from(driveMembers)
      .where(
        and(
          eq(driveMembers.driveId, page.driveId),
          eq(driveMembers.userId, userId),
          isNotNull(driveMembers.acceptedAt)
        )
      )
      .limit(1);

    if (creatorMembership.length > 0) {
      return {
        ok: true,
        page: { pageId: page.id, driveId: page.driveId, driveKind: page.driveKind },
      };
    }
  }

  // Check if user is drive admin (can share)
  const adminMembership = await db
    .select({ id: driveMembers.id })
    .from(driveMembers)
    .where(
      and(
        eq(driveMembers.driveId, page.driveId),
        eq(driveMembers.userId, userId),
        eq(driveMembers.role, 'ADMIN'),
        isNotNull(driveMembers.acceptedAt)
      )
    )
    .limit(1);

  if (adminMembership.length > 0) {
    return {
      ok: true,
      page: { pageId: page.id, driveId: page.driveId, driveKind: page.driveKind },
    };
  }

  // Check if user has explicit share permission on the page
  const sharePermission = await db
    .select({ canShare: pagePermissions.canShare })
    .from(pagePermissions)
    .where(
      and(
        eq(pagePermissions.pageId, pageId),
        eq(pagePermissions.userId, userId)
      )
    )
    .limit(1);

  if (sharePermission.length > 0 && sharePermission[0].canShare) {
    return {
      ok: true,
      page: { pageId: page.id, driveId: page.driveId, driveKind: page.driveKind },
    };
  }

  // User cannot share - same error as page not found
  return {
    ok: false,
    error: { code: 'PAGE_NOT_ACCESSIBLE', pageId },
  };
}
