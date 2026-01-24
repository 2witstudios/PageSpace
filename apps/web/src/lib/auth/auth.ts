import { authenticateSessionRequest, isAuthError } from './index';
import { validateAdminAccess } from './admin-role';

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
    return null;
  }

  return user;
}
