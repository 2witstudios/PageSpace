import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { changeMemberRole, removeMember, type MembershipRefusal } from '@pagespace/lib/organizations/membership';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { memberRoleUpdateSchema } from '@/lib/orgs/org-schemas';

type Context = { params: Promise<{ orgId: string; userId: string }> };

const REFUSAL_MESSAGES: Record<MembershipRefusal, string> = {
  target_not_member: 'That person is not a member of this organization',
  use_ownership_transfer: 'The Owner role changes only by transferring ownership',
  use_leave: 'Use leave organization to remove yourself',
  already_owner: 'That person already owns this organization',
  not_owner: 'Only the Owner can do that',
  not_found: 'Organization not found',
  not_member: 'You are no longer a member of this organization',
  insufficient_role: 'You are no longer an Admin of this organization',
};

/** PATCH /api/orgs/[orgId]/members/[userId] — Owner and Admins change a role (ORG-2). */
export async function PATCH(request: Request, context: Context) {
  const { orgId, userId: targetId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = memberRoleUpdateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 });
    }
    const result = await changeMemberRole({ orgId, actorId: gate.userId, targetId, newRole: parsed.data.role });
    if (!result.ok) {
      return NextResponse.json({ error: REFUSAL_MESSAGES[result.reason], reason: result.reason }, { status: result.status });
    }
    auditRequest(request, {
      eventType: 'authz.role.assigned',
      userId: gate.userId,
      resourceType: 'organization_member',
      resourceId: orgId,
      details: { operation: 'change_org_role', targetUserId: targetId, role: parsed.data.role },
    });
    return NextResponse.json({ userId: targetId, role: parsed.data.role });
  } catch (error) {
    loggers.api.error('Error changing organization role:', error as Error);
    return NextResponse.json({ error: 'Failed to change role' }, { status: 500 });
  }
}

/**
 * DELETE /api/orgs/[orgId]/members/[userId] — Owner and Admins remove a member.
 * Removes the membership row; leaving (and the O-8 cascades) is B6's leave flow.
 */
export async function DELETE(request: Request, context: Context) {
  const { orgId, userId: targetId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const result = await removeMember({ orgId, actorId: gate.userId, targetId });
    if (!result.ok) {
      return NextResponse.json({ error: REFUSAL_MESSAGES[result.reason], reason: result.reason }, { status: result.status });
    }
    auditRequest(request, {
      eventType: 'authz.role.removed',
      userId: gate.userId,
      resourceType: 'organization_member',
      resourceId: orgId,
      details: { operation: 'remove_org_member', targetUserId: targetId },
    });
    return NextResponse.json({ removed: true });
  } catch (error) {
    loggers.api.error('Error removing organization member:', error as Error);
    return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 });
  }
}
