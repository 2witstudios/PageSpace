import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { acceptOrgInviteForUser } from '@/lib/orgs/accept-org-invite';
import { authenticateOrgRequest, ORG_TOKEN_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { inviteAcceptSchema } from '@/lib/orgs/org-schemas';
import { ORG_LAPSED_MESSAGE } from '@pagespace/lib/organizations/status-core';

const REFUSALS = {
  not_found: 'This invitation link is not valid',
  expired: 'This invitation has expired; ask for a new one',
  already_accepted: 'This invitation has already been used',
  email_mismatch: 'This invitation was sent to a different email address',
  // [D-OW-33] the org is lapsed: joining waits until it pays; the invitation stays open.
  org_lapsed: ORG_LAPSED_MESSAGE,
} as const;

/**
 * POST /api/orgs/invitations/accept — the signed-in person accepts by token
 * (ORG-3). No org role is required: the caller is not a member yet. The invite
 * token is the authority, bound to the invited address, so it works the same for
 * an account created from the email link and for an existing account.
 */
export async function POST(request: Request) {
  const gate = await authenticateOrgRequest(request, ORG_TOKEN_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = inviteAcceptSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues, code: 'invalid_request' }, { status: 400 });
    }
    const result = await acceptOrgInviteForUser({ request, token: parsed.data.token, userId: gate.userId });
    if (!result.ok) {
      return NextResponse.json({ error: REFUSALS[result.reason], code: result.reason }, { status: result.status });
    }
    return NextResponse.json({ orgId: result.orgId, role: result.role, joined: result.joined });
  } catch (error) {
    loggers.api.error('Error accepting organization invitation:', error as Error);
    return NextResponse.json({ error: 'Failed to accept invitation', code: 'internal_error' }, { status: 500 });
  }
}
