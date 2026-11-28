/**
 * Accepting an org invitation by its link token (ORG-3), for a signed-in person: the one shell
 * both doors use — POST /api/orgs/invitations/accept (the accept page's button) and the sign-in /
 * sign-up routes that carry `?invite=<token>` through every auth method
 * (consumeAnyInviteIfPresent). The decision is acceptInvitation's, inside its transaction.
 */
import { announceOrgChange } from '@pagespace/lib/organizations/org-change-events';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { acceptInvitation, type AcceptInvitationResult } from '@pagespace/lib/organizations/invitations';

export async function acceptOrgInviteForUser(input: {
  request: Request;
  token: string;
  userId: string;
}): Promise<AcceptInvitationResult> {
  const result = await acceptInvitation({ token: input.token, userId: input.userId, now: new Date() });
  if (!result.ok) {
    auditRequest(input.request, {
      eventType: 'authz.access.denied',
      userId: input.userId,
      resourceType: 'organization_invitation',
      resourceId: 'token',
      details: { operation: 'accept_org_invitation', reason: result.reason },
    });
    return result;
  }
  auditRequest(input.request, {
    eventType: 'authz.role.assigned',
    userId: input.userId,
    resourceType: 'organization',
    resourceId: result.orgId,
    details: { operation: 'accept_org_invitation', role: result.role, joined: result.joined },
  });
  // X-4: members see the change without a refresh (org:changed, no content).
  void announceOrgChange(result.orgId, 'membership');
  return result;
}
