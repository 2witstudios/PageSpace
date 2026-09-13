/**
 * What `/api/auth/me` may tell an OAuth client about the user (Phase 1a,
 * point guard ruling; ADR 0004 Decisions 4 and 8). Identity is consent-bound:
 * the consent screen is part of the security boundary, so a third-party app
 * learns only what the user was shown it would learn.
 *
 * Pure. `clientFirstParty` is resolved from CODE at the door
 * (`validateOAuthAccessToken`), never from a database column.
 */
import type { ScopeSet } from '@pagespace/lib/auth/oauth/scopes';

/**
 * `full` — the whole profile (the CLI's `login`/`whoami`, or an `account` grant, which already is the user).
 * `profile` — only what `profile` consent narrates: id, name, email, avatar.
 * `deny` — identity was never consented to.
 */
export type IdentityDisclosure = 'full' | 'profile' | 'deny';

export function decideIdentityDisclosure(token: {
  readonly clientFirstParty: boolean;
  readonly scopes: Pick<ScopeSet, 'account' | 'profile'>;
}): IdentityDisclosure {
  if (token.scopes.account) return 'full';
  if (token.clientFirstParty === true) return 'full';
  if (token.scopes.profile) return 'profile';
  return 'deny';
}
