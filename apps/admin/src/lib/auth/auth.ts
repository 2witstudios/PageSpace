import { NextResponse } from 'next/server';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { logSecurityEvent } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { validateAdminAccess, type AdminValidationResult } from './admin-role';
import { validateCSRF } from './csrf-validation';
import { getSessionFromCookies } from './cookie-config';

export interface VerifiedAdminUser {
  id: string;
  role: 'admin';
  tokenVersion: number;
  adminRoleVersion: number;
}

export type AdminRouteContext = { params: Promise<Record<string, string>> };

export function isAdminAuthError(result: VerifiedAdminUser | NextResponse): result is NextResponse {
  return result instanceof NextResponse;
}

async function authenticateSession(request: Request): Promise<VerifiedAdminUser | null> {
  const cookieHeader = request.headers.get('cookie');
  const sessionToken = getSessionFromCookies(cookieHeader);
  if (!sessionToken) return null;

  const claims = await sessionService.validateSession(sessionToken);
  if (!claims) return null;

  return {
    id: claims.userId,
    role: claims.userRole as 'admin',
    tokenVersion: claims.tokenVersion,
    adminRoleVersion: claims.adminRoleVersion,
  };
}

export interface VerifyAdminAuthOptions {
  skipInternalAudit?: boolean;
}

export async function verifyAdminAuth(
  request: Request,
  options: VerifyAdminAuthOptions = {}
): Promise<VerifiedAdminUser | NextResponse> {
  const user = await authenticateSession(request);
  if (!user) {
    return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
  }

  const method = request.method.toUpperCase();
  const isStateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  if (isStateChanging) {
    const csrfError = await validateCSRF(request);
    if (csrfError) {
      logSecurityEvent('unauthorized', {
        reason: 'admin_csrf_validation_failed',
        userId: user.id,
        method,
        action: 'deny_access',
      });
      if (!options.skipInternalAudit) {
        auditRequest(request, { eventType: 'authz.access.denied', userId: user.id, resourceType: 'admin_route', resourceId: method, details: { reason: 'csrf_validation_failed' }, riskScore: 0.5 });
      }
      return csrfError;
    }
  }

  const validationResult: AdminValidationResult = await validateAdminAccess(user.id, user.adminRoleVersion);
  if (!validationResult.isValid) {
    logSecurityEvent('admin_role_version_mismatch', {
      reason: validationResult.reason ?? 'admin_role_version_validation_failed',
      userId: user.id,
      claimedAdminRoleVersion: user.adminRoleVersion,
      actualAdminRoleVersion: validationResult.actualAdminRoleVersion,
      currentRole: validationResult.currentRole,
      action: 'deny_access',
    });
    if (!options.skipInternalAudit) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: user.id, resourceType: 'admin_route', resourceId: 'admin_access', details: { reason: validationResult.reason }, riskScore: 0.5 });
    }
    return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
  }

  return { ...user, role: 'admin' };
}

// Overload for routes WITHOUT context
export function withAdminAuth(
  handler: (user: VerifiedAdminUser, request: Request) => Promise<Response>
): (request: Request) => Promise<Response>;

// Overload for routes WITH dynamic params
export function withAdminAuth<T extends AdminRouteContext>(
  handler: (user: VerifiedAdminUser, request: Request, context: T) => Promise<Response>
): (request: Request, context: T) => Promise<Response>;

// Implementation
export function withAdminAuth<T extends AdminRouteContext>(
  handler: (user: VerifiedAdminUser, request: Request, context?: T) => Promise<Response>
) {
  return async (request: Request, context?: T): Promise<Response> => {
    const endpoint = new URL(request.url).pathname;
    const result = await verifyAdminAuth(request, { skipInternalAudit: true });

    if (isAdminAuthError(result)) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        resourceType: 'admin-endpoint',
        resourceId: endpoint,
        details: { method: request.method, reason: 'admin_auth_denied' },
        riskScore: 0.5,
      });
      return result;
    }

    auditRequest(request, {
      eventType: request.method === 'GET' ? 'data.read' : request.method === 'DELETE' ? 'data.delete' : 'data.write',
      userId: result.id,
      resourceType: 'admin-endpoint',
      resourceId: endpoint,
      details: { method: request.method },
    });

    return handler(result, request, context);
  };
}
