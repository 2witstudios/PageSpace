/**
 * Account deletion / consent revocation for Sign in with Apple (Guideline
 * 5.1.1(v), TN3194): revoke each stored refresh token with Apple, then discard
 * it. Apple failures never stop the discard — the deletion request must be
 * fulfilled whatever Apple does — and are reported in the summary so the caller
 * can tell the user to finish the job in their Apple Account settings.
 */
import { loggers } from '../../logging/logger-config';
import { decryptField } from '../../encryption/field-crypto';
import { getAppleSigningConfig, type AppleSigningConfig } from './apple-client-secret';
import { revokeAppleRefreshToken } from './apple-token-api';
import { appleTokenStore } from './apple-token-store';

export interface AppleRevocationSummary {
  hadTokens: boolean;
  revoked: number;
  failed: number;
  /** Tokens were stored but no signing key is configured to revoke them. */
  unconfigured: boolean;
}

/**
 * Revoke and delete every stored Apple token for the user. Throws only when the
 * delete itself fails (the caller records that step as failed).
 */
export async function revokeAndDiscardAppleTokens(
  userId: string,
  config: AppleSigningConfig | null = getAppleSigningConfig(),
): Promise<AppleRevocationSummary> {
  const stored = await appleTokenStore.listForUser(userId);
  let revoked = 0;
  let failed = 0;

  if (config) {
    for (const token of stored) {
      try {
        const refreshToken = await decryptField(token.refreshToken);
        const result = await revokeAppleRefreshToken({ refreshToken, clientId: token.clientId, config });
        if (result.ok) {
          revoked++;
        } else {
          failed++;
          loggers.auth.warn('Apple token revocation failed', { userId, clientId: token.clientId, reason: result.reason });
        }
      } catch (error) {
        failed++;
        loggers.auth.warn('Apple token revocation failed', {
          userId,
          clientId: token.clientId,
          reason: error instanceof Error ? error.name : 'unknown_error',
        });
      }
    }
  } else if (stored.length > 0) {
    loggers.auth.warn('Apple tokens discarded without revocation: signing key not configured', { userId, count: stored.length });
  }

  await appleTokenStore.deleteForUser(userId);

  return { hadTokens: stored.length > 0, revoked, failed, unconfigured: stored.length > 0 && !config };
}

/** What the deletion flow tells the user about Sign in with Apple. */
export type AppleSignInDeletionOutcome = 'revoked' | 'manual' | 'none';

/**
 * `revoked` only when every stored token was revoked with Apple. Any Apple-linked
 * user we could not fully revoke for — no token on file (signed in before tokens
 * were kept), no signing key, an Apple failure, or the step itself failing
 * (`summary: null`) — gets the manual "Stop Using" steps.
 */
export function appleSignInDeletionOutcome(args: {
  appleLinked: boolean;
  summary: AppleRevocationSummary | null;
}): AppleSignInDeletionOutcome {
  const { appleLinked, summary } = args;
  if (summary && summary.hadTokens && !summary.unconfigured && summary.failed === 0 && summary.revoked > 0) {
    return 'revoked';
  }
  if (appleLinked || summary?.hadTokens) return 'manual';
  return 'none';
}
