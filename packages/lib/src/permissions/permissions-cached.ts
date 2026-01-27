import { db, and, eq, inArray } from '@pagespace/db';
import { pages, drives, driveMembers, pagePermissions } from '@pagespace/db';
import { PermissionCache, PermissionLevel } from '../services/permission-cache';
import { loggers } from '../logging/logger-config';

// Lazy initialization to prevent module-level instantiation
const getPermissionCache = () => PermissionCache.getInstance();

/**
 * Cached permission functions - drop-in replacements for the original permission functions
 *
 * These functions provide the same API as the original functions but with intelligent caching:
 * - 95%+ cache hit rate for typical usage patterns
 * - Automatic cache invalidation when permissions change
 * - Graceful fallback when cache is unavailable
 * - Batch operations to eliminate N+1 queries
 */

/**
 * Get user access level for a page (cached version)
 *
 * Performance improvements:
 * - First checks L1 (memory) and L2 (Redis) cache
 * - Falls back to database only when necessary
 * - Automatically caches results for future requests
 * - Silent by default (no verbose logging)
 */
export async function getUserAccessLevel(
  userId: string,
  pageId: string,
  options: { silent?: boolean; bypassCache?: boolean } = {}
): Promise<{ canView: boolean; canEdit: boolean; canShare: boolean; canDelete: boolean } | null> {
  const { silent = true, bypassCache = false } = options;

  try {
    // Check cache first (unless bypassed)
    if (!bypassCache) {
      const cached = await getPermissionCache().getPagePermission(userId, pageId);
      if (cached) {
        if (!silent) {
          loggers.api.debug(`[PERMISSIONS] Cache hit for userId: ${userId}, pageId: ${pageId}`);
        }
        return {
          canView: cached.canView,
          canEdit: cached.canEdit,
          canShare: cached.canShare,
          canDelete: cached.canDelete
        };
      }
    }

    if (!silent) {
      loggers.api.debug(`[PERMISSIONS] Cache miss, checking database for userId: ${userId}, pageId: ${pageId}`);
    }

    // Cache miss - query database
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
      return null;
    }

    const pageData = page[0];
    const isOwner = pageData.driveOwnerId === userId;

    let permissions: PermissionLevel;

    // Check if user is drive owner (has all permissions)
    if (isOwner) {
      permissions = {
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      };

      if (!silent) {
        loggers.api.debug(`[PERMISSIONS] User is drive owner - granting full access`);
      }
    } else {
      // Check if user is drive admin (has all permissions like owner)
      let isAdmin = false;
      if (pageData.driveId) {
        const adminMembership = await db.select()
          .from(driveMembers)
          .where(and(
            eq(driveMembers.driveId, pageData.driveId),
            eq(driveMembers.userId, userId),
            eq(driveMembers.role, 'ADMIN')
          ))
          .limit(1);

        isAdmin = adminMembership.length > 0;
      }

      if (isAdmin) {
        permissions = {
          canView: true,
          canEdit: true,
          canShare: true,
          canDelete: true,
        };

        if (!silent) {
          loggers.api.debug(`[PERMISSIONS] User is drive admin - granting full access`);
        }
      } else {
        // Check direct page permissions
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
          return null;
        }

        permissions = {
          canView: permission[0].canView,
          canEdit: permission[0].canEdit,
          canShare: permission[0].canShare,
          canDelete: permission[0].canDelete,
        };

        if (!silent) {
          loggers.api.debug(`[PERMISSIONS] Found explicit permissions - canView: ${permissions.canView}, canEdit: ${permissions.canEdit}`);
        }
      }
    }

    // Cache the result for future requests
    await getPermissionCache().setPagePermission(
      userId,
      pageId,
      pageData.driveId,
      permissions,
      isOwner,
      60 // 1 minute TTL
    );

    return permissions;

  } catch (error) {
    loggers.api.error('[PERMISSIONS] Error checking user access level', {
      userId,
      pageId,
      error: error instanceof Error ? error.message : String(error)
    });

    // Return null on error (deny access)
    return null;
  }
}

/**
 * Check if user has access to a drive by drive ID (cached version)
 * Returns true when the user owns the drive, is a drive member, or has page-level permissions within the drive.
 *
 * Performance improvements:
 * - Checks cache before database queries
 * - Caches both positive and negative results
 * - Silent logging by default
 */
