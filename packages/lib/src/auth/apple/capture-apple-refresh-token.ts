/**
 * TN3194 "securely store user tokens": after a Sign in with Apple sign-in has
 * been verified, validate Apple's authorization code with /auth/token and keep
 * the refresh token (encrypted) so account deletion can revoke it later.
 *
 * Never throws and never blocks a sign-in on its own: callers fire it after the
 * session response is built. A missing signing key is a supported state
 * ('skipped'); sign-in keeps working on the verified id_token alone.
 */
import { loggers } from '../../logging/logger-config';
import { encryptField } from '../../encryption/field-crypto';
import { getAppleSigningConfig, type AppleSigningConfig } from './apple-client-secret';
import { exchangeAppleAuthorizationCode } from './apple-token-api';
import { appleTokenStore } from './apple-token-store';
import { revokeAndDiscardAppleTokens } from './revoke-apple-tokens';
import { dataSubjectRequestRepository } from '../../repositories/data-subject-request-repository';

export type AppleTokenCaptureOutcome = 'stored' | 'skipped' | 'failed';

export interface CaptureAppleRefreshTokenArgs {
  userId: string;
  code: string;
  /** The verified id_token's `aud` — the client that issued the code. */
  clientId: string;
  /** The verified id_token's `sub`; the exchanged token must belong to the same Apple user. */
  expectedSub: string;
  /** Only for the web flow, whose authorization request carried a redirect_uri. */
  redirectUri?: string;
}

function readSub(idToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function captureAppleRefreshToken(
  args: CaptureAppleRefreshTokenArgs,
  config: AppleSigningConfig | null = getAppleSigningConfig(),
): Promise<AppleTokenCaptureOutcome> {
  if (!config) return 'skipped';

  const fail = (reason: string): AppleTokenCaptureOutcome => {
    loggers.auth.warn('Apple refresh token capture failed', { userId: args.userId, clientId: args.clientId, reason });
    return 'failed';
  };

  try {
    const exchange = await exchangeAppleAuthorizationCode({
      code: args.code,
      clientId: args.clientId,
      redirectUri: args.redirectUri,
      config,
    });
    if (!exchange.ok) return fail(exchange.reason);

    // The code arrived beside the id_token from the client; the token Apple
    // returns for it must name the same Apple user we just authenticated.
    if (!exchange.idToken || readSub(exchange.idToken) !== args.expectedSub) {
      return fail('subject_mismatch');
    }

    // Account deletion revokes and discards tokens when it is requested. A token
    // arriving after that would be deleted by the erasure's cascade WITHOUT being
    // revoked, so never store one while an erasure is active.
    if (await dataSubjectRequestRepository.findActiveErasureForUser(args.userId)) {
      loggers.auth.info('Apple refresh token not stored: account erasure in progress', { userId: args.userId });
      return 'skipped';
    }

    await appleTokenStore.upsert({
      userId: args.userId,
      clientId: args.clientId,
      encryptedRefreshToken: await encryptField(exchange.refreshToken),
    });

    // Close the check-then-write race: a deletion lodged between the check above
    // and this upsert listed no tokens to revoke, so revoke what we just stored.
    if (await dataSubjectRequestRepository.findActiveErasureForUser(args.userId)) {
      loggers.auth.info('Account erasure began during Apple token capture; revoking the new token', { userId: args.userId });
      await revokeAndDiscardAppleTokens(args.userId, config);
      return 'skipped';
    }

    loggers.auth.info('Apple refresh token stored', { userId: args.userId, clientId: args.clientId });
    return 'stored';
  } catch (error) {
    return fail(error instanceof Error ? error.name : 'unknown_error');
  }
}
