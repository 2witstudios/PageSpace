import { db, pages, users, pagePermissions, driveMembers, eq, and } from '@pagespace/db';
import { getUserAccessLevel } from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';

/**
 * Permission flags
 */
export interface PermissionFlags {
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
}

/**
 * User info for permission display
 */
export interface PermissionUser {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

/**
 * Permission entry
 */
export interface PermissionEntry {
  id: string;
  userId: string;
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
  grantedBy: string;
  grantedAt: Date;
  user: PermissionUser | null;
}

/**
 * Result types for permission operations
 */
export interface GetPermissionsSuccess {
  success: true;
  owner: PermissionUser;
  permissions: PermissionEntry[];
}

export interface GetPermissionsError {
  success: false;
  error: string;
  status: number;
}

export type GetPermissionsResult = GetPermissionsSuccess | GetPermissionsError;

export interface GrantPermissionSuccess {
  success: true;
  permission: PermissionEntry;
  isUpdate: boolean;
}

export interface GrantPermissionError {
  success: false;
  error: string;
  status: number;
}

export type GrantPermissionResult = GrantPermissionSuccess | GrantPermissionError;

export interface RevokePermissionSuccess {
  success: true;
}

export interface RevokePermissionError {
  success: false;
  error: string;
  status: number;
}

export type RevokePermissionResult = RevokePermissionSuccess | RevokePermissionError;

/**
 * Permission management service - encapsulates all DB operations for page permissions
 * This is the boundary seam that route tests should mock
 */
export const permissionManagementService = {
  /**
   * Check if user can view the permission list for a page
   */
  async canUserViewPermissions(userId: string, pageId: string): Promise<boolean> {
    const accessLevel = await getUserAccessLevel(userId, pageId);
    return accessLevel?.canShare || false;
  },

  /**
   * Check if user can manage (grant/revoke) permissions for a page
   */
  async canUserManagePermissions(userId: string, pageId: string): Promise<boolean> {
    // Check direct share permission
    const accessLevel = await getUserAccessLevel(userId, pageId);
    if (accessLevel?.canShare) return true;

    // Check if owner or admin
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      with: { drive: true }
    });

    if (!page?.drive) return false;

    // Owner check
    if (page.drive.ownerId === userId) return true;

    // Admin check
    const adminMembership = await db.select()
      .from(driveMembers)
      .where(and(
        eq(driveMembers.driveId, page.drive.id),
        eq(driveMembers.userId, userId),
        eq(driveMembers.role, 'ADMIN')
      ))
      .limit(1);

    return adminMembership.length > 0;
  },

  /**
   * Get all permissions for a page
   */
  async getPagePermissions(pageId: string): Promise<GetPermissionsResult> {
    const pageWithDrive = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      with: {
        drive: {
          with: {
            owner: {
              columns: { id: true, name: true, email: true, image: true },
            },
          },
        },
      },
    });

    if (!pageWithDrive) {
      return { success: false, error: 'Page not found', status: 404 };
    }

    const permissions = await db.select({
      id: pagePermissions.id,
      userId: pagePermissions.userId,
      canView: pagePermissions.canView,
      canEdit: pagePermissions.canEdit,
      canShare: pagePermissions.canShare,
      canDelete: pagePermissions.canDelete,
      grantedBy: pagePermissions.grantedBy,
      grantedAt: pagePermissions.grantedAt,
      user: {
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      }
    })
    .from(pagePermissions)
    .leftJoin(users, eq(pagePermissions.userId, users.id))
    .where(eq(pagePermissions.pageId, pageId));

    return {
      success: true,
      owner: pageWithDrive.drive.owner as PermissionUser,
      permissions: permissions.map(p => ({
        id: p.id,
        userId: p.userId,
        canView: p.canView,
        canEdit: p.canEdit,
        canShare: p.canShare,
        canDelete: p.canDelete,
        grantedBy: p.grantedBy,
        grantedAt: p.grantedAt,
        user: p.user as PermissionUser | null,
      })),
    };
  },

  /**
   * Grant or update permissions for a user on a page
   */
  async grantOrUpdatePermission(params: {
    pageId: string;
    targetUserId: string;
    permissions: PermissionFlags;
    grantedBy: string;
  }): Promise<GrantPermissionResult> {
    const { pageId, targetUserId, permissions, grantedBy } = params;

    // Check if permission already exists
    const existing = await db.query.pagePermissions.findFirst({
      where: and(
        eq(pagePermissions.pageId, pageId),
        eq(pagePermissions.userId, targetUserId)
      )
    });

    if (existing) {
      // Update existing permission
      const updated = await db.update(pagePermissions)
        .set({
          canView: permissions.canView,
          canEdit: permissions.canEdit,
          canShare: permissions.canShare,
          canDelete: permissions.canDelete,
        })
        .where(eq(pagePermissions.id, existing.id))
        .returning();

      return {
        success: true,
        permission: {
          ...updated[0],
          user: null, // User info not returned on update
        },
        isUpdate: true,
      };
    }

    // Create new permission
    const newPermission = await db.insert(pagePermissions).values({
      id: createId(),
      pageId,
      userId: targetUserId,
      canView: permissions.canView,
      canEdit: permissions.canEdit,
      canShare: permissions.canShare,
      canDelete: permissions.canDelete,
      grantedBy,
      grantedAt: new Date(),
    }).returning();

    return {
      success: true,
      permission: {
        ...newPermission[0],
        user: null, // User info not returned on create
      },
      isUpdate: false,
    };
  },

  /**
   * Revoke permissions for a user on a page
   */
  async revokePermission(params: {
    pageId: string;
    targetUserId: string;
  }): Promise<RevokePermissionResult> {
    const { pageId, targetUserId } = params;

    await db.delete(pagePermissions)
      .where(and(
        eq(pagePermissions.pageId, pageId),
        eq(pagePermissions.userId, targetUserId)
      ));

    return { success: true };
  },
};

export type PermissionManagementService = typeof permissionManagementService;
