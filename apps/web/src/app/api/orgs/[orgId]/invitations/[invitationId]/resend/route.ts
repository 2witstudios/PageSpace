import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { resendInvitation } from '@pagespace/lib/organizations/invitations';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { deliverOrgInvite } from '@/lib/orgs/org-invite-delivery';

/**
 * POST /api/orgs/[orgId]/invitations/[invitationId]/resend — Owner and Admins
 * (ORG-3). Issues a new link and a fresh expiry; the previous link stops working once
 * the new one is delivered.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string; invitationId: string }> },
) {
  const { orgId, invitationId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const limit = await checkDistributedRateLimit(
      `org_invite_resend:${orgId}:${invitationId}`,
      DISTRIBUTED_RATE_LIMITS.DRIVE_INVITE_RESEND,
    );
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'Too many resends for this invitation. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter ?? 900) } },
      );
    }

    const result = await resendInvitation({
      orgId,
      invitationId,
      now: new Date(),
      deliver: (invitation, token) =>
        deliverOrgInvite({
          orgId,
          inviterId: gate.userId,
          email: invitation.email,
          role: invitation.role === 'ADMIN' ? 'ADMIN' : 'MEMBER',
          token,
        }),
    });
    if (!result.ok) {
      if (result.reason === 'delivery_failed') {
        // The service restored the previous link, which keeps working.
        loggers.api.error('Failed to resend organization invitation email', result.cause as Error, { orgId });
        return NextResponse.json({ error: 'Failed to send the invitation email' }, { status: 502 });
      }
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'organization_invitation',
      resourceId: invitationId,
      details: { operation: 'resend_org_invitation', orgId },
    });
    return NextResponse.json({ invitation: result.invitation });
  } catch (error) {
    loggers.api.error('Error resending organization invitation:', error as Error);
    return NextResponse.json({ error: 'Failed to resend invitation' }, { status: 500 });
  }
}
