import type { MCPAuthResult, OAuthAuthResult } from '../index';

/**
 * Principals for the Phase 2 parity cluster tests: the same user reaching a
 * route as a third-party OAuth drive grant, as the drive-scoped `mcp_` key that
 * grant must match, and as an identity-only (`profile`) token that must reach
 * nothing. Each carries exactly the shape `validateOAuthAccessToken` /
 * `validateMCPToken` produce at the door.
 */
export const PARITY_USER_ID = 'parity-user';

export function oauthDriveGrant(
  driveId: string,
  role: 'member' | 'admin' | 'inherit' = 'member',
): OAuthAuthResult {
  const rowRole = role === 'member' ? 'MEMBER' : role === 'admin' ? 'ADMIN' : null;
  return {
    tokenType: 'oauth',
    userId: PARITY_USER_ID,
    role: 'user',
    tokenVersion: 0,
    adminRoleVersion: 0,
    tokenId: 'oauth-access-token-row',
    scopes: {
      account: false,
      offlineAccess: false,
      manageKeys: false,
      allDrives: false,
      profile: false,
      updateKeyId: null,
      activateKeyId: null,
      newKeyName: null,
      drives: new Map([[driveId, { kind: 'drive', driveId, role: { kind: role } }]]),
    },
    driveScopes: [{ driveId, role: rowRole, customRoleId: null }],
    allowedDriveIds: [driveId],
    clientFirstParty: false,
  };
}

export function mcpDriveKey(driveId: string): MCPAuthResult {
  return {
    tokenType: 'mcp',
    userId: PARITY_USER_ID,
    role: 'user',
    tokenVersion: 0,
    adminRoleVersion: 0,
    tokenId: 'mcp-token-row',
    allowedDriveIds: [driveId],
  };
}

/** Exactly what the door mints for `scope=profile`: the no-drive sentinel included. */
export function profileOnlyGrant(): OAuthAuthResult {
  return {
    tokenType: 'oauth',
    userId: PARITY_USER_ID,
    role: 'user',
    tokenVersion: 0,
    adminRoleVersion: 0,
    tokenId: 'oauth-profile-token-row',
    scopes: {
      account: false,
      offlineAccess: false,
      manageKeys: false,
      allDrives: false,
      profile: true,
      updateKeyId: null,
      activateKeyId: null,
      newKeyName: null,
      drives: new Map(),
    },
    driveScopes: [],
    allowedDriveIds: ['PROFILE_ONLY_NO_DRIVE_ACCESS'],
    clientFirstParty: false,
  };
}
