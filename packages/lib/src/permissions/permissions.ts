import { db } from '@pagespace/db/db';
import { and, eq, or, isNull, isNotNull, gt, inArray } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { loggers } from '../logging/logger-config';
import { parseUserId, parsePageId } from '../validators/id-validators';

/**
 * Permission level for a single page.
 */
export interface PermissionLevel {
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
}

/**
 * Granular drive permission level for service token validation.
 *
 * Unlike getUserDriveAccess (which returns a boolean for any access including
 * page-level), this returns detailed role information. Page-level
 * collaborators are NOT considered to have drive-wide access.
 */
export interface DrivePermissionLevel {
  hasAccess: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  isMember: boolean;
  canEdit: boolean;
}

/**
 * Get all drive IDs that a user has access to
 * Includes owned drives, member drives, and drives with page permissions
 */
export async function getDriveIdsForUser(userId: string): Promise<string[]> {
  const driveIdSet = new Set<string>();

  const ownedDrives = await db.select({ id: drives.id })
    .from(drives)
    .where(eq(drives.ownerId, userId));

  for (const drive of ownedDrives) {
    driveIdSet.add(drive.id);
  }

  const memberDrives = await db.select({ driveId: driveMembers.driveId })
    .from(driveMembers)
    .where(eq(driveMembers.userId, userId));

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
 * Get user access level for a page.
 *
 * @param userId - User ID to check permissions for (validated as CUID2)
 * @param pageId - Page ID to check permissions on (validated as CUID2)
 * @param options.silent - If false, log debug messages (default: true)
 * @returns Permission object or null if no access / invalid input
 */
export async function getUserAccessLevel(
  userId: unknown,
  pageId: unknown,
  options: { silent?: boolean } = {}
): Promise<PermissionLevel | null> {
  const { silent = true } = options;

  const userIdResult = parseUserId(userId);
  if (!userIdResult.success) {
    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] Invalid userId: ${userIdResult.error.message}`);
    }
    return null;
  }

  const pageIdResult = parsePageId(pageId);
  if (!pageIdResult.success) {
    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] Invalid pageId: ${pageIdResult.error.message}`);
    }
    return null;
  }

  const validUserId = userIdResult.data;
  const validPageId = pageIdResult.data;

  try {
    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] Checking access for userId: ${validUserId}, pageId: ${validPageId}`);
    }

    const page = await db.select({
      id: pages.id,
      driveId: pages.driveId,
      driveOwnerId: drives.ownerId,
    })
    .from(pages)
    .leftJoin(drives, eq(pages.driveId, drives.id))
    .where(eq(pages.id, validPageId))
    .limit(1);

    if (page.length === 0) {
      if (!silent) {
        loggers.api.debug(`[PERMISSIONS] Page not found: ${validPageId}`);
      }
      return null;
    }

    const pageData = page[0];

    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] Page found - driveId: ${pageData.driveId}, driveOwnerId: ${pageData.driveOwnerId}`);
    }

    if (pageData.driveOwnerId === validUserId) {
      if (!silent) {
        loggers.api.debug(`[PERMISSIONS] User is drive owner - granting full access`);
      }
      return {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      };
    }

    if (pageData.driveId) {
      const adminMembership = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, pageData.driveId),
          eq(driveMembers.userId, validUserId),
          eq(driveMembers.role, 'ADMIN'),
          isNotNull(driveMembers.acceptedAt)
        ))
        .limit(1);

      if (adminMembership.length > 0) {
        if (!silent) {
          loggers.api.debug(`[PERMISSIONS] User is drive admin - granting full access`);
        }
        return {
          canView: true,
          canEdit: true,
          canShare: true,
          canDelete: true,
        };
      }
    }

    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] User is NOT drive owner or admin - checking explicit permissions`);
    }

    const permission = await db.select()
      .from(pagePermissions)
      .where(and(
        eq(pagePermissions.pageId, validPageId),
        eq(pagePermissions.userId, validUserId),
        or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
      ))
      .limit(1);

    if (permission.length === 0) {
      if (!silent) {
        loggers.api.debug(`[PERMISSIONS] No explicit permissions found (or expired) - denying access`);
      }
      return null;
    }

    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] Found explicit permissions - canView: ${permission[0].canView}, canEdit: ${permission[0].canEdit}`);
    }

    return {
      canView: permission[0].canView,
      canEdit: permission[0].canEdit,
      canShare: permission[0].canShare,
      canDelete: permission[0].canDelete,
    };

  } catch (error) {
    loggers.api.error('[PERMISSIONS] Error checking user access level', {
      userId: validUserId,
      pageId: validPageId,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Check if user can view a page
 */
export async function canUserViewPage(userId: string, pageId: string): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canView ?? false;
}

/**
 * Check if user can edit a page
 */
export async function canUserEditPage(userId: string, pageId: string): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canEdit ?? false;
}

/**
 * Check if user can share a page
 */
export async function canUserSharePage(userId: string, pageId: string): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canShare ?? false;
}

