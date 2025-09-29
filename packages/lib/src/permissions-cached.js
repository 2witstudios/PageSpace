"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserAccessLevel = getUserAccessLevel;
exports.getUserDriveAccess = getUserDriveAccess;
exports.getBatchPagePermissions = getBatchPagePermissions;
exports.canUserViewPage = canUserViewPage;
exports.canUserEditPage = canUserEditPage;
exports.canUserSharePage = canUserSharePage;
exports.canUserDeletePage = canUserDeletePage;
exports.invalidateUserPermissions = invalidateUserPermissions;
exports.invalidateDrivePermissions = invalidateDrivePermissions;
exports.getPermissionCacheStats = getPermissionCacheStats;
const db_1 = require("@pagespace/db");
const db_2 = require("@pagespace/db");
const permission_cache_1 = require("./services/permission-cache");
const logger_config_1 = require("./logger-config");
// Lazy initialization to prevent module-level instantiation
const getPermissionCache = () => permission_cache_1.PermissionCache.getInstance();
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
async function getUserAccessLevel(userId, pageId, options = {}) {
    const { silent = true, bypassCache = false } = options;
    try {
        // Check cache first (unless bypassed)
        if (!bypassCache) {
            const cached = await getPermissionCache().getPagePermission(userId, pageId);
            if (cached) {
                if (!silent) {
                    logger_config_1.loggers.api.debug(`[PERMISSIONS] Cache hit for userId: ${userId}, pageId: ${pageId}`);
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
            logger_config_1.loggers.api.debug(`[PERMISSIONS] Cache miss, checking database for userId: ${userId}, pageId: ${pageId}`);
        }
        // Cache miss - query database
        const page = await db_1.db.select({
            id: db_2.pages.id,
            driveId: db_2.pages.driveId,
            driveOwnerId: db_2.drives.ownerId,
        })
            .from(db_2.pages)
            .leftJoin(db_2.drives, (0, db_1.eq)(db_2.pages.driveId, db_2.drives.id))
            .where((0, db_1.eq)(db_2.pages.id, pageId))
            .limit(1);
        if (page.length === 0) {
            if (!silent) {
                logger_config_1.loggers.api.debug(`[PERMISSIONS] Page not found: ${pageId}`);
            }
            return null;
        }
        const pageData = page[0];
        const isOwner = pageData.driveOwnerId === userId;
        let permissions;
        // Check if user is drive owner (has all permissions)
        if (isOwner) {
            permissions = {
                canView: true,
                canEdit: true,
                canShare: true,
                canDelete: true,
            };
            if (!silent) {
                logger_config_1.loggers.api.debug(`[PERMISSIONS] User is drive owner - granting full access`);
            }
        }
        else {
            // Check direct page permissions
            const permission = await db_1.db.select()
                .from(db_2.pagePermissions)
                .where((0, db_1.and)((0, db_1.eq)(db_2.pagePermissions.pageId, pageId), (0, db_1.eq)(db_2.pagePermissions.userId, userId)))
                .limit(1);
            if (permission.length === 0) {
                if (!silent) {
                    logger_config_1.loggers.api.debug(`[PERMISSIONS] No explicit permissions found - denying access`);
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
                logger_config_1.loggers.api.debug(`[PERMISSIONS] Found explicit permissions - canView: ${permissions.canView}, canEdit: ${permissions.canEdit}`);
            }
        }
        // Cache the result for future requests
        await getPermissionCache().setPagePermission(userId, pageId, pageData.driveId, permissions, isOwner, 60 // 1 minute TTL
        );
        return permissions;
    }
    catch (error) {
        logger_config_1.loggers.api.error('[PERMISSIONS] Error checking user access level', {
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
async function getUserDriveAccess(userId, driveId, options = {}) {
    const { silent = true, bypassCache = false } = options;
    try {
        // Check cache first (unless bypassed)
        if (!bypassCache) {
            const cached = await getPermissionCache().getDriveAccess(userId, driveId);
            if (cached) {
                if (!silent) {
                    logger_config_1.loggers.api.debug(`[DRIVE_ACCESS] Cache hit for userId: ${userId}, driveId: ${driveId} - result: ${cached.hasAccess}`);
                }
                return cached.hasAccess;
            }
        }
        if (!silent) {
            logger_config_1.loggers.api.debug(`[DRIVE_ACCESS] Cache miss, checking database for userId: ${userId}, driveId: ${driveId}`);
        }
        // Get drive by ID
        const drive = await db_1.db.select()
            .from(db_2.drives)
            .where((0, db_1.eq)(db_2.drives.id, driveId))
            .limit(1);
        if (drive.length === 0) {
            if (!silent) {
                logger_config_1.loggers.api.debug(`[DRIVE_ACCESS] Drive not found: ${driveId}`);
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
                logger_config_1.loggers.api.debug(`[DRIVE_ACCESS] User is drive owner - granting access`);
            }
            // Cache positive result
            await getPermissionCache().setDriveAccess(userId, driveId, true, true, 60);
            return true;
        }
        if (!silent) {
            logger_config_1.loggers.api.debug('[DRIVE_ACCESS] Checking drive membership');
        }
        // Drive members inherit access
        const membership = await db_1.db.select({ id: db_2.driveMembers.id })
            .from(db_2.driveMembers)
            .where((0, db_1.and)((0, db_1.eq)(db_2.driveMembers.driveId, driveData.id), (0, db_1.eq)(db_2.driveMembers.userId, userId)))
            .limit(1);
        if (membership.length > 0) {
            if (!silent) {
                logger_config_1.loggers.api.debug('[DRIVE_ACCESS] User is a drive member - granting access');
            }
            await getPermissionCache().setDriveAccess(userId, driveId, true, false, 60);
            return true;
        }
        if (!silent) {
            logger_config_1.loggers.api.debug('[DRIVE_ACCESS] User is not a drive member - checking page permissions');
        }
        // Check if user has any page permissions in this drive
        const pageAccess = await db_1.db.select({ id: db_2.pagePermissions.id })
            .from(db_2.pagePermissions)
            .leftJoin(db_2.pages, (0, db_1.eq)(db_2.pagePermissions.pageId, db_2.pages.id))
            .where((0, db_1.and)((0, db_1.eq)(db_2.pages.driveId, driveData.id), (0, db_1.eq)(db_2.pagePermissions.userId, userId), (0, db_1.eq)(db_2.pagePermissions.canView, true)))
            .limit(1);
        const hasAccess = pageAccess.length > 0;
        if (!silent) {
            logger_config_1.loggers.api.debug(`[DRIVE_ACCESS] Page access check result: ${hasAccess}`);
        }
        // Cache the result
        await getPermissionCache().setDriveAccess(userId, driveId, hasAccess, false, 60);
        return hasAccess;
    }
    catch (error) {
        logger_config_1.loggers.api.error('[DRIVE_ACCESS] Error checking user drive access', {
            userId,
            driveId,
            error: error instanceof Error ? error.message : String(error)
        });
        // Return false on error (deny access)
        return false;
    }
}
/**
 * Batch get permissions for multiple pages (eliminates N+1 queries)
 *
 * This is a new function that enables efficient bulk permission checking
 * for search results and other scenarios where many permissions are needed.
 */
async function getBatchPagePermissions(userId, pageIds) {
    const results = new Map();
    if (pageIds.length === 0) {
        return results;
    }
    try {
        // Get cached permissions first
        const cachedPermissions = await getPermissionCache().getBatchPagePermissions(userId, pageIds);
        const uncachedPageIds = [];
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
            }
            else {
                uncachedPageIds.push(pageId);
            }
        }
        // If all permissions were cached, return early
        if (uncachedPageIds.length === 0) {
            logger_config_1.loggers.api.debug(`[BATCH_PERMISSIONS] All ${pageIds.length} permissions found in cache`);
            return results;
        }
        logger_config_1.loggers.api.debug(`[BATCH_PERMISSIONS] Found ${cachedPermissions.size} cached, querying ${uncachedPageIds.length} from database`);
        // Query database for uncached permissions using efficient JOIN
        const pagesWithPermissions = await db_1.db.select({
            pageId: db_2.pages.id,
            driveId: db_2.pages.driveId,
            driveOwnerId: db_2.drives.ownerId,
            permissionCanView: db_2.pagePermissions.canView,
            permissionCanEdit: db_2.pagePermissions.canEdit,
            permissionCanShare: db_2.pagePermissions.canShare,
            permissionCanDelete: db_2.pagePermissions.canDelete,
        })
            .from(db_2.pages)
            .leftJoin(db_2.drives, (0, db_1.eq)(db_2.pages.driveId, db_2.drives.id))
            .leftJoin(db_2.pagePermissions, (0, db_1.and)((0, db_1.eq)(db_2.pagePermissions.pageId, db_2.pages.id), (0, db_1.eq)(db_2.pagePermissions.userId, userId)))
            .where((0, db_1.inArray)(db_2.pages.id, uncachedPageIds));
        // Process results and cache them
        for (const row of pagesWithPermissions) {
            const isOwner = row.driveOwnerId === userId;
            let permissions;
            if (isOwner) {
                // Drive owner has full permissions
                permissions = {
                    canView: true,
                    canEdit: true,
                    canShare: true,
                    canDelete: true,
                };
            }
            else if (row.permissionCanView !== null) {
                // User has explicit permissions
                permissions = {
                    canView: row.permissionCanView || false,
                    canEdit: row.permissionCanEdit || false,
                    canShare: row.permissionCanShare || false,
                    canDelete: row.permissionCanDelete || false,
                };
            }
            else {
                // No permissions found - skip this page
                continue;
            }
            results.set(row.pageId, permissions);
            // Cache the result
            await getPermissionCache().setPagePermission(userId, row.pageId, row.driveId, permissions, isOwner, 60);
        }
        logger_config_1.loggers.api.debug(`[BATCH_PERMISSIONS] Processed ${pagesWithPermissions.length} permissions from database`);
        return results;
    }
    catch (error) {
        logger_config_1.loggers.api.error('[BATCH_PERMISSIONS] Error in batch permission check', {
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
async function canUserViewPage(userId, pageId) {
    const perms = await getUserAccessLevel(userId, pageId);
    return perms?.canView || false;
}
/**
 * Check if user can edit a page (cached)
 */
async function canUserEditPage(userId, pageId) {
    const perms = await getUserAccessLevel(userId, pageId);
    return perms?.canEdit || false;
}
/**
 * Check if user can share a page (cached)
 */
async function canUserSharePage(userId, pageId) {
    const perms = await getUserAccessLevel(userId, pageId);
    return perms?.canShare || false;
}
/**
 * Check if user can delete a page (cached)
 */
async function canUserDeletePage(userId, pageId) {
    const perms = await getUserAccessLevel(userId, pageId);
    return perms?.canDelete || false;
}
/**
 * Cache invalidation functions - call these when permissions change
 */
/**
 * Invalidate cache when user permissions change
 */
async function invalidateUserPermissions(userId) {
    await getPermissionCache().invalidateUserCache(userId);
    logger_config_1.loggers.api.info(`[PERMISSIONS] Invalidated cache for user ${userId}`);
}
/**
 * Invalidate cache when drive permissions change
 */
async function invalidateDrivePermissions(driveId) {
    await getPermissionCache().invalidateDriveCache(driveId);
    logger_config_1.loggers.api.info(`[PERMISSIONS] Invalidated cache for drive ${driveId}`);
}
/**
 * Get permission cache statistics
 */
function getPermissionCacheStats() {
    return getPermissionCache().getCacheStats();
}
