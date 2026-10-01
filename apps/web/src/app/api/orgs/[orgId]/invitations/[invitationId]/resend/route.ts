import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { resendInvitation } from '@pagespace/lib/organizations/invitations';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { deliverOrgInvite } from '@/lib/orgs/org-invite-delivery';
import { orgLapsedResponse } from '@/lib/orgs/org-lapsed-response';
import { orgRefusalResponse } from '@/lib/orgs/org-refusal-response';
import { orgPolicyRefusalResponse } from '@/lib/orgs/org-policy-refusal-response';
import { defaultSeatBilling } from '@/lib/org-billing/seat-billing';

/**
 * POST /api/orgs/[orgId]/invitations/[invitationId]/resend — Owner and Admins
 * (ORG-3). Issues a new link and a fresh expiry; the previous link stops working once
 * the new one is delivered. Resending an EXPIRED invite takes a seat again, so it can be refused
 * with 402 `seats_full` exactly like a new invite (SEAT-4).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string; invitationId: string }> },
) {
  const { orgId, invitationId } = await context.params;
  // Any member reaches the service: who may invite (and so resend) is the org's policy (POL-5), decided there.
  const gate = await authorizeOrgRequest(request, orgId, 'MEMBER', ORG_WRITE_AUTH);
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
      actorRole: gate.role ?? 'MEMBER',
      seatBilling: defaultSeatBilling(),
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
      if (result.reason === 'org_lapsed') return orgLapsedResponse(result.message);
      if (result.reason === 'org_policy') return orgPolicyRefusalResponse(result);
      if (result.reason === 'seats_full') {
        auditRequest(request, {
          eventType: 'authz.access.denied',
          userId: gate.userId,
          resourceType: 'organization',
          resourceId: orgId,
          details: { reason: 'seats_full', operation: 'resend_org_invitation', purchased: result.purchased, held: result.held },
        });
        return orgRefusalResponse({ status: result.status, message: result.message, code: result.reason });
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