/**
 * Check if user can delete a page
 */
export async function canUserDeletePage(userId: string, pageId: string): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canDelete ?? false;
}

/**
 * Check if user is owner or admin of a drive
 */
export async function isDriveOwnerOrAdmin(
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
export async function isUserDriveMember(
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
export async function getUserAccessiblePagesInDrive(
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

  const permissions = await db.select({ pageId: pagePermissions.pageId })
    .from(pagePermissions)
    .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
    .where(and(
      eq(pagePermissions.userId, userId),
      eq(pages.driveId, driveId),
      eq(pagePermissions.canView, true),
      or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
    ));

  return permissions.map((entry: { pageId: string }) => entry.pageId);
}

/**
 * Page with permission details type
 */
export type PageWithPermissions = {
  id: string;
  title: string;
  type: string;
  parentId: string | null;
  position: number;
  isTrashed: boolean;
  permissions: {
    canView: boolean;
    canEdit: boolean;
    canShare: boolean;
    canDelete: boolean;
  };
};

/**
 * Get all pages a user has access to in a drive with full page details and permissions
 * Optimized to avoid N+1 queries by using batch permission checks
 */
export async function getUserAccessiblePagesInDriveWithDetails(
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

  const pagesWithPermissions = await db.select({
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

  return pagesWithPermissions.map((page): PageWithPermissions => ({
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
    }
  }));
}

/**
 * Check if user has access to a drive by drive ID.
 * Returns true when the user owns the drive, is a drive member, or has
 * page-level permissions within the drive.
 */
export async function getUserDriveAccess(
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
export async function getUserDrivePermissions(
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
      .select({ role: driveMembers.role })
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
      const role = membership[0].role;
      const isAdmin = role === 'ADMIN';
      const canEdit = isAdmin || role === 'MEMBER';

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
export async function getBatchPagePermissions(
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
        driveOwnerId: drives.ownerId,
        adminMemberId: driveMembers.id,
        explicitCanView: pagePermissions.canView,
        explicitCanEdit: pagePermissions.canEdit,
        explicitCanShare: pagePermissions.canShare,
        explicitCanDelete: pagePermissions.canDelete,
      })
      .from(pages)
      .leftJoin(drives, eq(drives.id, pages.driveId))
      .leftJoin(
        driveMembers,
        and(
          eq(driveMembers.driveId, pages.driveId),
          eq(driveMembers.userId, userId),
          eq(driveMembers.role, 'ADMIN'),
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
      .where(inArray(pages.id, pageIds));

    for (const row of rows) {
      if (row.isTrashed) {
        continue;
      }

      const isOwner = row.driveOwnerId === userId;
      const isAdmin = row.adminMemberId !== null;

      if (isOwner || isAdmin) {
        results.set(row.pageId, {
          canView: true,
          canEdit: true,
          canShare: true,
          canDelete: true,
        });
        continue;
      }

      if (row.explicitCanView !== null) {
        results.set(row.pageId, {
          canView: row.explicitCanView ?? false,
          canEdit: row.explicitCanEdit ?? false,
          canShare: row.explicitCanShare ?? false,
          canDelete: row.explicitCanDelete ?? false,
        });
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
