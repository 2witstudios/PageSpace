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

// Minimal shape every pending-invite kind shares. Each surface stores
// email/expiresAt/consumedAt with the same semantics, so the time/email/
// suspension gate is the same for drive, page, and connection. Carrying a
// generic `T extends MinimalInvite` through the validator lets each pipe pass
// its full record (Invite/PageInvite/ConnectionInvite) and get it back
// narrowed without losing the surface-specific fields.
export interface MinimalInvite {
  email: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export const validatePendingInviteForUser = <T extends MinimalInvite>({
  invite,
  userEmail,
  suspendedAt,
  now,
}: {
  invite: T;
  userEmail: string;
  suspendedAt: Date | null;
  now: Date;
}): Result<T, InviteAcceptanceErrorCode> => {
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

// Drive-specific alias preserved so existing call sites compile unchanged.
// Internally just defers to the generic validator.
export const validateInviteForUser = (input: {
  invite: Invite;
  userEmail: string;
  suspendedAt: Date | null;
  now: Date;
}): Result<Invite, InviteAcceptanceErrorCode> =>
  validatePendingInviteForUser(input);

export const validateMagicLinkRequest = ({
  user,
}: {
  user: UserAccount | null;
}): Result<UserAccount | null, MagicLinkErrorCode> => {
  if (user && isAccountSuspended({ suspendedAt: user.suspendedAt })) {
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
