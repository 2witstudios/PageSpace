import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { revokeInvitation } from '@pagespace/lib/organizations/invitations';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';

/** DELETE /api/orgs/[orgId]/invitations/[invitationId] — revoke an open invite; Owner and Admins (ORG-3). */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ orgId: string; invitationId: string }> },
) {
  const { orgId, invitationId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const revoked = await revokeInvitation({ orgId, invitationId });
    if (!revoked) return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    auditRequest(request, {
      eventType: 'data.delete',
      userId: gate.userId,
      resourceType: 'organization_invitation',
      resourceId: invitationId,
      details: { operation: 'revoke_org_invitation', orgId },
    });
    return NextResponse.json({ revoked: true });
  } catch (error) {
    loggers.api.error('Error revoking organization invitation:', error as Error);
    return NextResponse.json({ error: 'Failed to revoke invitation' }, { status: 500 });
  }
}
