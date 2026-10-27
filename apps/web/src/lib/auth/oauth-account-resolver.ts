import { authRepository, type User } from '@/lib/repositories/auth-repository';
import { resolveOAuthMatch, type OAuthMatchDecision } from '@pagespace/lib/auth/oauth-account-match';

export interface OAuthAccountResolution {
  /** The shared account-match decision (see {@link resolveOAuthMatch}). */
  decision: OAuthMatchDecision;
  /**
   * The account to authenticate for `use-sub` / `use-email`; `null` for
   * `create-new` and `reject`.
   */
  user: User | null;
  /**
   * The account matched by raw email, if any. Exposed so the `reject` path can
   * audit the targeted victim account; never authenticate this directly.
   */
  emailMatch: User | null;
}

/**
 * Resolve an OAuth identity against existing accounts (audit finding M5).
 *
 * The single security-critical choke point shared by every OAuth route: it
 * looks up the provider-subject and the email separately and reconciles them
 * through {@link resolveOAuthMatch}, so an unverified provider email can never
 * link to an existing account. The route shell maps the returned `decision` to
 * a provider-appropriate response — and a `reject` decision MUST deny sign-in.
 */
export async function resolveOAuthAccount(params: {
  provider: 'google' | 'apple';
  providerId: string;
  email: string;
  emailVerified: boolean;
}): Promise<OAuthAccountResolution> {
  const { provider, providerId, email, emailVerified } = params;

  const subMatch =
    provider === 'google'
      ? await authRepository.findUserByGoogleId(providerId)
      : await authRepository.findUserByAppleId(providerId);
  const emailMatch = await authRepository.findUserByEmail(email);

  const decision = resolveOAuthMatch({
    providerSubMatch: !!subMatch,
    emailMatch: !!emailMatch,
    emailVerified,
  });

  const user =
    decision === 'use-sub' ? subMatch : decision === 'use-email' ? emailMatch : null;

  return { decision, user, emailMatch };
}
