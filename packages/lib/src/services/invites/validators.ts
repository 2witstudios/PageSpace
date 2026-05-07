import {
  isAccountSuspended,
  isEmailMatch,
  isInviteConsumed,
  isInviteExpired,
} from './predicates';
import type {
  Invite,
  InviteAcceptanceErrorCode,
  MagicLinkErrorCode,
  Result,
  RevokeErrorCode,
  Role,
  UserAccount,
} from './types';

export const validateInviteForUser = ({
  invite,
  userEmail,
  suspendedAt,
  now,
}: {
  invite: Invite;
  userEmail: string;
  suspendedAt: Date | null;
  now: Date;
}): Result<Invite, InviteAcceptanceErrorCode> => {
  if (isAccountSuspended({ suspendedAt })) {
    return { ok: false, error: 'ACCOUNT_SUSPENDED' };
  }
  if (isInviteConsumed({ consumedAt: invite.consumedAt })) {
    return { ok: false, error: 'TOKEN_CONSUMED' };
  }
  if (isInviteExpired({ expiresAt: invite.expiresAt, now })) {
    return { ok: false, error: 'TOKEN_EXPIRED' };
  }
  if (!isEmailMatch({ inviteEmail: invite.email, userEmail })) {
    return { ok: false, error: 'EMAIL_MISMATCH' };
  }
  return { ok: true, data: invite };
};

export const validateMagicLinkRequest = ({
  user,
}: {
  user: UserAccount | null;
}): Result<UserAccount, MagicLinkErrorCode> => {
  if (user === null) {
    return { ok: false, error: 'NO_ACCOUNT_FOUND' };
  }
  if (isAccountSuspended({ suspendedAt: user.suspendedAt })) {
    return { ok: false, error: 'ACCOUNT_SUSPENDED' };
  }
  return { ok: true, data: user };
};

export interface RevokeAuthorizedInvite {
  id: string;
  email: string;
  role: Role;
  driveId: string;
}

const isRevokeRole = (role: Role): boolean => role === 'OWNER' || role === 'ADMIN';

export const validateRevokeRequest = ({
  invite,
  requestedDriveId,
  actorMembership,
}: {
  invite: RevokeAuthorizedInvite | null;
  requestedDriveId: string;
  actorMembership: { role: Role; acceptedAt: Date | null } | null;
}): Result<RevokeAuthorizedInvite, RevokeErrorCode> => {
  if (invite === null || invite.driveId !== requestedDriveId) {
    return { ok: false, error: 'NOT_FOUND' };
  }
  if (
    actorMembership === null ||
    actorMembership.acceptedAt === null ||
    !isRevokeRole(actorMembership.role)
  ) {
    return { ok: false, error: 'FORBIDDEN' };
  }
  return { ok: true, data: invite };
};
