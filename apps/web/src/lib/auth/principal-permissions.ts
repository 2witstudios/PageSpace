/**
 * Principal-aware permission dispatch.
 *
 * A request principal is either a user (session auth, or an unscoped MCP token
 * acting as its owning user) or an "app member" (a drive-scoped MCP token,
 * which is its own first-class drive member with an RBAC role in
 * mcp_token_drives — see PR #1402).
 *
 * Scoped tokens use their OWN membership role as a REPLACEMENT for the
 * user-level check, not an intersection: a token may legitimately be a member
 * of a drive its owning user is not in, and conversely a MEMBER-role token
 * must not inherit its owner's ADMIN powers. This mirrors the dispatch the
 * /api/mcp/documents route established.
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
  getAppDriveAccessLevel,
  getAppAccessiblePagesInDrive,
  hasAppDriveMembership,
} from '@pagespace/lib/permissions/app-permissions';
import { isMCPAuthResult, type AuthResult, type MCPAuthResult } from './index';

/**
 * A scoped MCP token acts as an app member (its allowedDriveIds are exactly its
 * mcp_token_drives memberships). Unscoped tokens and sessions act as the user.
 */
export function isScopedMCPAuth(auth: AuthResult): auth is MCPAuthResult {
  return isMCPAuthResult(auth) && auth.allowedDriveIds.length > 0;
}

export async function getPrincipalAccessLevel(
  auth: AuthResult,
  pageId: string,
): Promise<PermissionLevel | null> {
  if (isScopedMCPAuth(auth)) {
    return getAppAccessLevel(auth.tokenId, pageId);
  }
  return getUserAccessLevel(auth.userId, pageId);
}

export async function canPrincipalViewPage(auth: AuthResult, pageId: string): Promise<boolean> {
  if (isScopedMCPAuth(auth)) {
    const level = await getAppAccessLevel(auth.tokenId, pageId);
    return level?.canView ?? false;
  }
  return canUserViewPage(auth.userId, pageId);
}

export async function canPrincipalEditPage(auth: AuthResult, pageId: string): Promise<boolean> {
  if (isScopedMCPAuth(auth)) {
    const level = await getAppAccessLevel(auth.tokenId, pageId);
    return level?.canEdit ?? false;
  }
  return canUserEditPage(auth.userId, pageId);
}

export async function canPrincipalDeletePage(auth: AuthResult, pageId: string): Promise<boolean> {
  if (isScopedMCPAuth(auth)) {
    const level = await getAppAccessLevel(auth.tokenId, pageId);
    return level?.canDelete ?? false;
  }
  return canUserDeletePage(auth.userId, pageId);
}

export async function canPrincipalSharePage(auth: AuthResult, pageId: string): Promise<boolean> {
  if (isScopedMCPAuth(auth)) {
    const level = await getAppAccessLevel(auth.tokenId, pageId);
    return level?.canShare ?? false;
  }
  return canUserSharePage(auth.userId, pageId);
}

export async function isPrincipalDriveMember(auth: AuthResult, driveId: string): Promise<boolean> {
  if (isScopedMCPAuth(auth)) {
    return hasAppDriveMembership(auth.tokenId, driveId);
  }
  return isUserDriveMember(auth.userId, driveId);
}

export async function getPrincipalDriveAccess(auth: AuthResult, driveId: string): Promise<boolean> {
  if (isScopedMCPAuth(auth)) {
    return hasAppDriveMembership(auth.tokenId, driveId);
  }
  return getUserDriveAccess(auth.userId, driveId);
}

export async function isPrincipalDriveOwnerOrAdmin(auth: AuthResult, driveId: string): Promise<boolean> {
  if (isScopedMCPAuth(auth)) {
    const membership = await getAppDriveMembership(auth.tokenId, driveId);
    return membership?.role === 'OWNER' || membership?.role === 'ADMIN';
  }
  return isDriveOwnerOrAdmin(auth.userId, driveId);
}

/**
 * Drive-level VIEW for resources with no per-page granularity (calendar events,
 * member listings). Scoped tokens use their role's drive-level access — a plain
 * MEMBER keeps view, a custom role needs a drive-wide view grant. Users keep
 * the membership rule. Routes whose responses are already filtered per page
 * (tasks, search, tree) should keep isPrincipalDriveMember + per-page filters
 * instead, so per-page custom-role grants still work.
 */
export async function canPrincipalViewDrive(auth: AuthResult, driveId: string): Promise<boolean> {
  if (isScopedMCPAuth(auth)) {
    const level = await getAppDriveAccessLevel(auth.tokenId, driveId);
    return level?.canView ?? false;
  }
  return isUserDriveMember(auth.userId, driveId);
}

/**
 * Drive-level EDIT (creating drive-scoped resources such as calendar events).
 * Scoped tokens need their role's drive-level canEdit — MEMBER (view-only) and
 * custom roles without a drive-wide edit grant are denied. Users keep the
 * existing membership rule (any accepted member may create).
 */
export async function canPrincipalEditDrive(auth: AuthResult, driveId: string): Promise<boolean> {
  if (isScopedMCPAuth(auth)) {
    const level = await getAppDriveAccessLevel(auth.tokenId, driveId);
    return level?.canEdit ?? false;
  }
  return isUserDriveMember(auth.userId, driveId);
}

/**
 * The principal's drive universe: a scoped token's mcp_token_drives memberships
 * (NOT intersected with the owning user's drives), otherwise the user's drives.
 */
export async function getPrincipalDriveIds(auth: AuthResult): Promise<string[]> {
  if (isScopedMCPAuth(auth)) {
    return auth.allowedDriveIds;
  }
  return getDriveIdsForUser(auth.userId);
}

/**
 * Like getPrincipalDriveIds, but for aggregate reads with no per-item page
 * filtering: drops drives where a scoped token's role grants no drive-level
 * view (custom role without a drive-wide view grant).
 */
export async function getPrincipalViewableDriveIds(auth: AuthResult): Promise<string[]> {
  if (!isScopedMCPAuth(auth)) {
    return getDriveIdsForUser(auth.userId);
  }
  const results = await Promise.all(
    auth.allowedDriveIds.map(async (driveId) => {
      const level = await getAppDriveAccessLevel(auth.tokenId, driveId);
      return level?.canView ? driveId : null;
    }),
  );
  return results.filter((id): id is string => id !== null);
}

export async function getPrincipalAccessiblePagesInDrive(
  auth: AuthResult,
  driveId: string,
): Promise<PageWithPermissions[]> {
  if (isScopedMCPAuth(auth)) {
    return getAppAccessiblePagesInDrive(auth.tokenId, driveId);
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
  if (!isScopedMCPAuth(auth)) {
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
    const accessible = await getAppAccessiblePagesInDrive(auth.tokenId, driveId);
    for (const page of accessible) {
      if (requested.has(page.id)) {
        results.set(page.id, { ...page.permissions });
      }
    }
  }
  return results;
}
