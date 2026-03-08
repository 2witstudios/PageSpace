import { NextResponse } from 'next/server';
import { verifyAuth, type VerifiedUser } from '../auth/auth';
import { validateCSRF } from '../auth/csrf-validation';
import { logSecurityEvent, securityAudit } from '@pagespace/lib/server';
import { isOrgMember, isOrgAdmin, isOrgOwner } from './guardrails';

export type OrgRouteContext = { params: Promise<{ orgId: string }> };
export type OrgMemberRouteContext = { params: Promise<{ orgId: string; userId: string }> };

async function validateCSRFForStateChange(request: Request, user: VerifiedUser): Promise<NextResponse | null> {
  const method = request.method.toUpperCase();
  const isStateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const requiresCSRF = isStateChanging && user.authTransport === 'cookie';

  if (!requiresCSRF) return null;

  const csrfError = await validateCSRF(request);
  if (csrfError) {
    logSecurityEvent('unauthorized', {
      reason: 'org_csrf_validation_failed',
      userId: user.id,
      method,
      authType: 'session',
      action: 'deny_access',
    });
    securityAudit.logAccessDenied(user.id, 'org_route', method, 'csrf_validation_failed').catch(() => {});
    return csrfError;
  }

  return null;
}

export function withOrgAuth<T extends OrgRouteContext>(
  handler: (user: VerifiedUser, request: Request, context: T, orgId: string) => Promise<Response>
) {
  return async (request: Request, context: T): Promise<Response> => {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const csrfError = await validateCSRFForStateChange(request, user);
    if (csrfError) return csrfError;

    const { orgId } = await context.params;

    const isMember = await isOrgMember(user.id, orgId);
    if (!isMember) {
      securityAudit.logAccessDenied(user.id, 'org_route', request.method, 'not_org_member').catch(() => {});
      return NextResponse.json({ error: 'Organization access required' }, { status: 403 });
    }

    return handler(user, request, context, orgId);
  };
}

export function withOrgAdminAuth<T extends OrgRouteContext>(
  handler: (user: VerifiedUser, request: Request, context: T, orgId: string) => Promise<Response>
) {
  return async (request: Request, context: T): Promise<Response> => {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const csrfError = await validateCSRFForStateChange(request, user);
    if (csrfError) return csrfError;

    const { orgId } = await context.params;
    const admin = await isOrgAdmin(user.id, orgId);
    if (!admin) {
      securityAudit.logAccessDenied(user.id, 'org_route', request.method, 'not_org_admin').catch(() => {});
      return NextResponse.json({ error: 'Organization admin access required' }, { status: 403 });
    }

    return handler(user, request, context, orgId);
  };
}

export function withOrgOwnerAuth<T extends OrgRouteContext>(
  handler: (user: VerifiedUser, request: Request, context: T, orgId: string) => Promise<Response>
) {
  return async (request: Request, context: T): Promise<Response> => {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const csrfError = await validateCSRFForStateChange(request, user);
    if (csrfError) return csrfError;

    const { orgId } = await context.params;
    const owner = await isOrgOwner(user.id, orgId);
    if (!owner) {
      securityAudit.logAccessDenied(user.id, 'org_route', request.method, 'not_org_owner').catch(() => {});
      return NextResponse.json({ error: 'Organization owner access required' }, { status: 403 });
    }

    return handler(user, request, context, orgId);
  };
}
