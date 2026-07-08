import type { OAuthAuthResult } from '../index';

/**
 * A manage-keys-only OAuth credential. `parseScopeList` mints
 * `scopes.manageKeys: true` today via the `manage_keys` token (see
 * ScopeSet.manageKeys) — this fixture exists so tests can prove the
 * drive-scope helpers already fail closed for it, rather than applying the
 * empty-driveScopes-means-full-access convention every other credential
 * relies on.
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
    scopes: { account: false, offlineAccess: false, drives: new Map(), manageKeys: true, updateKeyId: null, activateKeyId: null },
    driveScopes: [],
    allowedDriveIds: [],
    ...overrides,
  };
}

/**
 * A drive-scoped OAuth credential (app member for one drive only, ADR 0002
 * Decision 2) — the negative counterpart to `manageKeysScopedAuthResult`,
 * used to prove the mcp-tokens scope-guard still rejects this shape while
 * admitting a manage_keys-only one.
 */
export function driveScopedOAuthAuthResult(
  overrides: Partial<OAuthAuthResult> = {}
): OAuthAuthResult {
  return {
    tokenType: 'oauth',
    userId: 'test-user-id',
    role: 'user',
    tokenVersion: 0,
    adminRoleVersion: 0,
    tokenId: 'oauth-token-1',
    scopes: {
      account: false,
      offlineAccess: false,
      manageKeys: false,
      updateKeyId: null, activateKeyId: null,
      drives: new Map([['drive-1', { kind: 'drive', driveId: 'drive-1', role: { kind: 'inherit' } }]]),
    },
    driveScopes: [{ driveId: 'drive-1', role: null, customRoleId: null }],
    allowedDriveIds: ['drive-1'],
    ...overrides,
  };
}
