import { hashToken } from '@pagespace/lib/auth/token-utils';
import { isInviteExpired, isInviteConsumed } from '@pagespace/lib/services/invites';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

export type InviteResolutionError = 'NOT_FOUND' | 'EXPIRED' | 'CONSUMED';

export interface InviteContextData {
  driveName: string;
  inviterName: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  email: string;
  isExistingUser: boolean;
}

export type InviteResolution =
  | { ok: true; data: InviteContextData }
  | { ok: false; error: InviteResolutionError };

/**
 * Resolve an invite token into the data needed by the consent screen.
 *
 * Lookup is by SHA3 hash, never plaintext. Expired and already-consumed rows
 * resolve to discriminated errors so the page renders the same opaque "no
 * longer valid" card for all three failure modes — never disclosing which
 * specific reason caused the rejection (would leak token existence + state).
 */
export const resolveInviteContext = async ({
  token,
  now,
}: {
  token: string;
  now: Date;
}): Promise<InviteResolution> => {
  const tokenHash = hashToken(token);
  const invite = await driveInviteRepository.findPendingInviteByTokenHash(tokenHash);
  if (!invite) {
    return { ok: false, error: 'NOT_FOUND' };
  }
  if (isInviteConsumed({ consumedAt: invite.consumedAt })) {
    return { ok: false, error: 'CONSUMED' };
  }
  if (isInviteExpired({ expiresAt: invite.expiresAt, now })) {
    return { ok: false, error: 'EXPIRED' };
  }

  // Classify by ACCOUNT PRESENCE, not ToS acceptance state. OAuth/magic-link
  // users (and rows from before the ToS column existed) have null
  // tosAcceptedAt yet are real existing accounts — gating on
  // tosAcceptedAt would route them to /auth/signup where signup-passkey
  // returns EMAIL_EXISTS and the invite becomes unclaimable. The accept
  // gateway handles ToS re-prompting separately if/when needed.
  const tosStatus = await driveInviteRepository.findUserToSStatusByEmail(invite.email);
  const isExistingUser = tosStatus !== null;

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
