/**
 * Drive-invite acceptance pipes.
 *
 * Composed from pure predicates (isInviteExpired, isInviteConsumed,
 * isEmailMatchingInvite) plus repository side effects (lookup, mark consumed,
 * insert driveMembers). Each step short-circuits on failure and returns a
 * discriminated result instead of throwing — callers convert the result into
 * a UI toast or HTTP response without try/catch.
 *
 * Single-use semantics: markInviteConsumed runs an atomic conditional UPDATE
 * (WHERE consumedAt IS NULL). A concurrent acceptance that already consumed
 * the invite causes that step to return false, which we surface as
 * TOKEN_CONSUMED — the user sees "this invite is no longer valid" rather
 * than a partial success.
 */

import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { hashToken } from '@pagespace/lib/auth/token-utils';
import {
  isInviteConsumed,
  isInviteExpired,
  isEmailMatchingInvite,
} from '@pagespace/lib/services/invite-predicates';

export type InviteAcceptanceError =
  | 'TOKEN_NOT_FOUND'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_CONSUMED'
  | 'EMAIL_MISMATCH';

export interface AcceptedInviteData {
  driveId: string;
  driveName: string;
  memberId: string;
}

export type InviteAcceptanceResult =
  | { ok: true; data: AcceptedInviteData }
  | { ok: false; error: InviteAcceptanceError };

interface AcceptInviteForNewUserInput {
  token: string;
  userId: string;
  userEmail: string;
  now: Date;
}

export const acceptInviteForNewUser = async ({
  token,
  userId,
  userEmail,
  now,
}: AcceptInviteForNewUserInput): Promise<InviteAcceptanceResult> => {
  const invite = await driveInviteRepository.findPendingInviteByTokenHash(hashToken(token));
  if (!invite) return { ok: false, error: 'TOKEN_NOT_FOUND' };

  if (isInviteConsumed({ consumedAt: invite.consumedAt })) {
    return { ok: false, error: 'TOKEN_CONSUMED' };
  }
  if (isInviteExpired({ expiresAt: invite.expiresAt, now })) {
    return { ok: false, error: 'TOKEN_EXPIRED' };
  }
  if (!isEmailMatchingInvite({ inviteEmail: invite.email, userEmail })) {
    return { ok: false, error: 'EMAIL_MISMATCH' };
  }

  const consumed = await driveInviteRepository.markInviteConsumed(invite.id);
  if (!consumed) return { ok: false, error: 'TOKEN_CONSUMED' };

  const member = await driveInviteRepository.createDriveMember({
    driveId: invite.driveId,
    userId,
    role: invite.role,
    customRoleId: null,
    invitedBy: invite.invitedBy,
    acceptedAt: now,
  });

  return {
    ok: true,
    data: { driveId: invite.driveId, driveName: invite.driveName, memberId: member.id },
  };
};
