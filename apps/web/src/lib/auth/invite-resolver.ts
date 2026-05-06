/**
 * Drive-invite resolver.
 *
 * Resolves a raw invite token (from /invite/[token]) into the context the
 * consent page needs to render: drive name, inviter name, role, invited email,
 * and whether the email already maps to a fully-onboarded existing user.
 *
 * The raw token is hashed before lookup — only the SHA3-256 hash exists in the
 * DB. Expired and consumed invites are surfaced as discrete error variants so
 * the consent page can render a "this invite is no longer valid" message
 * rather than redirecting (which would leak that the token ever existed).
 *
 * "Existing user" is defined as `tosAcceptedAt IS NOT NULL` — a user with a
 * row but no ToS acceptance is an orphan from the old auto-create path and is
 * treated as a new user (consent screen routes them to /auth/signup, not login).
 */

import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { hashToken } from '@pagespace/lib/auth/token-utils';
import {
  isInviteConsumed,
  isInviteExpired,
} from '@pagespace/lib/services/invite-predicates';

export type InviteResolutionError = 'NOT_FOUND' | 'EXPIRED' | 'CONSUMED';

export interface InviteContext {
  driveName: string;
  inviterName: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  email: string;
  isExistingUser: boolean;
}

export type InviteResolution =
  | { ok: true; data: InviteContext }
  | { ok: false; error: InviteResolutionError };

export const resolveInviteContext = async ({
  token,
  now,
}: {
  token: string;
  now: Date;
}): Promise<InviteResolution> => {
  const tokenHash = hashToken(token);
  const invite = await driveInviteRepository.findPendingInviteByTokenHash(tokenHash);
  if (!invite) return { ok: false, error: 'NOT_FOUND' };

  if (isInviteConsumed({ consumedAt: invite.consumedAt })) {
    return { ok: false, error: 'CONSUMED' };
  }
  if (isInviteExpired({ expiresAt: invite.expiresAt, now })) {
    return { ok: false, error: 'EXPIRED' };
  }

  const tosStatus = await driveInviteRepository.findUserToSStatusByEmail(invite.email);
  const isExistingUser = tosStatus?.tosAcceptedAt != null;

  return {
    ok: true,
    data: {
      driveName: invite.driveName,
      inviterName: invite.inviterName,
      role: invite.role,
      email: invite.email,
      isExistingUser,
    },
  };
};
