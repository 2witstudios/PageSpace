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
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
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
import { getAllowedDriveIds, isMCPAuthResult, isOAuthAuthResult, isManageKeysOnly, type AuthResult, type MCPAuthResult, type OAuthAuthResult } from './index';

/**
 * A scoped MCP token acts as an app member (its allowedDriveIds are exactly its
 * mcp_token_drives memberships). Unscoped tokens and sessions act as the user.
 */
export function isScopedMCPAuth(auth: AuthResult): auth is MCPAuthResult {
  return isMCPAuthResult(auth) && auth.allowedDriveIds.length > 0;
}

/**
 * Whether the credential is confined to a set of drives AT ALL, whatever its
 * shape — for the callers that only need the yes/no.
 *
 * `isScopedMCPAuth` cannot answer this: it is a TYPE GUARD that narrows to
 * `MCPAuthResult` because most of its ~30 callers go on to read MCP-specific
 * fields. A dispatched worker runs under service auth carrying an inherited
 * ceiling, which is drive-scoped in every sense that matters to a tool-set
 * filter but is not an MCP result and must not be narrowed to one.
 *
 * Reads through `getAllowedDriveIds`, so it stays correct for every credential
 * shape by construction — including the manage-keys sentinel, which is scoped to
 * a drive set of exactly nothing.
 */
export function isDriveScopedPrincipal(auth: AuthResult): boolean {
  return getAllowedDriveIds(auth).length > 0;
}

/**
 * A drive-scoped OAuth access token (any scope short of `account`) acts as an
 * app member, exactly like a scoped MCP token — an account-scoped OAuth token
 * is a full-user credential and acts as the user instead.
 */
export function isScopedOAuthAuth(auth: AuthResult): auth is OAuthAuthResult {
  return isOAuthAuthResult(auth) && !auth.scopes.account;
}

/**
 * Collapse a dispatched worker's SERVICE credential back onto the credential the
 * chain actually started from.
 *
 * A worker turn arrives as `ServiceAuthResult`. That is a fourth `AuthResult`
 * variant, and every branch in this file was written against the first three —
 * so without this, a service turn fell through every `isScopedMCPAuth` check to
 * the plain-user path and executed with the OWNING USER's full permissions,
 * discarding the ceiling the signed dispatch went to the trouble of carrying
 * (PR review, three independent P1 findings). A VIEWER-scoped token could clear
 * the page-chat edit gate through its owner's broader access.
 *
 * The fix is normalization rather than thirteen extra branches, deliberately:
 * the failure mode was a NEW VARIANT SILENTLY FALLING THROUGH, and thirteen
 * branches would leave the fourteenth to be forgotten the same way. Rewriting
 * the principal at the door means every check here — and every check added
 * later — sees a credential shape it already knows how to refuse.
 *
 * It is a re-labelling, not an escalation: a dispatch under an MCP token IS that
 * token acting, so it gets exactly that token's `tokenId` and `allowedDriveIds`
 * and therefore exactly its `mcp_token_drives` role. A chain that started from a
 * session or an UNSCOPED token has no `originatingMcpTokenId`, stays a service
 * result, and correctly resolves as the user (an unscoped token is its owner).
 */
function resolveDispatchedPrincipal(auth: AuthResult): AuthResult {
  // The DISCRIMINANT directly, not the `isServiceAuthResult` guard from
  // `./index`. `auth` is already a success result here, so the tag is all the
  // narrowing needed — and this module is partially mocked by several route
  // suites that delegate to the real dispatch, so every symbol imported from
  // `./index` is one more thing those mocks must remember to provide or fail
  // with an opaque 500 (caught by `mcp/documents/route.security.test.ts`).
  if (auth.tokenType !== 'service' || !auth.originatingMcpTokenId) return auth;
  return {
    tokenType: 'mcp',
    tokenId: auth.originatingMcpTokenId,
    allowedDriveIds: auth.allowedDriveIds,
    userId: auth.userId,
    role: auth.role,
    tokenVersion: auth.tokenVersion,
    adminRoleVersion: auth.adminRoleVersion,
  };
}

export async function getPrincipalAccessLevel(
  auth: AuthResult,
  pageId: string,
): Promise<PermissionLevel | null> {
  auth = resolveDispatchedPrincipal(auth);
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
  auth = resolveDispatchedPrincipal(auth);
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
  auth = resolveDispatchedPrincipal(auth);
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
  auth = resolveDispatchedPrincipal(auth);
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
  auth = resolveDispatchedPrincipal(auth);
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
  auth = resolveDispatchedPrincipal(auth);
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
  auth = resolveDispatchedPrincipal(auth);
  if (isManageKeysOnly(auth)) return false;
  if (isScopedMCPAuth(auth)) {
    return hasAppDriveMembership(auth.tokenId, driveId);
  }
  if (isScopedOAuthAuth(auth)) {
    return hasScopedDriveMembership(auth.driveScopes, auth.userId, driveId);
  }
  return getUserDriveAccess(auth.userId, driveId);
}

export async function isPrincipalDriveOwnerOrAdmin(auth: AuthResult, driveId: string): Promise<boolean> {
  auth = resolveDispatchedPrincipal(auth);
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
 * Whether the principal may manage (create/update/delete) incoming webhooks
 * on a page. Deliberately stricter than canPrincipalEditPage: a page may be
 * edit-by-default for any drive member (e.g. posting a channel message), but
 * minting an unattended write path into a page is reserved for the drive's
 * owner/admin. Scoped MCP/OAuth tokens are rejected outright in v1 — this is
 * a human console action, not something a scoped agent token should do
 * unsupervised.
 */
export async function canManagePageWebhooks(auth: AuthResult, pageId: string): Promise<boolean> {
  auth = resolveDispatchedPrincipal(auth);
  if (isManageKeysOnly(auth)) return false;
  if (isScopedMCPAuth(auth) || isScopedOAuthAuth(auth)) return false;

  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { driveId: true },
  });
  if (!page?.driveId) return false;

  return isDriveOwnerOrAdmin(auth.userId, page.driveId);
}

/**
 * The principal's drive universe: a scoped token's mcp_token_drives memberships
 * (NOT intersected with the owning user's drives), otherwise the user's drives.
 */
export async function getPrincipalDriveIds(auth: AuthResult): Promise<string[]> {
  auth = resolveDispatchedPrincipal(auth);
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
  auth = resolveDispatchedPrincipal(auth);
  if (isManageKeysOnly(auth)) return [];
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
  auth = resolveDispatchedPrincipal(auth);
  const deny: PermissionLevel = { canView: false, canEdit: false, canShare: false, canDelete: false };

  if (isManageKeysOnly(auth)) {
    const results = new Map<string, PermissionLevel>();
    for (const pageId of pageIds) {
      results.set(pageId, { ...deny });
    }
    return results;
  }

  if (!isScopedMCPAuth(auth) && !isScopedOAuthAuth(auth)) {
    return getBatchPagePermissions(auth.userId, pageIds);
  }

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
