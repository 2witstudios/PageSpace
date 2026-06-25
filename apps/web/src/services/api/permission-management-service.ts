import { db } from '@pagespace/db/db'
import { eq, and } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { pages } from '@pagespace/db/schema/core'
import { pagePermissions, driveMembers } from '@pagespace/db/schema/members';
import { decryptUserRow } from '@pagespace/lib/auth/user-repository';
import { getUserAccessLevel } from '@pagespace/lib/permissions/permissions';
import { listDriveRoles, getRoleById, updateDriveRole } from '@pagespace/lib/services/drive-role-service';
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
  grantedBy: string | null;  // Can be null if granter is deleted (onDelete: 'set null')
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
      // Decrypt PII at the edge so owner + grantee identities show plaintext.
      owner: (await decryptUserRow(pageWithDrive.drive.owner)) as PermissionUser,
      permissions: await Promise.all(permissions.map(async p => ({
        id: p.id,
        userId: p.userId,
        canView: p.canView,
        canEdit: p.canEdit,
        canShare: p.canShare,
        canDelete: p.canDelete,
        grantedBy: p.grantedBy,
        grantedAt: p.grantedAt,
        user: (await decryptUserRow(p.user)) as PermissionUser | null,
      }))),
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

    // Use transaction to prevent race conditions on concurrent requests
    const result = await db.transaction(async (tx) => {
      // Check if permission already exists within transaction
      const existing = await tx.query.pagePermissions.findFirst({
        where: and(
          eq(pagePermissions.pageId, pageId),
          eq(pagePermissions.userId, targetUserId)
        )
      });

      if (existing) {
        // Update existing permission
        const updated = await tx.update(pagePermissions)
          .set({
            canView: permissions.canView,
            canEdit: permissions.canEdit,
            canShare: permissions.canShare,
            canDelete: permissions.canDelete,
          })
          .where(eq(pagePermissions.id, existing.id))
          .returning();

        return {
          permission: updated[0],
          isUpdate: true,
        };
      }

      // Create new permission
      const newPermission = await tx.insert(pagePermissions).values({
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
        permission: newPermission[0],
        isUpdate: false,
      };
    });

    return {
      success: true,
      permission: {
        ...result.permission,
        user: null, // User info not returned on create/update
      },
      isUpdate: result.isUpdate,
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

// ============================================================================
// Role permission types
// ============================================================================

export interface RolePermissionFlags {
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
}

export interface RoleGrant extends RolePermissionFlags {
  roleId: string;
  name: string;
  color: string | null;
}

type RolePermResult = { success: true } | { success: false; error: string; status: number };

// ============================================================================
// Role permission service functions
// ============================================================================

export const rolePermissionService = {
  async getPageRoleGrants(pageId: string): Promise<RoleGrant[]> {
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { driveId: true },
    });
    if (!page) return [];

    const roles = await listDriveRoles(page.driveId);
    return roles
      .filter(role => role.permissions[pageId] != null)
      .map(role => ({
        roleId: role.id,
        name: role.name,
        color: role.color,
        canView: role.permissions[pageId].canView,
        canEdit: role.permissions[pageId].canEdit,
        canShare: role.permissions[pageId].canShare,
      }));
  },

  async setRolePagePermission(
    actorUserId: string,
    pageId: string,
    roleId: string,
    permissions: RolePermissionFlags,
  ): Promise<RolePermResult> {
    if ((permissions.canEdit || permissions.canShare) && !permissions.canView) {
      return { success: false, error: 'canView must be true when canEdit or canShare is set', status: 400 };
    }

    const canManage = await permissionManagementService.canUserManagePermissions(actorUserId, pageId);
    if (!canManage) return { success: false, error: 'Insufficient permissions', status: 403 };

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { driveId: true },
    });
    if (!page) return { success: false, error: 'Page not found', status: 404 };

    const role = await getRoleById(page.driveId, roleId);
    if (!role) return { success: false, error: 'Role not found', status: 404 };

    await updateDriveRole(page.driveId, roleId, {
      permissions: {
        ...role.permissions,
        [pageId]: {
          canView: permissions.canView,
          canEdit: permissions.canEdit,
          canShare: permissions.canShare,
        },
      },
    });
    return { success: true };
  },

  async removeRolePagePermission(
    actorUserId: string,
    pageId: string,
    roleId: string,
  ): Promise<RolePermResult> {
    const canManage = await permissionManagementService.canUserManagePermissions(actorUserId, pageId);
    if (!canManage) return { success: false, error: 'Insufficient permissions', status: 403 };

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { driveId: true },
    });
    if (!page) return { success: false, error: 'Page not found', status: 404 };

    const role = await getRoleById(page.driveId, roleId);
    if (!role) return { success: false, error: 'Role not found', status: 404 };

    const remainingPermissions = Object.fromEntries(
      Object.entries(role.permissions).filter(([key]) => key !== pageId)
    );
    await updateDriveRole(page.driveId, roleId, { permissions: remainingPermissions });
    return { success: true };
  },
};
