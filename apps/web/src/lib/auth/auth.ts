import { NextResponse } from 'next/server';
import { authenticateSessionRequest, isAuthError } from './index';
import { validateAdminAccess, type AdminValidationResult } from './admin-role';
import { validateCSRF } from './csrf-validation';
import { logSecurityEvent } from '@pagespace/lib/server';
import { securityAudit } from '@pagespace/lib/audit/security-audit';

export interface VerifiedUser {
  id: string;
  role: 'user' | 'admin';
  tokenVersion: number;
  adminRoleVersion: number;
  authTransport: 'cookie' | 'bearer';
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

  const authHeader = request.headers.get('authorization');
  const hasSessionBearerToken = authHeader?.startsWith('Bearer ps_sess_') ?? false;

  return {
    id: result.userId,
    role: result.role,
    tokenVersion: result.tokenVersion,
    adminRoleVersion: result.adminRoleVersion,
    authTransport: hasSessionBearerToken ? 'bearer' : 'cookie',
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
 * Used for dynamic routes with params (Next.js 15 pattern).
 */
export type AdminRouteContext = { params: Promise<Record<string, string>> };

/**
 * Higher-order function that wraps admin route handlers with authentication.
 * Eliminates the repetitive 3-line auth pattern across admin routes.
 *
 * Usage:
 * ```typescript
 * // For routes WITHOUT context:
 * export const GET = withAdminAuth(async (adminUser, request) => {
 *   return Response.json({ userId: adminUser.id });
 * });
 *
 * // For routes WITH dynamic params:
 * export const POST = withAdminAuth<RouteContext>(async (adminUser, request, context) => {
 *   const { userId } = await context.params;
 *   return Response.json({ targetUserId: userId });
 * });
 * ```
 */
// Overload for routes WITHOUT context (no dynamic params)
export function withAdminAuth(
  handler: (user: VerifiedUser, request: Request) => Promise<Response>
): (request: Request) => Promise<Response>;

// Overload for routes WITH context (dynamic params)
export function withAdminAuth<T extends AdminRouteContext>(
  handler: (user: VerifiedUser, request: Request, context: T) => Promise<Response>
): (request: Request, context: T) => Promise<Response>;

// Implementation
export function withAdminAuth<T extends AdminRouteContext>(
  handler: (user: VerifiedUser, request: Request, context?: T) => Promise<Response>
) {
  return async (request: Request, context?: T): Promise<Response> => {
    const endpoint = new URL(request.url).pathname;
    const ipAddress = getRequestIp(request);
    const result = await verifyAdminAuth(request);

    if (isAdminAuthError(result)) {
      emitAdminAuditDenied(request, endpoint, ipAddress);
      return result;
    }

    emitAdminAuditAccess(result, request, endpoint, ipAddress);
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
  // CSRF is required only for cookie-authenticated browser sessions.
  // Bearer tokens must be explicitly provided by the client and are not sent automatically cross-site.
  const method = request.method.toUpperCase();
  const isStateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const requiresCSRF = isStateChanging && user.authTransport === 'cookie';

  if (requiresCSRF) {
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

function getRequestIp(request: Request): string | undefined {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip')
    ?? undefined;
}

function emitAdminAuditAccess(user: VerifiedUser, request: Request, endpoint: string, ipAddress?: string): void {
  securityAudit.logDataAccess(
    user.id,
    'read',
    'admin-endpoint',
    endpoint,
    { method: request.method, ipAddress }
  ).catch(() => {});
}

function emitAdminAuditDenied(request: Request, endpoint: string, ipAddress?: string): void {
  securityAudit.logEvent({
    eventType: 'authz.access.denied',
    resourceType: 'admin-endpoint',
    resourceId: endpoint,
    ipAddress,
    details: { method: request.method, reason: 'admin_auth_denied' },
    riskScore: 0.5,
  }).catch(() => {});
}
