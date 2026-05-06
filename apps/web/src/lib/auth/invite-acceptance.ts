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
  | 'EMAIL_MISMATCH'
  | 'ALREADY_MEMBER';

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

interface AcceptInviteForExistingUserInput {
  token: string;
  userId: string;
  userEmail: string;
  now: Date;
}

// For users who already have an account and arrive at /auth/login?invite=<token>.
// Mirrors acceptInviteForNewUser but additionally rejects ALREADY_MEMBER if the
// user already holds a non-pending membership in the target drive — re-clicking
// an old invite link must not silently re-add the user.
export const acceptInviteForExistingUser = async ({
  token,
  userId,
  userEmail,
  now,
}: AcceptInviteForExistingUserInput): Promise<InviteAcceptanceResult> => {
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

  const existing = await driveInviteRepository.findExistingMember(invite.driveId, userId);
  if (existing) {
    if (existing.acceptedAt !== null) {
      return { ok: false, error: 'ALREADY_MEMBER' };
    }
    // Legacy pending row from the pre-cutover model (drive_members keyed on
    // userId with acceptedAt = null). Task 12's data migration deletes these,
    // but during the deploy window — or if a user was missed — we must clean
    // up the ghost row before inserting the fresh accepted membership;
    // otherwise the unique (driveId, userId) constraint fires after the
    // invite is already consumed and the user is stuck.
    await driveInviteRepository.deleteDriveMemberById(existing.id);
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
