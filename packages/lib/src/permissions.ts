import { db, and, eq } from '@pagespace/db';
import { pages, drives, driveMembers, pagePermissions } from '@pagespace/db';

/**
 * Get user access level for a page
 * Simple permission check - no inheritance, direct permissions only
 */
export async function getUserAccessLevel(
  userId: string,
  pageId: string,
  options: { silent?: boolean } = {}
): Promise<{ canView: boolean; canEdit: boolean; canShare: boolean; canDelete: boolean } | null> {
  const { silent = false } = options;

  if (!silent) {
    console.log(`[PERMISSIONS] Checking access for userId: ${userId}, pageId: ${pageId}`);
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
      console.log(`[PERMISSIONS] Page not found: ${pageId}`);
    }
    return null; // Page not found
  }

  if (!silent) {
    console.log(`[PERMISSIONS] Page found - driveId: ${page[0].driveId}, driveOwnerId: ${page[0].driveOwnerId}`);
  }

  // 2. Check if user is drive owner (has all permissions)
  if (page[0].driveOwnerId === userId) {
    if (!silent) {
      console.log(`[PERMISSIONS] User is drive owner - granting full access`);
    }
    return {
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: true,
    };
  }

  if (!silent) {
    console.log(`[PERMISSIONS] User is NOT drive owner - checking explicit permissions`);
  }

  // 3. Check direct page permissions
  const permission = await db.select()
    .from(pagePermissions)
    .where(and(
      eq(pagePermissions.pageId, pageId),
      eq(pagePermissions.userId, userId)
    ))
    .limit(1);

  if (permission.length === 0) {
    if (!silent) {
      console.log(`[PERMISSIONS] No explicit permissions found - denying access`);
    }
    return null; // No access
  }

  if (!silent) {
    console.log(`[PERMISSIONS] Found explicit permissions - canView: ${permission[0].canView}, canEdit: ${permission[0].canEdit}`);
  }

  return {
    canView: permission[0].canView,
    canEdit: permission[0].canEdit,
    canShare: permission[0].canShare,
    canDelete: permission[0].canDelete,
  };
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

  if (drive.length > 0 && drive[0].ownerId === userId) {
    // Owner has access to all pages
    const allPages = await db.select({ id: pages.id })
      .from(pages)
      .where(eq(pages.driveId, driveId));

    return allPages.map(p => p.id);
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

  return permissions.map(p => p.pageId);
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

  if (drive[0].ownerId === userId) {
    // Owner has access to all pages with full permissions
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

    return allPages.map(page => ({
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

  return pagesWithPermissions.map(page => ({
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
}

/**
 * Revoke all permissions for a user on a page
 */
export async function revokePagePermissions(
  pageId: string,
  userId: string
): Promise<void> {
  await db.delete(pagePermissions)
    .where(and(
      eq(pagePermissions.pageId, pageId),
      eq(pagePermissions.userId, userId)
    ));
}


/**
 * Check if user has access to a drive by drive ID
 * Returns true if user owns the drive or has any page permissions in the drive
 */
export async function getUserDriveAccess(
  userId: string,
  driveId: string
): Promise<boolean> {
  console.log(`[DRIVE_ACCESS] Checking access for userId: ${userId}, driveId: ${driveId}`);
  
  // Get drive by ID
  const drive = await db.select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  if (drive.length === 0) {
    console.log(`[DRIVE_ACCESS] Drive not found: ${driveId}`);
    return false;
  }

  console.log(`[DRIVE_ACCESS] Drive found - id: ${drive[0].id}, ownerId: ${drive[0].ownerId}`);

  // Check if user is owner
  if (drive[0].ownerId === userId) {
    console.log(`[DRIVE_ACCESS] User is drive owner - granting access`);
    return true;
  }

  console.log(`[DRIVE_ACCESS] User is NOT drive owner - checking page permissions`);

  // Check if user has any page permissions in this drive
  const pageAccess = await db.select({ id: pagePermissions.id })
    .from(pagePermissions)
    .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
    .where(and(
      eq(pages.driveId, drive[0].id),
      eq(pagePermissions.userId, userId),
      eq(pagePermissions.canView, true)
    ))
    .limit(1);

  const hasAccess = pageAccess.length > 0;
  console.log(`[DRIVE_ACCESS] Page access check result: ${hasAccess}`);
  
  return hasAccess;
}