import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { acceptInvitation } from '@pagespace/lib/organizations/invitations';
import { authenticateOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { inviteAcceptSchema } from '@/lib/orgs/org-schemas';

const REFUSALS = {
  not_found: 'This invitation link is not valid',
  expired: 'This invitation has expired; ask for a new one',
  already_accepted: 'This invitation has already been used',
  email_mismatch: 'This invitation was sent to a different email address',
} as const;

/**
 * POST /api/orgs/invitations/accept — the signed-in person accepts by token
 * (ORG-3). No org role is required: the caller is not a member yet. The invite
 * token is the authority, bound to the invited address, so it works the same for
 * an account created from the email link and for an existing account.
 */
export async function POST(request: Request) {
  const gate = await authenticateOrgRequest(request, ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = inviteAcceptSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 });
    }
    const result = await acceptInvitation({ token: parsed.data.token, userId: gate.userId, now: new Date() });
    if (!result.ok) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: gate.userId,
        resourceType: 'organization_invitation',
        resourceId: 'token',
        details: { operation: 'accept_org_invitation', reason: result.reason },
      });
      return NextResponse.json({ error: REFUSALS[result.reason], reason: result.reason }, { status: result.status });
    }
    auditRequest(request, {
      eventType: 'authz.role.assigned',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: result.orgId,
      details: { operation: 'accept_org_invitation', role: result.role, joined: result.joined },
    });
    return NextResponse.json({ orgId: result.orgId, role: result.role, joined: result.joined });
  } catch (error) {
    loggers.api.error('Error accepting organization invitation:', error as Error);
    return NextResponse.json({ error: 'Failed to accept invitation' }, { status: 500 });
  }
}
