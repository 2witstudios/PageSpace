import { authenticateSessionRequest, isAuthError } from './index';
import { validateAdminAccess } from './admin-role';
import { logSecurityEvent } from '@pagespace/lib/server';

export interface VerifiedUser {
  id: string;
  role: 'user' | 'admin';
  tokenVersion: number;
  adminRoleVersion: number;
}

export async function verifyAuth(request: Request): Promise<VerifiedUser | null> {
  const result = await authenticateSessionRequest(request);
  if (isAuthError(result)) {
    return null;
  }

  return {
    id: result.userId,
    role: result.role,
    tokenVersion: result.tokenVersion,
    adminRoleVersion: result.adminRoleVersion,
  } satisfies VerifiedUser;
}

/**
 * Verify that the request is from an authenticated admin user.
 * Validates both the role and adminRoleVersion to prevent race conditions
 * where a user's admin status changes between token issuance and request.
 *
 * Logs security events when validation fails due to role version mismatch.
 */
export async function verifyAdminAuth(request: Request): Promise<VerifiedUser | null> {
  const user = await verifyAuth(request);
  if (!user || user.role !== 'admin') {
    return null;
  }

  // Validate adminRoleVersion against the database to ensure
  // the role hasn't changed since the token was issued
  const isValidAdmin = await validateAdminAccess(user.id, user.adminRoleVersion);
  if (!isValidAdmin) {
    // Log security event for admin role version mismatch
    // This catches stale admin sessions after role demotion
    logSecurityEvent('admin_role_version_mismatch', {
      reason: 'admin_role_version_validation_failed',
      userId: user.id,
      claimedAdminRoleVersion: user.adminRoleVersion,
      authType: 'session',
      action: 'deny_access',
    });
    return null;
  }

  return user;
}
