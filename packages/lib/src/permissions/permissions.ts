import { db, and, eq, or } from '@pagespace/db';
import { pages, drives, driveMembers, pagePermissions } from '@pagespace/db';
import { permissionCache } from '../services/permission-cache';
import { loggers } from '../logging/logger-config';

/**
 * Get all drive IDs that a user has access to
 * Includes owned drives, member drives, and drives with page permissions
 */
export async function getDriveIdsForUser(userId: string): Promise<string[]> {
  const driveIdSet = new Set<string>();

  // 1. Get drives owned by user
  const ownedDrives = await db.select({ id: drives.id })
    .from(drives)
    .where(eq(drives.ownerId, userId));

  for (const drive of ownedDrives) {
    driveIdSet.add(drive.id);
  }

  // 2. Get drives where user is a member
  const memberDrives = await db.select({ driveId: driveMembers.driveId })
    .from(driveMembers)
    .where(eq(driveMembers.userId, userId));

  for (const membership of memberDrives) {
    driveIdSet.add(membership.driveId);
  }

  // 3. Get drives where user has page permissions
  const pageDrives = await db.select({ driveId: pages.driveId })
    .from(pagePermissions)
    .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
    .where(and(
      eq(pagePermissions.userId, userId),
      eq(pagePermissions.canView, true)
    ));

  for (const page of pageDrives) {
    if (page.driveId) {
      driveIdSet.add(page.driveId);
    }
  }

  return Array.from(driveIdSet);
}

/**
 * Get user access level for a page
 * Simple permission check - no inheritance, direct permissions only
 */
export async function getUserAccessLevel(
  userId: string,
  pageId: string,
  options: { silent?: boolean } = {}
): Promise<{ canView: boolean; canEdit: boolean; canShare: boolean; canDelete: boolean } | null> {
  const { silent = true } = options; // Default to silent for better performance

  try {
    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] Checking access for userId: ${userId}, pageId: ${pageId}`);
    }

    // 1. Get the page and its drive
    const page = await db.select({
      id: pages.id,
      driveId: pages.driveId,
      driveOwnerId: drives.ownerId,
    })
    .from(pages)
    .leftJoin(drives, eq(pages.driveId, drives.id))
    .where(eq(pages.id, pageId))
    .limit(1);

    if (page.length === 0) {
      if (!silent) {
        loggers.api.debug(`[PERMISSIONS] Page not found: ${pageId}`);
      }
      return null; // Page not found
    }

    const pageData = page[0];

    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] Page found - driveId: ${pageData.driveId}, driveOwnerId: ${pageData.driveOwnerId}`);
    }

    // 2. Check if user is drive owner (has all permissions)
    if (pageData.driveOwnerId === userId) {
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

    // 3. Check if user is a drive admin (has all permissions like owner)
    if (pageData.driveId) {
      const adminMembership = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, pageData.driveId),
          eq(driveMembers.userId, userId),
          eq(driveMembers.role, 'ADMIN')
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

    // 4. Check direct page permissions
    const permission = await db.select()
      .from(pagePermissions)
      .where(and(
        eq(pagePermissions.pageId, pageId),
        eq(pagePermissions.userId, userId)
      ))
      .limit(1);

    if (permission.length === 0) {
      if (!silent) {
        loggers.api.debug(`[PERMISSIONS] No explicit permissions found - denying access`);
      }
      return null; // No access
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
      userId,
      pageId,
      error: error instanceof Error ? error.message : String(error)
    });
    return null; // Deny access on error
  }
}

/**
 * Check if user can view a page
 */
export async function canUserViewPage(
  userId: string,
  pageId: string
): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canView || false;
}

/**
 * Check if user can edit a page
 */
export async function canUserEditPage(
  userId: string,
  pageId: string
): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canEdit || false;
}

/**
 * Check if user can share a page
 */
export async function canUserSharePage(
  userId: string,
  pageId: string
): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canShare || false;
}

/**
 * Check if user can delete a page
 */
export async function canUserDeletePage(
  userId: string,
  pageId: string
): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canDelete || false;
}

/**
 * Check if user is owner or admin of a drive
 */
export async function isDriveOwnerOrAdmin(
  userId: string,
  driveId: string
): Promise<boolean> {
  // Check if user is drive owner
  const drive = await db.select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  if (drive.length > 0 && drive[0].ownerId === userId) {
    return true;
  }

  // Check if user is an admin member
  const membership = await db.select()
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId),
      eq(driveMembers.role, 'ADMIN')
    ))
    .limit(1);

  return membership.length > 0;
}

/**
 * Check if user is a member of a drive
 */
