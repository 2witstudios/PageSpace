/**
 * The org branch of the invite page (/invite/<token>, ORG-3): loads what decideOrgInviteView
 * needs — the invitation by its link token, the signed-in viewer from the session cookie, their
 * membership, and whether the invited address has an account — and returns the screen to render,
 * with only what that screen shows (orgInviteCardModel: a spent link carries its state alone). Null
 * when the token is not an org invitation, so the page falls through to the drive, page and
 * connection invites (and to their one "no longer valid" card for a token nothing holds).
 */
import { sessionService } from '@pagespace/lib/auth/session-service';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { findInvitationByToken } from '@pagespace/lib/organizations/invitations';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { decideOrgInviteView } from '@pagespace/lib/organizations/invite-view-core';
import { orgInviteCardModel, type OrgInviteCardModel } from './org-invite-view';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

async function signedInUserId(cookieHeader: string): Promise<string | null> {
  const sessionToken = getSessionFromCookies(cookieHeader);
  if (!sessionToken) return null;
  const session = await sessionService.validateSession(sessionToken, { expectedType: 'user' });
  return session?.userId ?? null;
}

export async function loadOrgInvitePage(input: {
  token: string;
  cookieHeader: string;
  now: Date;
}): Promise<OrgInviteCardModel | null> {
  // Dark while orgs are: no org invitation can be issued then.
  if (!ORGS_ENABLED) return null;
  const invite = await findInvitationByToken(input.token);
  if (!invite) return null;

  const userId = await signedInUserId(input.cookieHeader);
  const [viewerAccount, membershipRole, invitedAccount, inviter] = await Promise.all([
    userId ? driveInviteRepository.findInviterDisplay(userId) : Promise.resolve(null),
    userId ? findMembershipRole(invite.orgId, userId) : Promise.resolve(null),
    driveInviteRepository.loadUserAccountByEmail(invite.email),
    invite.invitedBy ? driveInviteRepository.findInviterDisplay(invite.invitedBy) : Promise.resolve(null),
  ]);
  const viewer = viewerAccount ? { email: viewerAccount.email, isMember: membershipRole !== null } : null;

  const view = decideOrgInviteView({ invite, viewer, invitedAccountExists: invitedAccount !== null, now: input.now });
  return orgInviteCardModel(view, {
    orgId: invite.orgId,
    orgName: invite.orgName,
    inviterName: inviter?.name ?? 'A teammate',
    role: invite.role,
    invitedEmail: invite.email,
    viewerEmail: viewer?.email ?? null,
  });
}
