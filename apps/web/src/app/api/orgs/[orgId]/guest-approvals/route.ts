import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { listPendingGuestApprovalViews } from '@pagespace/lib/permissions/guest-holds';
import { authorizeOrgRequest, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';

type Context = { params: Promise<{ orgId: string }> };

/** The page size of the approval queue: the queue is bounded, `total` is always the whole of it. */
const QUEUE_LIMIT = 100;

/**
 * GET /api/orgs/[orgId]/guest-approvals (Spec POL-2) — the approval queue: outsiders waiting for an Owner or Admin
 * under the `approve` guests policy, with the drive, who is asking and what for. Owner and Admins only; a plain
 * member gets the 403 of any Admin-only read and a non-member the 404 of an org that does not exist.
 */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const queue = await listPendingGuestApprovalViews(orgId, QUEUE_LIMIT);
    auditRequest(request, { eventType: 'data.read', userId: gate.userId, resourceType: 'organization_guest_approvals', resourceId: orgId, details: { orgId } });
    return NextResponse.json(queue);
  } catch (error) {
    loggers.api.error('Error listing guest approvals:', error as Error);
    return NextResponse.json({ error: 'Failed to list guest approvals' }, { status: 500 });
  }
}
