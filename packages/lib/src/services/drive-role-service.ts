/**
 * DriveRoleService - Service seam for drive role operations
 *
 * This service encapsulates all database operations related to drive roles,
 * providing a clean seam for testing at the service level rather than the ORM level.
 */

import { db } from '@pagespace/db/db';
import { eq, and, asc } from '@pagespace/db/operators';
import { driveRoles } from '@pagespace/db/schema/members';
import type { PagePerm } from '../permissions/membership-queries';
import { getDriveAccessLevel } from '../permissions/drive-access-level';
import { computeReorderPlan, lockedBatchReorder } from './reorder';

// Re-export canonical type so callers can import from one place
export type { PagePerm };

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
  driveWidePermissions: PagePerm | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export type RolePermissions = Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;

// Per-page permission patch: a value merges/overwrites that page's entry, `null` prunes it
// (falls back to driveWidePermissions) rather than writing an explicit all-false entry.
export type RolePermissionsPatch = Record<string, { canView: boolean; canEdit: boolean; canShare: boolean } | null>;

export interface CreateRoleInput {
  name: string;
  description?: string | null;
  color?: string | null;
  isDefault?: boolean;
  permissions: RolePermissions;
  driveWidePermissions?: PagePerm | null;
}

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
  color?: string | null;
  isDefault?: boolean;
  // Mutually exclusive with `permissionsPatch`: `permissions` replaces the whole
  // map, `permissionsPatch` merges specific pages atomically against whatever is
  // currently stored (see `updateDriveRole`).
  permissions?: RolePermissions;
  permissionsPatch?: RolePermissionsPatch;
  driveWidePermissions?: PagePerm | null;
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
 * Check user's access level for a drive.
 * Delegates to the centralized `getDriveAccessLevel` and narrows the drive
 * shape to what role management needs.
 */
