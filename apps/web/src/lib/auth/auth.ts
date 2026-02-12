import { NextResponse } from 'next/server';
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

/** Type guard to check if result is an error response */
export function isAdminAuthError(result: VerifiedUser | NextResponse): result is NextResponse {
  return result instanceof NextResponse;
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
 *
 * Returns:
 * - VerifiedUser on success
 * - NextResponse with error details on failure (use isAdminAuthError to check)
 */
/**
 * Admin route context type for withAdminAuth wrapper.
 * Allows handlers to receive context with Promise params (Next.js 15 pattern).
 */
export type AdminRouteContext = { params: Promise<Record<string, string>> } | undefined;

/**
 * Higher-order function that wraps admin route handlers with authentication.
 * Eliminates the repetitive 3-line auth pattern across admin routes.
 *
 * Usage:
 * ```typescript
 * export const GET = withAdminAuth(async (adminUser, request) => {
 *   // adminUser is guaranteed to be VerifiedUser - no type guard needed
 *   return Response.json({ userId: adminUser.id });
 * });
 *
 * // With context (for dynamic routes):
 * export const POST = withAdminAuth(async (adminUser, request, context) => {
 *   const { userId } = await (context as { params: Promise<{ userId: string }> }).params;
 *   return Response.json({ targetUserId: userId });
 * });
 * ```
 */
export function withAdminAuth<T extends AdminRouteContext>(
  handler: (user: VerifiedUser, request: Request, context: T) => Promise<Response>
) {
  return async (request: Request, context: T): Promise<Response> => {
    const result = await verifyAdminAuth(request);
    if (isAdminAuthError(result)) return result;
    return handler(result, request, context);
  };
}

export async function verifyAdminAuth(request: Request): Promise<VerifiedUser | NextResponse> {
  const user = await verifyAuth(request);
  if (!user) {
    return NextResponse.json(
      { error: 'Forbidden: Admin access required' },
      { status: 403 }
    );
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
      // Return the CSRF error response directly to preserve error codes
      return csrfError;
    }
  }

  // Validate adminRoleVersion against the database to ensure
  // the role hasn't changed since the token was issued.
  // This is called for ALL authenticated users (not just those with admin role in session)
  // because the session role may be stale - validateAdminAccess checks the actual DB state.
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
    return NextResponse.json(
      { error: 'Forbidden: Admin access required' },
      { status: 403 }
    );
  }

  return user;
}
