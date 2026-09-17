/**
 * Sends the org invitation email for a freshly issued (or rotated) invite token.
 * The link opens the Wave F accept page, which signs the person in or up and then
 * POSTs the token to /api/orgs/invitations/accept.
 */
import { resolveAppUrl } from '@pagespace/lib/services/email-service';
import { sendOrgInvitationEmail } from '@pagespace/lib/services/notification-email-service';
import { INVITE_EXPIRY_DAYS, type InvitableRole } from '@pagespace/lib/organizations/invitations';
import { findOrganizationById } from '@pagespace/lib/organizations/repository';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

export const orgInviteUrl = (appUrl: string, token: string): string =>
  `${appUrl.replace(/\/+$/, '')}/orgs/invite?token=${encodeURIComponent(token)}`;

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
