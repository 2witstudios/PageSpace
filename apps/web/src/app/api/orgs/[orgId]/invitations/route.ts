import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { createOrRotateInvitation, listOpenInvitations } from '@pagespace/lib/organizations/invitations';
import { authorizeOrgRequest, ORG_READ_AUTH, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { inviteCreateSchema } from '@/lib/orgs/org-schemas';
import { deliverOrgInvite } from '@/lib/orgs/org-invite-delivery';

type Context = { params: Promise<{ orgId: string }> };

/** GET /api/orgs/[orgId]/invitations — open invites; Owner and Admins. */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const invitations = await listOpenInvitations(orgId);
    auditRequest(request, {
      eventType: 'data.read',
      userId: gate.userId,
      resourceType: 'organization_invitations',
      resourceId: orgId,
      details: { operation: 'list_org_invitations', count: invitations.length },
    });
    return NextResponse.json({ invitations });
  } catch (error) {
    loggers.api.error('Error listing organization invitations:', error as Error);
    return NextResponse.json({ error: 'Failed to list invitations' }, { status: 500 });
  }
}

/**
 * POST /api/orgs/[orgId]/invitations — invite by email; Owner and Admins (ORG-3).
 * An expired open invite for the address is rotated in place. Seat limits and
 * auto-add (SEAT-4) and the who-can-invite policy (POL-5) land in later waves.
 */
export async function POST(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    if (!(await isEmailVerified(gate.userId))) {
      return NextResponse.json(
        { error: 'Email verification required. Please verify your email to perform this action.', requiresEmailVerification: true },
        { status: 403 },
      );
    }
    const parsed = inviteCreateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 });
    }
    const { email, role } = parsed.data;

    const limit = await checkDistributedRateLimit(`org_invite:org:${orgId}:${email}`, DISTRIBUTED_RATE_LIMITS.DRIVE_INVITE);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'Too many invitations to this address. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter ?? 900) } },
      );
    }

    const result = await createOrRotateInvitation({
      orgId,
      email,
      role,
      invitedBy: gate.userId,
      now: new Date(),
      deliver: (_invitation, token) => deliverOrgInvite({ orgId, inviterId: gate.userId, email, role, token }),
    });
    if (!result.ok) {
      if (result.reason === 'delivery_failed') {
        // The service has already undone the invite, so it holds no seat.
        loggers.api.error('Failed to send organization invitation email', result.cause as Error, { orgId });
        return NextResponse.json({ error: 'Failed to send the invitation email' }, { status: 502 });
      }
      const error =
        result.reason === 'already_member'
          ? 'That person is already a member of this organization'
          : 'That address already has a pending invitation; resend it instead';
      return NextResponse.json({ error, reason: result.reason }, { status: 409 });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'organization_invitation',
      resourceId: result.invitation.id,
      details: { operation: result.rotated ? 'rotate_org_invitation' : 'create_org_invitation', orgId, role },
    });
    return NextResponse.json({ invitation: result.invitation }, { status: result.rotated ? 200 : 201 });
  } catch (error) {
    loggers.api.error('Error creating organization invitation:', error as Error);
    return NextResponse.json({ error: 'Failed to create invitation' }, { status: 500 });
  }
}
