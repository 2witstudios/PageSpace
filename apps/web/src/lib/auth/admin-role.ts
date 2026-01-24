import { db, users, eq, sql } from '@pagespace/db';

type UserRole = 'user' | 'admin';

interface UpdatedUser {
  id: string;
  role: UserRole;
  adminRoleVersion: number;
}

/**
 * Update a user's role and bump the adminRoleVersion.
 * The version bump ensures that any cached admin tokens with the old version
 * will be invalidated, preventing timing attacks during role changes.
 */
export async function updateUserRole(
  userId: string,
  newRole: UserRole
): Promise<UpdatedUser | null> {
  const result = await db
    .update(users)
    .set({
      role: newRole,
      adminRoleVersion: sql`${users.adminRoleVersion} + 1`,
    })
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      role: users.role,
      adminRoleVersion: users.adminRoleVersion,
    });

  if (result.length === 0) {
    return null;
  }

  return result[0];
}

/**
 * Validate that a user has admin access with the correct adminRoleVersion.
 * This prevents race conditions where a user's admin status changes between
 * token issuance and request validation.
 */
export async function validateAdminAccess(
  userId: string,
  claimedAdminVersion: number
): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { role: true, adminRoleVersion: true },
  });

  if (!user) return false;
  if (user.role !== 'admin') return false;
  if (user.adminRoleVersion !== claimedAdminVersion) return false;

  return true;
}
