import { NextResponse } from 'next/server';
import { verifyAuth, type VerifiedUser } from '../auth/auth';
import { isOrgAdmin, isOrgOwner } from './guardrails';

export type OrgRouteContext = { params: Promise<{ orgId: string }> };
export type OrgMemberRouteContext = { params: Promise<{ orgId: string; userId: string }> };

export function withOrgAuth<T extends OrgRouteContext>(
  handler: (user: VerifiedUser, request: Request, context: T, orgId: string) => Promise<Response>
) {
  return async (request: Request, context: T): Promise<Response> => {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { orgId } = await context.params;
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

    const { orgId } = await context.params;
    const admin = await isOrgAdmin(user.id, orgId);
    if (!admin) {
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

    const { orgId } = await context.params;
    const owner = await isOrgOwner(user.id, orgId);
    if (!owner) {
      return NextResponse.json({ error: 'Organization owner access required' }, { status: 403 });
    }

    return handler(user, request, context, orgId);
  };
}
