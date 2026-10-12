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
