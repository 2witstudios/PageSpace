/**
 * What the org invitation page shows (ORG-3). Pure: the page loads the invitation by its link
 * token, the signed-in viewer (if any) and whether the invited address already has an account,
 * and this decides the one state to render. The acceptance itself is decided again by
 * acceptInvitation inside its transaction; this only chooses the screen.
 *
 * A token that matches no row (never issued, revoked, or replaced by a resend) and one that was
 * already used both read "no longer valid", as every other invite link in the app does: the page
 * never tells a stranger which of those happened. An expired link says so, because the remedy
 * differs (ask for a new one).
 */
import { normalizeEmail } from '../encryption/blind-index';

/** A live invite holds a seat and can be accepted: not accepted, not yet expired. */
export const isLiveInvite = (invite: { acceptedAt: Date | null; expiresAt: Date }, now: Date): boolean =>
  invite.acceptedAt === null && invite.expiresAt.getTime() > now.getTime();

export type OrgInviteView =
  | 'invalid'
  | 'expired'
  | 'sign_in'
  | 'sign_up'
  | 'wrong_account'
  | 'already_member'
  | 'accept';

export interface OrgInviteViewInput {
  invite: { email: string; acceptedAt: Date | null; expiresAt: Date } | null;
  /** The signed-in person, or null when signed out. */
  viewer: { email: string; isMember: boolean } | null;
  /** Whether the invited address already has an account (signed-out visitors: sign in vs sign up). */
  invitedAccountExists: boolean;
  now: Date;
}

export const decideOrgInviteView = ({ invite, viewer, invitedAccountExists, now }: OrgInviteViewInput): OrgInviteView => {
  if (invite === null) return 'invalid';
  const live = isLiveInvite(invite, now);
  // A member whose link is spent or stale has nothing to accept. A member holding a LIVE invite
  // still accepts it, so the invite stops holding a second seat (acceptInvitation: consume_only).
  if (viewer?.isMember && !live) return 'already_member';
  if (invite.acceptedAt !== null) return 'invalid';
  if (!live) return 'expired';
  if (viewer === null) return invitedAccountExists ? 'sign_in' : 'sign_up';
  if (normalizeEmail(viewer.email) !== normalizeEmail(invite.email)) return 'wrong_account';
  return 'accept';
};
