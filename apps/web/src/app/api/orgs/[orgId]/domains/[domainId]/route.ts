import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { removeOrgDomain } from '@pagespace/lib/organizations/domains';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';

type Context = { params: Promise<{ orgId: string; domainId: string }> };

/**
 * DELETE /api/orgs/[orgId]/domains/[domainId] — un-verify and remove a claim (SEC-1); Owner and Admins.
 * Future signups on the domain stop joining; nobody already in the org is removed. Audited in lib.
 */
export async function DELETE(request: Request, context: Context) {
  const { orgId, domainId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const removed = await removeOrgDomain({ orgId, domainId, actorId: gate.userId });
    if (!removed) return NextResponse.json({ error: 'Domain not found', code: 'not_found' }, { status: 404 });
    // The org event (org.domain.removed) is written in lib; this row carries the request context.
    auditRequest(request, { eventType: 'data.delete', userId: gate.userId, resourceType: 'org_domain', resourceId: domainId, details: { orgId } });
    return NextResponse.json({ removed: true });
  } catch (error) {
    loggers.api.error('Error removing organization domain:', error as Error);
    return NextResponse.json({ error: 'Failed to remove domain', code: 'internal_error' }, { status: 500 });
  }
}
