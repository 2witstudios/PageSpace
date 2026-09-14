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

/**
 * The OAuth scope resolvers as they answer for a user who is STILL a member of
 * every granted drive. The real resolvers (@pagespace/lib app-permissions) read
 * that membership from Postgres inside the package, beyond a route-level mock;
 * their own membership rule is unit-tested there. Route tests swap these in at
 * the app-permissions boundary so the route's principal dispatch runs for real.
 */
export function stillMemberScopedResolvers() {
  type Row = OAuthAuthResult['driveScopes'][number];
  const find = (rows: Row[], driveId: string) => rows.find((row) => row.driveId === driveId) ?? null;
  return {
    getScopedDriveMembership: async (rows: Row[], _userId: string, driveId: string) => {
      const row = find(rows, driveId);
      return row && { role: row.role, customRoleId: row.customRoleId };
    },
    hasScopedDriveMembership: async (rows: Row[], _userId: string, driveId: string) => find(rows, driveId) !== null,
    getScopedDriveAccessLevel: async (rows: Row[], _userId: string, driveId: string) => {
      const row = find(rows, driveId);
      if (!row) return null;
      const adminLike = row.role === 'ADMIN' || row.role === null;
      return { canView: true, canEdit: true, canShare: adminLike, canDelete: adminLike };
    },
  };
}
