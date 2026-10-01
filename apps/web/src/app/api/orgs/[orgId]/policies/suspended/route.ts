import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { listPolicySuspensions } from '@pagespace/lib/organizations/policy-suspension';
import { authorizeOrgRequest, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';

type Context = { params: Promise<{ orgId: string }> };

/**
 * GET /api/orgs/[orgId]/policies/suspended (Spec POL-1) — what the org's policies are holding: every
 * suspended share link, published page, custom domain, integration connection and guest, by id and
 * drive. Owner and Admins only. Ids, never names or content, so this list cannot reveal what a drive
 * is called; the Drives directory decides who may see a name.
 */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const suspended = await listPolicySuspensions(orgId);
    auditRequest(request, { eventType: 'data.read', userId: gate.userId, resourceType: 'organization_policy_suspensions', resourceId: orgId, details: { orgId } });
    return NextResponse.json({ suspended });
  } catch (error) {
    loggers.api.error('Error listing policy suspensions:', error as Error);
    return NextResponse.json({ error: 'Failed to list suspensions' }, { status: 500 });
  }
}
