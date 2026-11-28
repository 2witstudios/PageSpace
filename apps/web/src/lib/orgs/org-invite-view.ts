/**
 * The org invitation card's screens (ORG-3). The page's first screen is decideOrgInviteView's
 * (server); this maps what POST /api/orgs/invitations/accept answered — decided again inside the
 * acceptance transaction, so the invite may have changed since the page loaded — onto the same
 * screens. Pure and client-safe.
 */
import type { OrgInviteView } from '@pagespace/lib/organizations/invite-view-core';

/** Where a person lands once they belong to the org: its hub. */
export const orgHubPath = (orgId: string): string => `/orgs/${encodeURIComponent(orgId)}/settings`;

/** The invite page for a link token (the email's link; where a refused auth-time acceptance returns, to say why). */
export const orgInvitePagePath = (token: string): string => `/invite/${encodeURIComponent(token)}`;

export type OrgInviteScreen = OrgInviteView | 'org_lapsed' | 'failed';

type InvitedRole = 'OWNER' | 'ADMIN' | 'MEMBER';

/**
 * What the page hands the card for each screen: only what that screen shows (review of #2869).
 * A link that cannot be used carries nothing but its state — no address, org, inviter or role —
 * since its props are in the page's HTML for anyone holding the link.
 */
export type OrgInviteCardModel =
  | { view: 'invalid' }
  | { view: 'expired' }
  | { view: 'already_member'; orgId: string; orgName: string }
  | { view: 'wrong_account'; invitedEmail: string; viewerEmail: string | null }
  | { view: 'sign_in' | 'sign_up' | 'accept'; orgName: string; inviterName: string; role: InvitedRole; invitedEmail: string };

export const orgInviteCardModel = (
  view: OrgInviteView,
  facts: { orgId: string; orgName: string; inviterName: string; role: InvitedRole; invitedEmail: string; viewerEmail: string | null },
): OrgInviteCardModel => {
  switch (view) {
    case 'invalid':
    case 'expired':
      return { view };
    case 'already_member':
      // The viewer is a member: the org is theirs to see, and its hub is where they go.
      return { view, orgId: facts.orgId, orgName: facts.orgName };
    case 'wrong_account':
      return { view, invitedEmail: facts.invitedEmail, viewerEmail: facts.viewerEmail };
    case 'sign_in':
    case 'sign_up':
    case 'accept':
      return { view, orgName: facts.orgName, inviterName: facts.inviterName, role: facts.role, invitedEmail: facts.invitedEmail };
  }
};

export type AcceptOutcome = { ok: true; orgId: string; joined: boolean } | { ok: false; code: string | null };

export const screenAfterAccept = (outcome: AcceptOutcome): OrgInviteScreen | 'joined' => {
  if (outcome.ok) return outcome.joined ? 'joined' : 'already_member';
  switch (outcome.code) {
    case 'expired':
      return 'expired';
    case 'email_mismatch':
      return 'wrong_account';
    case 'org_lapsed':
      return 'org_lapsed';
    case 'not_found':
    case 'already_accepted':
      return 'invalid';
    default:
      return 'failed';
  }
};
