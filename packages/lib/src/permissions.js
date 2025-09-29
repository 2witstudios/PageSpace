"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserAccessLevel = getUserAccessLevel;
exports.canUserViewPage = canUserViewPage;
exports.canUserEditPage = canUserEditPage;
exports.canUserSharePage = canUserSharePage;
exports.canUserDeletePage = canUserDeletePage;
exports.isUserDriveMember = isUserDriveMember;
exports.getUserAccessiblePagesInDrive = getUserAccessiblePagesInDrive;
exports.getUserAccessiblePagesInDriveWithDetails = getUserAccessiblePagesInDriveWithDetails;
exports.grantPagePermissions = grantPagePermissions;
exports.revokePagePermissions = revokePagePermissions;
exports.getUserDriveAccess = getUserDriveAccess;
const db_1 = require("@pagespace/db");
const db_2 = require("@pagespace/db");
const permission_cache_1 = require("./services/permission-cache");
const logger_config_1 = require("./logger-config");
/**
 * Get user access level for a page
 * Simple permission check - no inheritance, direct permissions only
 */
async function getUserAccessLevel(userId, pageId, options = {}) {
    const { silent = true } = options; // Default to silent for better performance
    try {
        if (!silent) {
            logger_config_1.loggers.api.debug(`[PERMISSIONS] Checking access for userId: ${userId}, pageId: ${pageId}`);
        }
        // 1. Get the page and its drive
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
            return null; // Page not found
        }
        const pageData = page[0];
        if (!silent) {
            logger_config_1.loggers.api.debug(`[PERMISSIONS] Page found - driveId: ${pageData.driveId}, driveOwnerId: ${pageData.driveOwnerId}`);
        }
        // 2. Check if user is drive owner (has all permissions)
        if (pageData.driveOwnerId === userId) {
            if (!silent) {
                logger_config_1.loggers.api.debug(`[PERMISSIONS] User is drive owner - granting full access`);
            }
            return {
                canView: true,
                canEdit: true,
                canShare: true,
                canDelete: true,
            };
        }
        if (!silent) {
            logger_config_1.loggers.api.debug(`[PERMISSIONS] User is NOT drive owner - checking explicit permissions`);
        }
        // 3. Check direct page permissions
        const permission = await db_1.db.select()
            .from(db_2.pagePermissions)
            .where((0, db_1.and)((0, db_1.eq)(db_2.pagePermissions.pageId, pageId), (0, db_1.eq)(db_2.pagePermissions.userId, userId)))
            .limit(1);
        if (permission.length === 0) {
            if (!silent) {
                logger_config_1.loggers.api.debug(`[PERMISSIONS] No explicit permissions found - denying access`);
            }
            return null; // No access
        }
        if (!silent) {
            logger_config_1.loggers.api.debug(`[PERMISSIONS] Found explicit permissions - canView: ${permission[0].canView}, canEdit: ${permission[0].canEdit}`);
        }
        return {
            canView: permission[0].canView,
            canEdit: permission[0].canEdit,
            canShare: permission[0].canShare,
            canDelete: permission[0].canDelete,
        };
    }
    catch (error) {
        logger_config_1.loggers.api.error('[PERMISSIONS] Error checking user access level', {
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
async function canUserViewPage(userId, pageId) {
    const perms = await getUserAccessLevel(userId, pageId);
    return perms?.canView || false;
}
/**
 * Check if user can edit a page
 */
async function canUserEditPage(userId, pageId) {
    const perms = await getUserAccessLevel(userId, pageId);
    return perms?.canEdit || false;
}
/**
 * Check if user can share a page
 */
async function canUserSharePage(userId, pageId) {
    const perms = await getUserAccessLevel(userId, pageId);
    return perms?.canShare || false;
}
/**
 * Check if user can delete a page
 */
async function canUserDeletePage(userId, pageId) {
    const perms = await getUserAccessLevel(userId, pageId);
    return perms?.canDelete || false;
}
/**
 * Check if user is a member of a drive
 */
async function isUserDriveMember(userId, driveId) {
    // Check if user is drive owner
    const drive = await db_1.db.select()
        .from(db_2.drives)
        .where((0, db_1.eq)(db_2.drives.id, driveId))
        .limit(1);
    if (drive.length > 0 && drive[0].ownerId === userId) {
        return true;
    }
    // Check if user is a drive member
    const membership = await db_1.db.select()
        .from(db_2.driveMembers)
        .where((0, db_1.and)((0, db_1.eq)(db_2.driveMembers.driveId, driveId), (0, db_1.eq)(db_2.driveMembers.userId, userId)))
        .limit(1);
    return membership.length > 0;
}
/**
 * Get all pages a user has access to in a drive
 */
async function getUserAccessiblePagesInDrive(userId, driveId) {
    // Check if user is drive owner
    const drive = await db_1.db.select()
        .from(db_2.drives)
        .where((0, db_1.eq)(db_2.drives.id, driveId))
        .limit(1);
    if (drive.length > 0 && drive[0].ownerId === userId) {
        // Owner has access to all pages
        const allPages = await db_1.db.select({ id: db_2.pages.id })
            .from(db_2.pages)
            .where((0, db_1.eq)(db_2.pages.driveId, driveId));
        return allPages.map((page) => page.id);
    }
    // Get pages with explicit permissions
    const permissions = await db_1.db.select({ pageId: db_2.pagePermissions.pageId })
        .from(db_2.pagePermissions)
        .leftJoin(db_2.pages, (0, db_1.eq)(db_2.pagePermissions.pageId, db_2.pages.id))
        .where((0, db_1.and)((0, db_1.eq)(db_2.pagePermissions.userId, userId), (0, db_1.eq)(db_2.pages.driveId, driveId), (0, db_1.eq)(db_2.pagePermissions.canView, true)));
    return permissions.map((entry) => entry.pageId);
}
/**
 * Get all pages a user has access to in a drive with full page details and permissions
 * Optimized to avoid N+1 queries by using batch permission checks
 */
async function getUserAccessiblePagesInDriveWithDetails(userId, driveId) {
    // Check if user is drive owner
    const drive = await db_1.db.select()
        .from(db_2.drives)
        .where((0, db_1.eq)(db_2.drives.id, driveId))
        .limit(1);
    if (drive.length === 0) {
        return [];
    }
    if (drive[0].ownerId === userId) {
        // Owner has access to all pages with full permissions
        const allPages = await db_1.db.select({
            id: db_2.pages.id,
            title: db_2.pages.title,
            type: db_2.pages.type,
            parentId: db_2.pages.parentId,
            position: db_2.pages.position,
            isTrashed: db_2.pages.isTrashed,
        })
            .from(db_2.pages)
            .where((0, db_1.and)((0, db_1.eq)(db_2.pages.driveId, driveId), (0, db_1.eq)(db_2.pages.isTrashed, false)));
        return allPages.map((page) => ({
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
    const pagesWithPermissions = await db_1.db.select({
        id: db_2.pages.id,
        title: db_2.pages.title,
        type: db_2.pages.type,
        parentId: db_2.pages.parentId,
        position: db_2.pages.position,
        isTrashed: db_2.pages.isTrashed,
        canView: db_2.pagePermissions.canView,
        canEdit: db_2.pagePermissions.canEdit,
        canShare: db_2.pagePermissions.canShare,
        canDelete: db_2.pagePermissions.canDelete,
    })
        .from(db_2.pages)
        .innerJoin(db_2.pagePermissions, (0, db_1.eq)(db_2.pages.id, db_2.pagePermissions.pageId))
        .where((0, db_1.and)((0, db_1.eq)(db_2.pages.driveId, driveId), (0, db_1.eq)(db_2.pages.isTrashed, false), (0, db_1.eq)(db_2.pagePermissions.userId, userId), (0, db_1.eq)(db_2.pagePermissions.canView, true)));
    return pagesWithPermissions.map((page) => ({
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
async function grantPagePermissions(pageId, userId, permissions, grantedBy) {
    const pageRecord = await db_1.db.select({ driveId: db_2.pages.driveId })
        .from(db_2.pages)
        .where((0, db_1.eq)(db_2.pages.id, pageId))
        .limit(1);
    const driveId = pageRecord[0]?.driveId;
    // Check if permission already exists
    const existing = await db_1.db.select()
        .from(db_2.pagePermissions)
        .where((0, db_1.and)((0, db_1.eq)(db_2.pagePermissions.pageId, pageId), (0, db_1.eq)(db_2.pagePermissions.userId, userId)))
        .limit(1);
    if (existing.length > 0) {
        // Update existing permission
        await db_1.db.update(db_2.pagePermissions)
            .set({
            canView: permissions.canView,
            canEdit: permissions.canEdit,
            canShare: permissions.canShare,
            canDelete: permissions.canDelete || false,
            grantedBy,
            grantedAt: new Date(),
        })
            .where((0, db_1.eq)(db_2.pagePermissions.id, existing[0].id));
    }
    else {
        // Create new permission
        await db_1.db.insert(db_2.pagePermissions)
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
        permission_cache_1.permissionCache.invalidateUserCache(userId),
        driveId ? permission_cache_1.permissionCache.invalidateDriveCache(driveId) : Promise.resolve()
    ]);
}
/**
 * Revoke all permissions for a user on a page
 */
async function revokePagePermissions(pageId, userId) {
    const pageRecord = await db_1.db.select({ driveId: db_2.pages.driveId })
        .from(db_2.pages)
        .where((0, db_1.eq)(db_2.pages.id, pageId))
        .limit(1);
    const driveId = pageRecord[0]?.driveId;
    await db_1.db.delete(db_2.pagePermissions)
        .where((0, db_1.and)((0, db_1.eq)(db_2.pagePermissions.pageId, pageId), (0, db_1.eq)(db_2.pagePermissions.userId, userId)));
    await Promise.all([
        permission_cache_1.permissionCache.invalidateUserCache(userId),
        driveId ? permission_cache_1.permissionCache.invalidateDriveCache(driveId) : Promise.resolve()
    ]);
}
/**
 * Check if user has access to a drive by drive ID
 * Returns true if user owns the drive, is a member of the drive, or has any page permissions in the drive
 */
async function getUserDriveAccess(userId, driveId, options = {}) {
    const { silent = true } = options; // Default to silent for better performance
    try {
        if (!silent) {
            logger_config_1.loggers.api.debug(`[DRIVE_ACCESS] Checking access for userId: ${userId}, driveId: ${driveId}`);
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
            return false;
        }
        const driveData = drive[0];
        if (!silent) {
            logger_config_1.loggers.api.debug(`[DRIVE_ACCESS] Drive found - id: ${driveData.id}, ownerId: ${driveData.ownerId}`);
        }
        // Check if user is owner
        if (driveData.ownerId === userId) {
            if (!silent) {
                logger_config_1.loggers.api.debug(`[DRIVE_ACCESS] User is drive owner - granting access`);
            }
            return true;
        }
        if (!silent) {
            logger_config_1.loggers.api.debug('[DRIVE_ACCESS] User is NOT drive owner - checking drive membership');
        }
        // Drive members inherit access to the entire drive
        const membership = await db_1.db.select({ id: db_2.driveMembers.id })
            .from(db_2.driveMembers)
            .where((0, db_1.and)((0, db_1.eq)(db_2.driveMembers.driveId, driveData.id), (0, db_1.eq)(db_2.driveMembers.userId, userId)))
            .limit(1);
        if (membership.length > 0) {
            if (!silent) {
                logger_config_1.loggers.api.debug('[DRIVE_ACCESS] User is a drive member - granting access');
            }
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
        return hasAccess;
    }
    catch (error) {
        logger_config_1.loggers.api.error('[DRIVE_ACCESS] Error checking user drive access', {
            userId,
            driveId,
            error: error instanceof Error ? error.message : String(error)
        });
        return false; // Deny access on error
    }
}
