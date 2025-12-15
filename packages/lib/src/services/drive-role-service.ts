/**
 * DriveRoleService - Service seam for drive role operations
 *
 * This service encapsulates all database operations related to drive roles,
 * providing a clean seam for testing at the service level rather than the ORM level.
 */

import { db, eq, and, asc } from '@pagespace/db';
import { driveRoles, drives, driveMembers } from '@pagespace/db';

// ============================================================================
// Types
// ============================================================================

export interface DriveRole {
  id: string;
  driveId: string;
  name: string;
  description: string | null;
  color: string | null;
  isDefault: boolean;
  permissions: RolePermissions;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export type RolePermissions = Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;

export interface CreateRoleInput {
  name: string;
  description?: string | null;
  color?: string | null;
  isDefault?: boolean;
  permissions: RolePermissions;
}

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
  color?: string | null;
  isDefault?: boolean;
  permissions?: RolePermissions;
}

export interface DriveRoleAccessInfo {
  isOwner: boolean;
  isAdmin: boolean;
  isMember: boolean;
  drive: {
    id: string;
    name: string;
    slug: string;
    ownerId: string;
  } | null;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Check user's access level for a drive (reused from drive-member-service pattern)
 */
export async function checkDriveAccessForRoles(
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
 * List all roles for a drive, ordered by position
 */
export async function listDriveRoles(driveId: string): Promise<DriveRole[]> {
  const roles = await db.query.driveRoles.findMany({
    where: eq(driveRoles.driveId, driveId),
    orderBy: [asc(driveRoles.position)],
  });

  return roles as DriveRole[];
}

/**
 * Get a specific role by ID
 */
export async function getRoleById(
  driveId: string,
  roleId: string
): Promise<DriveRole | null> {
  const role = await db.query.driveRoles.findFirst({
    where: and(
      eq(driveRoles.id, roleId),
      eq(driveRoles.driveId, driveId)
    ),
  });

  return role as DriveRole | null;
}

/**
 * Create a new role for a drive
 */
export async function createDriveRole(
  driveId: string,
  input: CreateRoleInput
): Promise<DriveRole> {
  // Get the highest position to add new role at the end
  const existingRoles = await db.query.driveRoles.findMany({
    where: eq(driveRoles.driveId, driveId),
    orderBy: [asc(driveRoles.position)],
  });

  const maxPosition = existingRoles.length > 0
    ? Math.max(...existingRoles.map(r => r.position)) + 1
    : 0;

  // If setting as default, unset other defaults
  if (input.isDefault) {
    await db.update(driveRoles)
      .set({ isDefault: false })
      .where(eq(driveRoles.driveId, driveId));
  }

  const [newRole] = await db.insert(driveRoles).values({
    driveId,
    name: input.name.trim(),
    description: input.description,
    color: input.color,
    isDefault: input.isDefault || false,
    permissions: input.permissions,
    position: maxPosition,
    updatedAt: new Date(),
  }).returning();

  return newRole as DriveRole;
}

/**
 * Update an existing role
 */
export async function updateDriveRole(
  driveId: string,
  roleId: string,
  input: UpdateRoleInput
): Promise<{ role: DriveRole; wasDefault: boolean }> {
  // Get existing role
  const existingRole = await db.query.driveRoles.findFirst({
    where: and(
      eq(driveRoles.id, roleId),
      eq(driveRoles.driveId, driveId)
    ),
  });

  if (!existingRole) {
    throw new Error('Role not found');
  }

  // If setting as default and wasn't already, unset other defaults
  if (input.isDefault && !existingRole.isDefault) {
    await db.update(driveRoles)
      .set({ isDefault: false })
      .where(eq(driveRoles.driveId, driveId));
  }

  const [updatedRole] = await db.update(driveRoles)
    .set({
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.color !== undefined && { color: input.color }),
      ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
      ...(input.permissions !== undefined && { permissions: input.permissions }),
      updatedAt: new Date(),
    })
    .where(and(
      eq(driveRoles.id, roleId),
      eq(driveRoles.driveId, driveId)
    ))
    .returning();

  return {
    role: updatedRole as DriveRole,
    wasDefault: existingRole.isDefault,
  };
}

/**
 * Delete a role
 */
export async function deleteDriveRole(
  driveId: string,
  roleId: string
): Promise<void> {
  // Verify role exists
  const existingRole = await db.query.driveRoles.findFirst({
    where: and(
      eq(driveRoles.id, roleId),
      eq(driveRoles.driveId, driveId)
    ),
  });

  if (!existingRole) {
    throw new Error('Role not found');
  }

  await db.delete(driveRoles)
    .where(and(
      eq(driveRoles.id, roleId),
      eq(driveRoles.driveId, driveId)
    ));
}

/**
 * Reorder roles for a drive
 */
export async function reorderDriveRoles(
  driveId: string,
  roleIds: string[]
): Promise<void> {
  // Validate that all roleIds belong to this drive
  const existingRoles = await db.query.driveRoles.findMany({
    where: eq(driveRoles.driveId, driveId),
    columns: { id: true },
  });
  const existingIds = new Set(existingRoles.map(r => r.id));
  const invalidIds = roleIds.filter(id => !existingIds.has(id));

  if (invalidIds.length > 0) {
    throw new Error('Invalid role IDs');
  }

  // Update positions in a transaction
  await db.transaction(async (tx) => {
    for (let index = 0; index < roleIds.length; index++) {
      const roleId = roleIds[index];
      await tx.update(driveRoles)
        .set({ position: index, updatedAt: new Date() })
        .where(and(
          eq(driveRoles.id, roleId),
          eq(driveRoles.driveId, driveId)
        ));
    }
  });
}

/**
 * Validate permissions structure
 */
export function validateRolePermissions(permissions: unknown): permissions is RolePermissions {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return false;

  for (const [pageId, perms] of Object.entries(permissions)) {
    if (typeof pageId !== 'string') return false;
    if (!perms || typeof perms !== 'object') return false;
    const p = perms as Record<string, unknown>;
    if (typeof p.canView !== 'boolean' ||
        typeof p.canEdit !== 'boolean' ||
        typeof p.canShare !== 'boolean') return false;
  }

  return true;
}