export async function isUserDriveMember(
  userId: string,
  driveId: string
): Promise<boolean> {
  // Check if user is drive owner
  const drive = await db.select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  if (drive.length > 0 && drive[0].ownerId === userId) {
    return true;
  }

  // Check if user is a drive member
  const membership = await db.select()
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId)
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
  // Check if user is drive owner
  const drive = await db.select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  const isOwner = drive.length > 0 && drive[0].ownerId === userId;

  // Check if user is an admin
  let isAdmin = false;
  if (!isOwner && drive.length > 0) {
    const adminMembership = await db.select()
      .from(driveMembers)
      .where(and(
        eq(driveMembers.driveId, driveId),
        eq(driveMembers.userId, userId),
        eq(driveMembers.role, 'ADMIN')
      ))
      .limit(1);

    isAdmin = adminMembership.length > 0;
  }

  if (isOwner || isAdmin) {
    // Owner or Admin has access to all pages
    const allPages = await db.select({ id: pages.id })
      .from(pages)
      .where(eq(pages.driveId, driveId));

    return allPages.map((page: { id: string }) => page.id);
  }

  // Get pages with explicit permissions
  const permissions = await db.select({ pageId: pagePermissions.pageId })
    .from(pagePermissions)
    .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
    .where(and(
      eq(pagePermissions.userId, userId),
      eq(pages.driveId, driveId),
      eq(pagePermissions.canView, true)
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
  // Check if user is drive owner
  const drive = await db.select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  if (drive.length === 0) {
    return [];
  }

  const isOwner = drive[0].ownerId === userId;

  // Check if user is an admin
  let isAdmin = false;
  if (!isOwner) {
    const adminMembership = await db.select()
      .from(driveMembers)
      .where(and(
        eq(driveMembers.driveId, driveId),
        eq(driveMembers.userId, userId),
        eq(driveMembers.role, 'ADMIN')
      ))
      .limit(1);

    isAdmin = adminMembership.length > 0;
  }

  if (isOwner || isAdmin) {
    // Owner or Admin has access to all pages with full permissions
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

  // Get pages with explicit permissions via JOIN
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
    eq(pagePermissions.canView, true)
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
 * Grant permissions to a user for a page
 */
export async function grantPagePermissions(
  pageId: string,
  userId: string,
  permissions: {
    canView: boolean;
    canEdit: boolean;
    canShare: boolean;
    canDelete?: boolean;
  },
  grantedBy: string
): Promise<void> {
  const pageRecord = await db.select({ driveId: pages.driveId })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);

  const driveId = pageRecord[0]?.driveId;

  // Check if permission already exists
  const existing = await db.select()
    .from(pagePermissions)
    .where(and(
      eq(pagePermissions.pageId, pageId),
      eq(pagePermissions.userId, userId)
    ))
    .limit(1);

  if (existing.length > 0) {
    // Update existing permission
    await db.update(pagePermissions)
      .set({
        canView: permissions.canView,
        canEdit: permissions.canEdit,
        canShare: permissions.canShare,
        canDelete: permissions.canDelete || false,
        grantedBy,
        grantedAt: new Date(),
      })
      .where(eq(pagePermissions.id, existing[0].id));
  } else {
    // Create new permission
    await db.insert(pagePermissions)
      .values({
        pageId,
        userId,
        canView: permissions.canView,
        canEdit: permissions.canEdit,
        canShare: permissions.canShare,
        canDelete: permissions.canDelete || false,
        grantedBy,
      });
  }

  await Promise.all([
    permissionCache.invalidateUserCache(userId),
    driveId ? permissionCache.invalidateDriveCache(driveId) : Promise.resolve()
  ]);
}

/**
 * Revoke all permissions for a user on a page
 */
export async function revokePagePermissions(
  pageId: string,
  userId: string
): Promise<void> {
  const pageRecord = await db.select({ driveId: pages.driveId })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);

  const driveId = pageRecord[0]?.driveId;

  await db.delete(pagePermissions)
    .where(and(
      eq(pagePermissions.pageId, pageId),
      eq(pagePermissions.userId, userId)
    ));

  await Promise.all([
    permissionCache.invalidateUserCache(userId),
    driveId ? permissionCache.invalidateDriveCache(driveId) : Promise.resolve()
  ]);
}


/**
 * Check if user has access to a drive by drive ID
 * Returns true if user owns the drive, is a member of the drive, or has any page permissions in the drive
 */
export async function getUserDriveAccess(
  userId: string,
  driveId: string,
  options: { silent?: boolean } = {}
): Promise<boolean> {
  const { silent = true } = options; // Default to silent for better performance

  try {
    if (!silent) {
      loggers.api.debug(`[DRIVE_ACCESS] Checking access for userId: ${userId}, driveId: ${driveId}`);
    }

    // Get drive by ID
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

    // Check if user is owner
    if (driveData.ownerId === userId) {
      if (!silent) {
        loggers.api.debug(`[DRIVE_ACCESS] User is drive owner - granting access`);
      }
      return true;
    }

    if (!silent) {
      loggers.api.debug('[DRIVE_ACCESS] User is NOT drive owner - checking drive membership');
    }

    // Drive members inherit access to the entire drive
    const membership = await db.select({ id: driveMembers.id })
      .from(driveMembers)
      .where(and(
        eq(driveMembers.driveId, driveData.id),
        eq(driveMembers.userId, userId)
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

    // Check if user has any page permissions in this drive
    const pageAccess = await db.select({ id: pagePermissions.id })
      .from(pagePermissions)
      .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
      .where(and(
        eq(pages.driveId, driveData.id),
        eq(pagePermissions.userId, userId),
        eq(pagePermissions.canView, true)
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
    return false; // Deny access on error
  }
}