export async function getUserDriveAccess(
  userId: string,
  driveId: string,
  options: { silent?: boolean; bypassCache?: boolean } = {}
): Promise<boolean> {
  const { silent = true, bypassCache = false } = options;

  try {
    // Check cache first (unless bypassed)
    if (!bypassCache) {
      const cached = await getPermissionCache().getDriveAccess(userId, driveId);
      if (cached) {
        if (!silent) {
          loggers.api.debug(`[DRIVE_ACCESS] Cache hit for userId: ${userId}, driveId: ${driveId} - result: ${cached.hasAccess}`);
        }
        return cached.hasAccess;
      }
    }

    if (!silent) {
      loggers.api.debug(`[DRIVE_ACCESS] Cache miss, checking database for userId: ${userId}, driveId: ${driveId}`);
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

      // Cache negative result
      await getPermissionCache().setDriveAccess(userId, driveId, false, false, 60);
      return false;
    }

    const driveData = drive[0];
    const isOwner = driveData.ownerId === userId;

    // Check if user is owner
    if (isOwner) {
      if (!silent) {
        loggers.api.debug(`[DRIVE_ACCESS] User is drive owner - granting access`);
      }

      // Cache positive result
      await getPermissionCache().setDriveAccess(userId, driveId, true, true, 60);
      return true;
    }

    if (!silent) {
      loggers.api.debug('[DRIVE_ACCESS] Checking drive membership');
    }

    // Drive members inherit access
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

      await getPermissionCache().setDriveAccess(userId, driveId, true, false, 60);
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

    // Cache the result
    await getPermissionCache().setDriveAccess(userId, driveId, hasAccess, false, 60);

    return hasAccess;

  } catch (error) {
    loggers.api.error('[DRIVE_ACCESS] Error checking user drive access', {
      userId,
      driveId,
      error: error instanceof Error ? error.message : String(error)
    });

    // Return false on error (deny access)
    return false;
  }
}

/**
 * Granular drive permission level for service token validation
 */
export interface DrivePermissionLevel {
  hasAccess: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  isMember: boolean;
  canEdit: boolean; // Owner, Admin, or Editor role
}

/**
 * Get user's granular permissions for a drive (for service token validation)
 *
 * Unlike getUserDriveAccess (which returns boolean for any access including page-level),
 * this function returns detailed role information. Page-level collaborators are NOT
 * considered to have drive-wide access - they must use page-scoped tokens instead.
 *
 * Use this for service token scope validation where we need to distinguish between:
 * - Drive owners (full access)
 * - Drive admins (full access)
 * - Drive editors (view + edit)
 * - Drive viewers (view only)
 * - Page collaborators (NO drive-wide access)
 */
export async function getUserDrivePermissions(
  userId: string,
  driveId: string,
  options: { silent?: boolean } = {}
): Promise<DrivePermissionLevel | null> {
  const { silent = true } = options;

  try {
    // Check drive exists
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

    // Drive owners have full permissions
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

    // Check drive membership with role
    const membership = await db
      .select({ role: driveMembers.role })
      .from(driveMembers)
      .where(
        and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId))
      )
      .limit(1);

    if (membership.length > 0) {
      const role = membership[0].role;
      const isAdmin = role === 'ADMIN';
      // Drive members (ADMIN or MEMBER) can edit drive content
      // MEMBERs can upload files, create pages, etc.
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

    // Page-level collaborators have NO drive-wide permissions
    // They must use page-scoped tokens instead
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

    // Return null on error (deny access)
    return null;
  }
}

/**
 * Batch get permissions for multiple pages (eliminates N+1 queries)
 *
 * This is a new function that enables efficient bulk permission checking
 * for search results and other scenarios where many permissions are needed.
 */
