/**
 * Sends the org invitation email for a freshly issued (or rotated) invite token.
 * The link opens the app's one invite page (/invite/<token>, shared with drive, page
 * and connection invites): a signed-in invitee accepts there (POST
 * /api/orgs/invitations/accept); a signed-out one signs in or up with the token
 * carried as `?invite=`, and acceptance happens as the session is created.
 */
import { resolveAppUrl } from '@pagespace/lib/services/email-service';
import { sendOrgInvitationEmail } from '@pagespace/lib/services/notification-email-service';
import { INVITE_EXPIRY_DAYS, type InvitableRole } from '@pagespace/lib/organizations/invitations';
import { findOrganizationById } from '@pagespace/lib/organizations/repository';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { orgInvitePagePath } from './org-invite-view';

export const orgInviteUrl = (appUrl: string, token: string): string =>
  `${appUrl.replace(/\/+$/, '')}${orgInvitePagePath(token)}`;

export async function deliverOrgInvite(input: {
  orgId: string;
  inviterId: string;
  email: string;
  role: InvitableRole;
  token: string;
}): Promise<void> {
  const [org, inviter] = await Promise.all([
    findOrganizationById(input.orgId),
    driveInviteRepository.findInviterDisplay(input.inviterId),
  ]);
  await sendOrgInvitationEmail({
    recipientEmail: input.email,
    inviterName: inviter?.name ?? 'A teammate',
    orgName: org?.name ?? 'an organization',
    role: input.role,
    expiresInDays: INVITE_EXPIRY_DAYS,
    inviteUrl: orgInviteUrl(resolveAppUrl(), input.token),
  });
}
