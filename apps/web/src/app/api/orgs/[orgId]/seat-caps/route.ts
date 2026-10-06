import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { listOrgSeatCaps } from '@pagespace/lib/services/drive-wallet-service';
import { authorizeOrgRequest, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';

/**
 * GET /api/orgs/[orgId]/seat-caps — every member's seat caps, the monthly limit in force and what is
 * left (read model, D-OW-38 "seat allowance remaining"; WAL-7; UI-7). Owner and Admins, who are the
 * ones who may set the caps (PUT /api/orgs/[orgId]/members/[userId]/seat-cap).
 */
export async function GET(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const read = await listOrgSeatCaps(orgId);
    auditRequest(request, {
      eventType: 'data.read',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'list_org_seat_caps', count: read.seats.length },
    });
    return NextResponse.json(read);
  } catch (error) {
    loggers.api.error('Error reading organization seat caps:', error as Error);
    return NextResponse.json({ error: 'Failed to load seat caps', code: 'internal_error' }, { status: 500 });
  }
}
