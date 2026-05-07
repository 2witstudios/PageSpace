import { hashToken } from '@pagespace/lib/auth/token-utils';
import {
  isInviteExpired,
  isInviteConsumed,
  isEmailMatch,
} from '@pagespace/lib/services/invites';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

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

export type AcceptInviteResult =
  | { ok: true; data: AcceptedInviteData }
  | { ok: false; error: InviteAcceptanceError };

interface AcceptInviteInput {
  token: string;
  userId: string;
  userEmail: string;
  now: Date;
}

const validateAndLoadInvite = async ({
  token,
  userEmail,
  now,
}: {
  token: string;
  userEmail: string;
  now: Date;
}) => {
  const invite = await driveInviteRepository.findPendingInviteByTokenHash(hashToken(token));
  if (!invite) {
    return { ok: false as const, error: 'TOKEN_NOT_FOUND' as const };
  }
  if (isInviteConsumed({ consumedAt: invite.consumedAt })) {
    return { ok: false as const, error: 'TOKEN_CONSUMED' as const };
  }
  if (isInviteExpired({ expiresAt: invite.expiresAt, now })) {
    return { ok: false as const, error: 'TOKEN_EXPIRED' as const };
  }
  if (!isEmailMatch({ inviteEmail: invite.email, userEmail })) {
    return { ok: false as const, error: 'EMAIL_MISMATCH' as const };
  }
  return { ok: true as const, invite };
};

const consumeAndShape = async (
  invite: NonNullable<Awaited<ReturnType<typeof driveInviteRepository.findPendingInviteByTokenHash>>>,
  userId: string,
  now: Date,
): Promise<AcceptInviteResult> => {
  const result = await driveInviteRepository.consumeInviteAndCreateMembership({
    inviteId: invite.id,
    driveId: invite.driveId,
    userId,
    role: invite.role,
    invitedBy: invite.invitedBy,
    acceptedAt: now,
  });
  if (!result.ok) {
    return { ok: false, error: result.reason };
  }
  return {
    ok: true,
    data: {
      driveId: invite.driveId,
      driveName: invite.driveName,
      memberId: result.memberId,
    },
  };
};

/**
 * Accept an invite on behalf of an already-authenticated existing user.
 *
 * Pre-checks `findExistingMember` so already-accepted users surface
 * `ALREADY_MEMBER` *without* burning the invite token (the inviter sees the
 * outcome and the token can still be re-shared if needed).
 */
export const acceptInviteForExistingUser = async ({
  token,
  userId,
  userEmail,
  now,
}: AcceptInviteInput): Promise<AcceptInviteResult> => {
  const validated = await validateAndLoadInvite({ token, userEmail, now });
  if (!validated.ok) return validated;

  const existing = await driveInviteRepository.findExistingMember(
    validated.invite.driveId,
    userId,
  );
  if (existing && existing.acceptedAt !== null) {
    return { ok: false, error: 'ALREADY_MEMBER' };
  }
  return consumeAndShape(validated.invite, userId, now);
};

/**
 * Accept an invite on behalf of a freshly-created user (signup path).
 *
 * Skips the `findExistingMember` pre-check — the user definitionally has no
 * prior membership. A unique-violation on `driveMembers` from a concurrent
 * race still surfaces as `ALREADY_MEMBER` via the repository.
 */
export const acceptInviteForNewUser = async ({
  token,
  userId,
  userEmail,
  now,
}: AcceptInviteInput): Promise<AcceptInviteResult> => {
  const validated = await validateAndLoadInvite({ token, userEmail, now });
  if (!validated.ok) return validated;
  return consumeAndShape(validated.invite, userId, now);
};
