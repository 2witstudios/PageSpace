/**
 * Principal-aware permission dispatch.
 *
 * A request principal is either a user (session auth, an unscoped MCP token,
 * or an account-scoped OAuth token acting as its owning user) or an "app
 * member" (a drive-scoped MCP token with an mcp_token_drives row per drive,
 * or a drive-scoped OAuth access token carrying an equivalent DriveScopeRow[]
 * — see ADR 0002 Decision 2).
 *
 * Model: a key is the user it belongs to, narrowed by scope, optionally
 * weakened by an explicit role. Scope rows default to role NULL = INHERIT (the
 * token resolves with its owner's access); an explicit role is an opt-in
 * downgrade/override that means exactly what the same role means for a human
 * drive member. Inherit/explicit dispatch lives in
 * @pagespace/lib/permissions/app-permissions — these helpers only choose
 * between the user path (sessions, unscoped tokens) and the app path (scoped
 * tokens).
 *
 * Every MCP-accepting route should authorize through these helpers instead of
 * calling the canUser… / getUser… functions directly.
 */
import {
  getUserAccessLevel,
  canUserViewPage,
  canUserEditPage,
  canUserDeletePage,
  canUserSharePage,
  isUserDriveMember,
  isDriveOwnerOrAdmin,
  getUserDriveAccess,
  getDriveIdsForUser,
  getUserAccessiblePagesInDriveWithDetails,
  getBatchPagePermissions,
  type PermissionLevel,
  type PageWithPermissions,
} from '@pagespace/lib/permissions/permissions';
import {
  getAppAccessLevel,
  getAppDriveMembership,
  getAppAccessiblePagesInDrive,
  hasAppDriveMembership,
  getScopedAccessLevel,
  getScopedDriveMembership,
  getScopedAccessiblePagesInDrive,
  hasScopedDriveMembership,
} from '@pagespace/lib/permissions/app-permissions';
import { isMCPAuthResult, isOAuthAuthResult, isManageKeysOnly, type AuthResult, type MCPAuthResult, type OAuthAuthResult } from './index';

/**
 * A scoped MCP token acts as an app member (its allowedDriveIds are exactly its
 * mcp_token_drives memberships). Unscoped tokens and sessions act as the user.
 */
export function isScopedMCPAuth(auth: AuthResult): auth is MCPAuthResult {
  return isMCPAuthResult(auth) && auth.allowedDriveIds.length > 0;
}

/**
 * A drive-scoped OAuth access token (any scope short of `account`) acts as an
 * app member, exactly like a scoped MCP token — an account-scoped OAuth token
 * is a full-user credential and acts as the user instead.
 */
export function isScopedOAuthAuth(auth: AuthResult): auth is OAuthAuthResult {
  return isOAuthAuthResult(auth) && !auth.scopes.account;
}

export async function getPrincipalAccessLevel(
  auth: AuthResult,
  pageId: string,
): Promise<PermissionLevel | null> {
  if (isManageKeysOnly(auth)) return null;
  if (isScopedMCPAuth(auth)) {
    return getAppAccessLevel(auth.tokenId, pageId);
  }
  if (isScopedOAuthAuth(auth)) {
    return getScopedAccessLevel(auth.driveScopes, auth.userId, pageId);
  }
  return getUserAccessLevel(auth.userId, pageId);
}

export async function canPrincipalViewPage(auth: AuthResult, pageId: string): Promise<boolean> {
  if (isManageKeysOnly(auth)) return false;
  if (isScopedMCPAuth(auth)) {
    const level = await getAppAccessLevel(auth.tokenId, pageId);
    return level?.canView ?? false;
  }
  if (isScopedOAuthAuth(auth)) {
    const level = await getScopedAccessLevel(auth.driveScopes, auth.userId, pageId);
    return level?.canView ?? false;
  }
  return canUserViewPage(auth.userId, pageId);
}

export async function canPrincipalEditPage(auth: AuthResult, pageId: string): Promise<boolean> {
  if (isManageKeysOnly(auth)) return false;
  if (isScopedMCPAuth(auth)) {
    const level = await getAppAccessLevel(auth.tokenId, pageId);
    return level?.canEdit ?? false;
  }
  if (isScopedOAuthAuth(auth)) {
    const level = await getScopedAccessLevel(auth.driveScopes, auth.userId, pageId);
    return level?.canEdit ?? false;
  }
  return canUserEditPage(auth.userId, pageId);
}

export async function canPrincipalDeletePage(auth: AuthResult, pageId: string): Promise<boolean> {
  if (isManageKeysOnly(auth)) return false;
  if (isScopedMCPAuth(auth)) {
    const level = await getAppAccessLevel(auth.tokenId, pageId);
    return level?.canDelete ?? false;
  }
  if (isScopedOAuthAuth(auth)) {
    const level = await getScopedAccessLevel(auth.driveScopes, auth.userId, pageId);
    return level?.canDelete ?? false;
  }
  return canUserDeletePage(auth.userId, pageId);
}

