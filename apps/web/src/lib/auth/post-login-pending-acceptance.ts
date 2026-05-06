/**
 * Post-login pending invitation acceptance — deprecated shim.
 *
 * This function used to run a broad userId-keyed sweep of `drive_members`
 * rows with `acceptedAt IS NULL` and accept them all. That model was
 * incompatible with the GDPR + zero-trust drive-invite refactor: pending
 * state no longer lives in `drive_members` (it lives in `pending_invites`,
 * keyed on email + token, accepted only when the user actively comes through
 * the `/invite/[token]/accept` gateway with a live session).
 *
 * The function is preserved as a no-op so the existing 9 auth routes that
 * call it continue to compile and so the post-login-acceptance-coverage gate
 * keeps enforcing the "every auth route must run this hook" contract — but
 * the body is intentionally empty. There is no broad query and no vulnerability
 * surface. New invitee-acceptance happens at /invite/[token]/accept (existing
 * users) and inside /api/auth/signup-passkey via acceptInviteForNewUser
 * (new users).
 *
 * The shim and its callers are scheduled for removal once the data migration
 * (task 12) confirms no legacy `drive_members.acceptedAt IS NULL` rows remain
 * in production data.
 */

export interface AcceptedInvitation {
  driveId: string;
  driveName: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

export async function acceptUserPendingInvitations(
  _userId: string
): Promise<AcceptedInvitation[]> {
  return [];
}
