import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { listOrgMembers } from '@pagespace/lib/organizations/repository';
import { authorizeOrgRequest, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';

/** GET /api/orgs/[orgId]/members — any member sees who is in the org (ORG-2). */
export async function GET(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'MEMBER', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const members = await listOrgMembers(orgId);
    auditRequest(request, {
      eventType: 'data.read',
      userId: gate.userId,
      resourceType: 'organization_members',
      resourceId: orgId,
      details: { operation: 'list_org_members', count: members.length },
    });
    return NextResponse.json({ members });
  } catch (error) {
    loggers.api.error('Error listing organization members:', error as Error);
    return NextResponse.json({ error: 'Failed to list members' }, { status: 500 });
  }
}