export async function checkDriveAccessForRoles(
  driveId: string,
  userId: string
): Promise<DriveRoleAccessInfo> {
  const access = await getDriveAccessLevel(driveId, userId);

  return {
    isOwner: access.isOwner,
    isAdmin: access.isAdmin,
    isMember: access.isMember,
    drive: access.drive
      ? {
          id: access.drive.id,
          name: access.drive.name,
          slug: access.drive.slug,
          ownerId: access.drive.ownerId,
        }
      : null,
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Lock every role row in the drive with `FOR UPDATE`, acquiring the locks in a
 * consistent (id) order.
 *
 * Any mutation that writes drive-wide (unsetting other roles' `isDefault`,
 * reordering positions) needs locks on all of the drive's role rows. If each
 * writer locked rows in its own order, two concurrent writers could each hold
 * a row the other needs — a Postgres deadlock. Funneling every drive-wide
 * writer through this single id-ordered acquisition serializes them instead.
 */
async function lockDriveRolesInOrder(tx: Tx, driveId: string) {
  return tx
    .select()
    .from(driveRoles)
    .where(eq(driveRoles.driveId, driveId))
    .orderBy(asc(driveRoles.id))
    .for('update');
}

/**
 * Unset `isDefault` on whichever role currently holds it in the drive.
 * Filtering to `isDefault = true` keeps the write to at most one row instead
 * of rewriting every role in the drive. Callers must already hold the ordered
 * drive-wide lock (`lockDriveRolesInOrder`) before calling this.
 */
async function unsetOtherDefaultRoles(tx: Tx, driveId: string) {
  await tx.update(driveRoles)
    .set({ isDefault: false })
    .where(and(
      eq(driveRoles.driveId, driveId),
      eq(driveRoles.isDefault, true)
    ));
}

/**
 * Create a new role for a drive.
 *
 * Runs inside a transaction: when `isDefault` is set, the drive-wide "unset
 * other defaults" write takes the ordered drive-wide lock (see
 * `lockDriveRolesInOrder`) so a create racing an `updateDriveRole` default
 * switch can neither deadlock nor leave two default roles behind.
 */
export async function createDriveRole(
  driveId: string,
  input: CreateRoleInput
): Promise<DriveRole> {
  if (!validateDriveWidePermissions(input.driveWidePermissions)) {
    throw new Error('Invalid driveWidePermissions structure');
  }

  return db.transaction(async (tx) => {
    // Read existing roles for the position computation; when creating as
    // default this doubles as the ordered drive-wide lock acquisition.
    const existingRoles = input.isDefault
      ? await lockDriveRolesInOrder(tx, driveId)
      : await tx
          .select()
          .from(driveRoles)
          .where(eq(driveRoles.driveId, driveId));

    const maxPosition = existingRoles.length > 0
      ? Math.max(...existingRoles.map(r => r.position)) + 1
      : 0;

    // If setting as default, unset other defaults
    if (input.isDefault) {
      await unsetOtherDefaultRoles(tx, driveId);
    }

    const [newRole] = await tx.insert(driveRoles).values({
      driveId,
      name: input.name.trim(),
      description: input.description,
      color: input.color,
      isDefault: input.isDefault || false,
      permissions: input.permissions,
      driveWidePermissions: input.driveWidePermissions ?? null,
      position: maxPosition,
      updatedAt: new Date(),
    }).returning();

    return newRole as DriveRole;
  });
}

/**
 * Update an existing role.
 *
 * The read (existing permissions) + merge + write all happen inside a single
 * transaction with the role row locked via `FOR UPDATE`. Without this, two
 * concurrent callers merging different pages into `permissions` (or unsetting
 * other roles' `isDefault`) could each read the same pre-update snapshot and
 * the second writer would silently clobber the first writer's change — this
 * is the classic JSONB read-modify-write race. Locking the row and re-reading
 * it inside the transaction serializes concurrent updates so both merges
 * survive.
 *
 * When `isDefault` is being set, the drive-wide "unset other defaults" write
 * needs locks on every role row in the drive. Locking only the target row
 * first would let two concurrent default-switches each hold their own target
 * while waiting for the other's — a deadlock — so that path instead locks all
 * of the drive's role rows up front in a consistent (id) order.
 */
export async function updateDriveRole(
  driveId: string,
  roleId: string,
  input: UpdateRoleInput
): Promise<{ role: DriveRole; wasDefault: boolean }> {
  if (input.driveWidePermissions !== undefined && !validateDriveWidePermissions(input.driveWidePermissions)) {
    throw new Error('Invalid driveWidePermissions structure');
  }

  if (input.permissions !== undefined && input.permissionsPatch !== undefined) {
    throw new Error('Cannot specify both permissions and permissionsPatch');
  }

  return db.transaction(async (tx) => {
    let existingRole: typeof driveRoles.$inferSelect | undefined;
    if (input.isDefault) {
      // Setting a default updates every role row in the drive, so acquire the
      // ordered drive-wide lock (see lockDriveRolesInOrder).
      const lockedRoles = await lockDriveRolesInOrder(tx, driveId);
      existingRole = lockedRoles.find((role) => role.id === roleId);
    } else {
      [existingRole] = await tx
        .select()
        .from(driveRoles)
        .where(and(
          eq(driveRoles.id, roleId),
          eq(driveRoles.driveId, driveId)
        ))
        .for('update');
    }

    if (!existingRole) {
      throw new Error('Role not found');
    }

    // If setting as default and wasn't already, unset other defaults
    if (input.isDefault && !existingRole.isDefault) {
      await unsetOtherDefaultRoles(tx, driveId);
    }

    const resolvedPermissions = input.permissionsPatch !== undefined
      ? mergeRolePermissionsPatch(existingRole.permissions as RolePermissions, input.permissionsPatch)
      : input.permissions;

    const [updatedRole] = await tx.update(driveRoles)
      .set({
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.color !== undefined && { color: input.color }),
        ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
        ...(resolvedPermissions !== undefined && { permissions: resolvedPermissions }),
        ...(input.driveWidePermissions !== undefined && { driveWidePermissions: input.driveWidePermissions }),
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
  });
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
 * Reorder roles for a drive.
 *
 * Takes the ordered drive-wide lock before writing — via `lockDriveRolesInOrder`,
 * not `lockedBatchReorder`'s own (narrower) lock — because this lock also
 * serializes `reorderDriveRoles` against `createDriveRole`/`updateDriveRole`'s
 * default-switch, both of which take the same drive-wide lock. Holding all the
 * rows up front also makes the membership validation (`existingIds`/
 * `invalidIds`) authoritative rather than a pre-transaction snapshot. The write
 * itself is then a single batched statement via `lockedBatchReorder` instead of
 * N sequential per-row updates.
 */
export async function reorderDriveRoles(
  driveId: string,
  roleIds: string[]
): Promise<void> {
  await db.transaction(async (tx) => {
    const existingRoles = await lockDriveRolesInOrder(tx, driveId);
    const existingIds = new Set(existingRoles.map(r => r.id));
    const invalidIds = roleIds.filter(id => !existingIds.has(id));

    if (invalidIds.length > 0) {
      throw new Error('Invalid role IDs');
    }

    const plan = computeReorderPlan(roleIds.map((id, index) => ({ id, position: index })));
    if (plan.orderedIds.length > 0) {
      await lockedBatchReorder(tx, {
        table: driveRoles,
        idColumn: driveRoles.id,
        positionColumn: driveRoles.position,
        scopeWhere: eq(driveRoles.driveId, driveId),
        plan,
        touchColumns: [driveRoles.updatedAt],
      });
    }
  });
}

/**
 * Validate driveWidePermissions structure (null = clear, object = set)
 */
export function validateDriveWidePermissions(perms: unknown): perms is PagePerm | null {
  if (perms === null || perms === undefined) return true;
  if (typeof perms !== 'object' || Array.isArray(perms)) return false;
  const p = perms as Record<string, unknown>;
  return (
    typeof p.canView === 'boolean' &&
    typeof p.canEdit === 'boolean' &&
    typeof p.canShare === 'boolean' &&
    Object.keys(p).every(k => ['canView', 'canEdit', 'canShare'].includes(k))
  );
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

/**
 * Validate a per-page permissions patch structure (same as RolePermissions,
 * except each entry may also be `null` to signal "prune this page's override").
 */
export function validateRolePermissionsPatch(patch: unknown): patch is RolePermissionsPatch {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;

  for (const [pageId, perms] of Object.entries(patch)) {
    if (typeof pageId !== 'string') return false;
    if (perms === null) continue;
    if (!perms || typeof perms !== 'object') return false;
    const p = perms as Record<string, unknown>;
    if (typeof p.canView !== 'boolean' ||
        typeof p.canEdit !== 'boolean' ||
        typeof p.canShare !== 'boolean') return false;
  }

  return true;
}

/**
 * Merge a per-page permissions patch into an existing permissions map.
 * Read-merge-write: pages not named in the patch are left untouched (unlike a
 * full `permissions` replace, which wipes everything not in the payload).
 * A `null` entry prunes the key so resolution falls back to
 * driveWidePermissions, rather than persisting an explicit all-false entry.
 */
export function mergeRolePermissionsPatch(
  existing: RolePermissions,
  patch: RolePermissionsPatch,
): RolePermissions {
  const merged = { ...existing };
  for (const [pageId, perms] of Object.entries(patch)) {
    if (perms === null) {
      delete merged[pageId];
    } else {
      merged[pageId] = perms;
    }
  }
  return merged;
}
