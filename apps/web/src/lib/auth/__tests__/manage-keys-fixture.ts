import type { OAuthAuthResult } from '../index';

/**
 * A manage-keys-only OAuth credential. No scope parser can produce
 * `scopes.manageKeys: true` today (see ScopeSet.manageKeys) — this fixture
 * exists so tests can prove the drive-scope helpers already fail closed for
 * it, rather than applying the empty-driveScopes-means-full-access
 * convention every other credential relies on.
 */
export function manageKeysScopedAuthResult(
  overrides: Partial<OAuthAuthResult> = {}
): OAuthAuthResult {
  return {
    tokenType: 'oauth',
    userId: 'user-manage-keys',
    role: 'user',
    tokenVersion: 1,
    adminRoleVersion: 0,
    tokenId: 'oauth-token-manage-keys',
    scopes: { account: false, offlineAccess: false, drives: new Map(), manageKeys: true },
    driveScopes: [],
    allowedDriveIds: [],
    ...overrides,
  };
}
