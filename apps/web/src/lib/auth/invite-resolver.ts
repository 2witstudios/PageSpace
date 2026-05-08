import { hashToken } from '@pagespace/lib/auth/token-utils';
import { isInviteExpired, isInviteConsumed } from '@pagespace/lib/services/invites';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { connectionInviteRepository } from '@/lib/repositories/connection-invite-repository';

export type InviteResolutionError = 'NOT_FOUND' | 'EXPIRED' | 'CONSUMED';

export type InviteContextData =
  | {
      kind: 'drive';
      driveName: string;
      inviterName: string;
      role: 'OWNER' | 'ADMIN' | 'MEMBER';
      email: string;
      isExistingUser: boolean;
    }
  | {
      kind: 'connection';
      inviterName: string;
      email: string;
      isExistingUser: boolean;
      message: string | null;
    };

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
 *
 * Token hashes are universally unique across the drive and connection invite
 * tables (same `ps_invite_*` generator, per-table UNIQUE indices), so at most
 * one table will return a row.
 */
export const resolveInviteContext = async ({
  token,
  now,
}: {
  token: string;
  now: Date;
}): Promise<InviteResolution> => {
  const tokenHash = hashToken(token);

  const [driveRow, connectionRow] = await Promise.all([
    driveInviteRepository.findPendingInviteByTokenHash(tokenHash),
    connectionInviteRepository.findPendingInviteByTokenHash(tokenHash),
  ]);

  const row = driveRow ?? connectionRow;
  if (!row) {
    return { ok: false, error: 'NOT_FOUND' };
  }
  if (isInviteConsumed({ consumedAt: row.consumedAt })) {
    return { ok: false, error: 'CONSUMED' };
  }
  if (isInviteExpired({ expiresAt: row.expiresAt, now })) {
    return { ok: false, error: 'EXPIRED' };
  }

  // Classify by ACCOUNT PRESENCE. OAuth/magic-link users are real existing
  // accounts even if their ToS state predates the consent column; the accept
  // gateway re-prompts for ToS separately when needed.
  const account = await driveInviteRepository.loadUserAccountByEmail(row.email);
  const isExistingUser = account !== null;

  if (driveRow) {
    return {
      ok: true,
      data: {
        kind: 'drive',
        driveName: driveRow.driveName,
        inviterName: driveRow.inviterName,
        role: driveRow.role,
        email: driveRow.email,
        isExistingUser,
      },
    };
  }

  return {
    ok: true,
    data: {
      kind: 'connection',
      inviterName: connectionRow!.inviterName,
      email: connectionRow!.email,
      isExistingUser,
      message: connectionRow!.requestMessage,
    },
  };
};
