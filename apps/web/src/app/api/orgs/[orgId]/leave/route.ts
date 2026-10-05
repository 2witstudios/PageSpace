import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { announceOrgChange } from '@pagespace/lib/organizations/org-change-events';
import { leaveOrganization, type LeaveRefusal } from '@pagespace/lib/organizations/leave';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';

type Context = { params: Promise<{ orgId: string }> };

const REFUSALS: Record<LeaveRefusal, { status: number; code: 'not_member' | 'owner_must_transfer'; error: string }> = {
  NOT_A_MEMBER: { status: 404, code: 'not_member', error: 'You are no longer a member of this organization' },
  OWNER_MUST_TRANSFER: { status: 409, code: 'owner_must_transfer', error: 'Transfer ownership before leaving the organization' },
};

/**
 * POST /api/orgs/[orgId]/leave — the caller leaves (ORG-2; UI-11: the one org action a plain Member
 * has). Any role may call it, and it only ever acts on the session's own user. The cascade (O-7 lead
 * reassignment, O-8 revocations, D-OW-28 re-attribution, D-OW-36 automation disable) is
 * leaveOrganization's, which also writes org.member.left. The Owner must transfer ownership first.
 */
export async function POST(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'MEMBER', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const limit = await checkDistributedRateLimit(`org_leave:${orgId}:${gate.userId}`, DISTRIBUTED_RATE_LIMITS.API);
    if (!limit.allowed) {
      return NextResponse.json({ error: 'Too many requests. Please try again later.', code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfter ?? 60) } });
    }
    const result = await leaveOrganization(gate.userId, orgId);
    if (!result.ok) {
      const refusal = REFUSALS[result.reason];
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: refusal.status });
    }
    auditRequest(request, {
      eventType: 'authz.role.removed',
      userId: gate.userId,
      resourceType: 'organization_member',
      resourceId: orgId,
      details: { operation: 'leave_org' },
    });
    // X-4: the remaining members see the change without a refresh (org:changed, no content).
    void announceOrgChange(orgId, 'membership');
    return NextResponse.json({ left: true });
  } catch (error) {
    loggers.api.error('Error leaving organization:', error as Error);
    return NextResponse.json({ error: 'Failed to leave the organization', code: 'internal_error' }, { status: 500 });
  }
}
