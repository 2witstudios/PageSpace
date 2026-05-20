import { db } from '@pagespace/db/db'
import { eq, sql } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth';

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

export interface AdminValidationResult {
  isValid: boolean;
  reason?: 'user_not_found' | 'not_admin' | 'version_mismatch';
  actualAdminRoleVersion?: number;
  currentRole?: string;
}

/**
 * Validate that a user has admin access with the correct adminRoleVersion.
 * This prevents race conditions where a user's admin status changes between
 * token issuance and request validation.
 *
 * Returns detailed result for security logging purposes.
 */
export async function validateAdminAccess(
  userId: string,
  claimedAdminVersion: number
): Promise<AdminValidationResult> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { role: true, adminRoleVersion: true },
  });

  if (!user) {
    return { isValid: false, reason: 'user_not_found' };
  }

  if (user.role !== 'admin') {
    return {
      isValid: false,
      reason: 'not_admin',
      currentRole: user.role,
      actualAdminRoleVersion: user.adminRoleVersion,
    };
  }

  if (user.adminRoleVersion !== claimedAdminVersion) {
    return {
      isValid: false,
      reason: 'version_mismatch',
      currentRole: user.role,
      actualAdminRoleVersion: user.adminRoleVersion,
    };
  }

  return { isValid: true, actualAdminRoleVersion: user.adminRoleVersion };
}
