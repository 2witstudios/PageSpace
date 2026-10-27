import { accountRepository } from '@pagespace/lib/repositories/account-repository';
import { appleTokenStore } from '@pagespace/lib/auth/apple/apple-token-store';
import { getAppleSigningConfig } from '@pagespace/lib/auth/apple/apple-client-secret';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

/**
 * GET /api/account/apple-sign-in
 *
 * What account deletion will do about Sign in with Apple (Guideline 5.1.1(v),
 * TN3194), so the delete dialog can say so BEFORE the user confirms:
 *  - `automatic`: a revocable token is on file and the signing key is configured;
 *  - `manual`:    the account uses Sign in with Apple but PageSpace cannot revoke
 *                 it (no token on file, or no key) — show the "Stop Using" steps;
 *  - `none`:      the account never signed in with Apple.
 */
export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const account = await accountRepository.findById(userId);
    if (!account) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    auditRequest(req, { eventType: 'data.read', userId, resourceType: 'account', resourceId: userId, details: { operation: 'apple_sign_in_status' } });

    if (account.appleId === null) {
      return Response.json({ linked: false, revocation: 'none' });
    }

    const revocable = getAppleSigningConfig() !== null && (await appleTokenStore.hasForUser(userId));
    return Response.json({ linked: true, revocation: revocable ? 'automatic' : 'manual' });
  } catch (error) {
    loggers.auth.error('Apple sign-in status error:', error as Error);
    return Response.json({ error: 'Failed to load Sign in with Apple status' }, { status: 500 });
  }
}