export async function getBatchPagePermissions(
  userId: string,
  pageIds: string[]
): Promise<Map<string, PermissionLevel>> {
  const results = new Map<string, PermissionLevel>();

  if (pageIds.length === 0) {
    return results;
  }

  try {
    // Get cached permissions first
    const cachedPermissions = await getPermissionCache().getBatchPagePermissions(userId, pageIds);
    const uncachedPageIds: string[] = [];

    // Separate cached from uncached
    for (const pageId of pageIds) {
      const cached = cachedPermissions.get(pageId);
      if (cached) {
        results.set(pageId, {
          canView: cached.canView,
          canEdit: cached.canEdit,
          canShare: cached.canShare,
          canDelete: cached.canDelete
        });
      } else {
        uncachedPageIds.push(pageId);
      }
    }

    // If all permissions were cached, return early
    if (uncachedPageIds.length === 0) {
      loggers.api.debug(`[BATCH_PERMISSIONS] All ${pageIds.length} permissions found in cache`);
      return results;
    }

    loggers.api.debug(`[BATCH_PERMISSIONS] Found ${cachedPermissions.size} cached, querying ${uncachedPageIds.length} from database`);

    // Query database for uncached permissions using efficient JOIN
    const pagesWithPermissions = await db.select({
      pageId: pages.id,
      driveId: pages.driveId,
      driveOwnerId: drives.ownerId,
      permissionCanView: pagePermissions.canView,
      permissionCanEdit: pagePermissions.canEdit,
      permissionCanShare: pagePermissions.canShare,
      permissionCanDelete: pagePermissions.canDelete,
    })
    .from(pages)
    .leftJoin(drives, eq(pages.driveId, drives.id))
    .leftJoin(pagePermissions, and(
      eq(pagePermissions.pageId, pages.id),
      eq(pagePermissions.userId, userId)
    ))
    .where(inArray(pages.id, uncachedPageIds));

    // Process results and cache them
    for (const row of pagesWithPermissions) {
      const isOwner = row.driveOwnerId === userId;
      let permissions: PermissionLevel;

      if (isOwner) {
        // Drive owner has full permissions
        permissions = {
          canView: true,
          canEdit: true,
          canShare: true,
          canDelete: true,
        };
      } else if (row.permissionCanView !== null) {
        // User has explicit permissions
        permissions = {
          canView: row.permissionCanView || false,
          canEdit: row.permissionCanEdit || false,
          canShare: row.permissionCanShare || false,
          canDelete: row.permissionCanDelete || false,
        };
      } else {
        // No permissions found - skip this page
        continue;
      }

      results.set(row.pageId, permissions);

      // Cache the result
      await getPermissionCache().setPagePermission(
        userId,
        row.pageId,
        row.driveId,
        permissions,
        isOwner,
        60
      );
    }

    loggers.api.debug(`[BATCH_PERMISSIONS] Processed ${pagesWithPermissions.length} permissions from database`);

    return results;

  } catch (error) {
    loggers.api.error('[BATCH_PERMISSIONS] Error in batch permission check', {
      userId,
      pageCount: pageIds.length,
      error: error instanceof Error ? error.message : String(error)
    });

    // Return partial results on error
    return results;
  }
}

/**
 * Check if user can view a page (cached)
 */
export async function canUserViewPage(
  userId: string,
  pageId: string
): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canView || false;
}

/**
 * Check if user can edit a page (cached)
 */
export async function canUserEditPage(
  userId: string,
  pageId: string
): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canEdit || false;
}

/**
 * Check if user can share a page (cached)
 */
export async function canUserSharePage(
  userId: string,
  pageId: string
): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canShare || false;
}

/**
 * Check if user can delete a page (cached)
 */
export async function canUserDeletePage(
  userId: string,
  pageId: string
): Promise<boolean> {
  const perms = await getUserAccessLevel(userId, pageId);
  return perms?.canDelete || false;
}

/**
 * Cache invalidation functions - call these when permissions change
 */

/**
 * Invalidate cache when user permissions change
 */
export async function invalidateUserPermissions(userId: string): Promise<void> {
  try {
    await getPermissionCache().invalidateUserCache(userId);
    loggers.security.info(`[PERMISSIONS] Invalidated cache for user`, { userId });
  } catch (error) {
    loggers.security.error('[PERMISSIONS] Failed to invalidate user cache — stale permissions may persist for up to 60s', {
      userId,
      staleTTLSeconds: 60,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Invalidate cache when drive permissions change
 */
export async function invalidateDrivePermissions(driveId: string): Promise<void> {
  try {
    await getPermissionCache().invalidateDriveCache(driveId);
    loggers.security.info(`[PERMISSIONS] Invalidated cache for drive`, { driveId });
  } catch (error) {
    loggers.security.error('[PERMISSIONS] Failed to invalidate drive cache — stale permissions may persist for up to 60s', {
      driveId,
      staleTTLSeconds: 60,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get permission cache statistics
 */
export function getPermissionCacheStats() {
  return getPermissionCache().getCacheStats();
}