export async function canPrincipalSharePage(auth: AuthResult, pageId: string): Promise<boolean> {
  if (isManageKeysOnly(auth)) return false;
  if (isScopedMCPAuth(auth)) {
    const level = await getAppAccessLevel(auth.tokenId, pageId);
    return level?.canShare ?? false;
  }
  if (isScopedOAuthAuth(auth)) {
    const level = await getScopedAccessLevel(auth.driveScopes, auth.userId, pageId);
    return level?.canShare ?? false;
  }
  return canUserSharePage(auth.userId, pageId);
}

export async function isPrincipalDriveMember(auth: AuthResult, driveId: string): Promise<boolean> {
  if (isManageKeysOnly(auth)) return false;
  if (isScopedMCPAuth(auth)) {
    return hasAppDriveMembership(auth.tokenId, driveId);
  }
  if (isScopedOAuthAuth(auth)) {
    return hasScopedDriveMembership(auth.driveScopes, auth.userId, driveId);
  }
  return isUserDriveMember(auth.userId, driveId);
}

export async function getPrincipalDriveAccess(auth: AuthResult, driveId: string): Promise<boolean> {
  if (isScopedMCPAuth(auth)) {
    return hasAppDriveMembership(auth.tokenId, driveId);
  }
  if (isScopedOAuthAuth(auth)) {
    return hasScopedDriveMembership(auth.driveScopes, auth.userId, driveId);
  }
  return getUserDriveAccess(auth.userId, driveId);
}

export async function isPrincipalDriveOwnerOrAdmin(auth: AuthResult, driveId: string): Promise<boolean> {
  if (isManageKeysOnly(auth)) return false;
  if (isScopedMCPAuth(auth)) {
    const membership = await getAppDriveMembership(auth.tokenId, driveId);
    if (!membership) return false;
    // Inherit: the key is its owner — the owner's own authority decides.
    if (membership.role === null) return isDriveOwnerOrAdmin(auth.userId, driveId);
    return membership.role === 'OWNER' || membership.role === 'ADMIN';
  }
  if (isScopedOAuthAuth(auth)) {
    const membership = getScopedDriveMembership(auth.driveScopes, driveId);
    if (!membership) return false;
    if (membership.role === null) return isDriveOwnerOrAdmin(auth.userId, driveId);
    return membership.role === 'ADMIN';
  }
  return isDriveOwnerOrAdmin(auth.userId, driveId);
}

/**
 * The principal's drive universe: a scoped token's mcp_token_drives memberships
 * (NOT intersected with the owning user's drives), otherwise the user's drives.
 */
export async function getPrincipalDriveIds(auth: AuthResult): Promise<string[]> {
  if (isManageKeysOnly(auth)) return [];
  if (isScopedMCPAuth(auth)) {
    return auth.allowedDriveIds;
  }
  if (isScopedOAuthAuth(auth)) {
    return auth.allowedDriveIds;
  }
  return getDriveIdsForUser(auth.userId);
}


export async function getPrincipalAccessiblePagesInDrive(
  auth: AuthResult,
  driveId: string,
): Promise<PageWithPermissions[]> {
  if (isScopedMCPAuth(auth)) {
    return getAppAccessiblePagesInDrive(auth.tokenId, driveId);
  }
  if (isScopedOAuthAuth(auth)) {
    return getScopedAccessiblePagesInDrive(auth.driveScopes, auth.userId, driveId);
  }
  return getUserAccessiblePagesInDriveWithDetails(auth.userId, driveId);
}

/**
 * Batch page permissions for the principal. Like getBatchPagePermissions, the
 * result has an all-false entry for every requested id, so callers can read
 * `map.get(pageId)?.canView` without missing-entry handling.
 */
export async function getPrincipalBatchPagePermissions(
  auth: AuthResult,
  pageIds: string[],
): Promise<Map<string, PermissionLevel>> {
  if (!isScopedMCPAuth(auth) && !isScopedOAuthAuth(auth)) {
    return getBatchPagePermissions(auth.userId, pageIds);
  }

  const deny: PermissionLevel = { canView: false, canEdit: false, canShare: false, canDelete: false };
  const results = new Map<string, PermissionLevel>();
  for (const pageId of pageIds) {
    results.set(pageId, { ...deny });
  }
  if (pageIds.length === 0) return results;

  // Resolve per-drive: enumerate the token's accessible pages in each scoped
  // drive once, then pick out the requested ids. Pages outside the token's
  // drives stay denied.
  const requested = new Set(pageIds);
  for (const driveId of auth.allowedDriveIds) {
    const accessible = isScopedMCPAuth(auth)
      ? await getAppAccessiblePagesInDrive(auth.tokenId, driveId)
      : await getScopedAccessiblePagesInDrive((auth as OAuthAuthResult).driveScopes, auth.userId, driveId);
    for (const page of accessible) {
      if (requested.has(page.id)) {
        results.set(page.id, { ...page.permissions });
      }
    }
  }
  return results;
}
