import { authenticateSessionRequest, isAuthError } from './index';
import { validateAdminAccess, type AdminValidationResult } from './admin-role';
import { validateCSRF } from './csrf-validation';
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
 * Security features (zero-trust, defense-in-depth):
 * - Session authentication validation
 * - CSRF protection for state-changing requests
 * - adminRoleVersion validation against database
 * - Security event logging for audit trail
 */
export async function verifyAdminAuth(request: Request): Promise<VerifiedUser | null> {
  const user = await verifyAuth(request);
  if (!user || user.role !== 'admin') {
    return null;
  }

  // Defense-in-depth: CSRF validation for state-changing admin operations
  // Even with SameSite=Strict cookies, we add explicit CSRF validation for zero-trust security
  const method = request.method.toUpperCase();
  const isStateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  if (isStateChanging) {
    const csrfError = await validateCSRF(request);
    if (csrfError) {
      logSecurityEvent('unauthorized', {
        reason: 'admin_csrf_validation_failed',
        userId: user.id,
        method,
        authType: 'session',
        action: 'deny_access',
      });
      return null;
    }
  }

  // Validate adminRoleVersion against the database to ensure
  // the role hasn't changed since the token was issued
  const validationResult: AdminValidationResult = await validateAdminAccess(user.id, user.adminRoleVersion);
  if (!validationResult.isValid) {
    // Log security event with detailed context for forensic analysis
    logSecurityEvent('admin_role_version_mismatch', {
      reason: validationResult.reason ?? 'admin_role_version_validation_failed',
      userId: user.id,
      claimedAdminRoleVersion: user.adminRoleVersion,
      actualAdminRoleVersion: validationResult.actualAdminRoleVersion,
      currentRole: validationResult.currentRole,
      authType: 'session',
      action: 'deny_access',
    });
    return null;
  }

  return user;
}
