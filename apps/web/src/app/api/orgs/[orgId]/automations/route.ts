import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { listOwnerLeftAutomations } from '@pagespace/lib/organizations/automation-ownership';
import { authorizeOrgRequest, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';

type Context = { params: Promise<{ orgId: string }> };

/**
 * GET /api/orgs/[orgId]/automations — Owner and Admins list the org's automations whose creator
 * left the org or deleted their account ([D-OW-36]): disabled, waiting to be reassigned or deleted.
 */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const automations = await listOwnerLeftAutomations(orgId);
    auditRequest(request, { eventType: 'data.read', userId: gate.userId, resourceType: 'organization_automations', resourceId: orgId, details: { orgId, count: automations.length } });
    return NextResponse.json({ automations });
  } catch (error) {
    loggers.api.error('Error listing owner-left automations:', error as Error);
    return NextResponse.json({ error: 'Failed to list automations', code: 'internal_error' }, { status: 500 });
  }
}
