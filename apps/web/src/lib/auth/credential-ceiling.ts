/**
 * The ONE place that branches on a credential's kind to resolve its ceiling.
 *
 * `CredentialCeiling` (@pagespace/lib/permissions/credential-ceiling) names a
 * drive-scoped credential in a principal-neutral shape; these resolvers answer
 * every ceiling question for it by delegating to the resolver family that owns
 * that kind — `getApp*` for an `mcp_` key's `mcp_token_drives` rows,
 * `getScoped*` for an OAuth grant's consented rows. The request principal
 * (principal-permissions.ts) and the agent-tool layer (actor-permissions.ts)
 * both consume these, so the two can never disagree about a kind, and a new
 * kind is one branch here rather than one per call site.
 *
 * Lives in the web app, not in @pagespace/lib, because route and tool suites
 * mock `@pagespace/lib/permissions/app-permissions` by specifier — a dispatch
 * inside lib dist would import it relatively and never see those mocks.
 */
import {
  getAppAccessLevel,
  getAppDriveAccessLevel,
  getAppDriveMembership,
  getAppAccessiblePagesInDrive,
  hasAppDriveMembership,
  getScopedAccessLevel,
  getScopedDriveAccessLevel,
  getScopedDriveMembership,
  getScopedAccessiblePagesInDrive,
  hasScopedDriveMembership,
} from '@pagespace/lib/permissions/app-permissions';
import type { PermissionLevel, PageWithPermissions } from '@pagespace/lib/permissions/permissions';
import type { CredentialCeiling } from '@pagespace/lib/permissions/credential-ceiling';
import type { AuthResult } from './index';

export type { CredentialCeiling } from '@pagespace/lib/permissions/credential-ceiling';

/**
 * The credential ceiling a principal acts under, or `undefined` when it acts as
 * its user (a session, an unscoped `mcp_` key, an `account` OAuth grant, or a
 * dispatched worker whose chain started at one of those).
 *
 * This is the normalization every ceiling consumer reads — the request
 * principal's helpers (principal-permissions.ts) and `toolCredentialScope`,
 * which carries the same value onto an agent turn's `ToolExecutionContext` — so
 * a drive-scoped `mcp_` key and a drive-scoped OAuth grant are capped by one
 * code path, never by per-kind branches at each call site. A profile-only OAuth
 * principal carries a ceiling with NO drive rows, which grants nothing.
 *
 * Reads DISCRIMINANTS only, never guards imported from `./index`: route suites
 * mock `@/lib/auth` wholesale, and a helper that needed that mock to provide
 * `isScopedMCPAuth` would 500 every one of them. The predicates are the same
 * ones `isScopedMCPAuth` / `isScopedOAuthAuth` state.
 */
export function getCredentialCeiling(auth: AuthResult): CredentialCeiling | undefined {
  switch (auth.tokenType) {
    case 'mcp':
      return auth.allowedDriveIds.length > 0 ? { kind: 'mcp', tokenId: auth.tokenId } : undefined;
    case 'oauth':
      return auth.scopes.account ? undefined : { kind: 'oauth', driveScopes: auth.driveScopes };
    case 'service':
      return auth.originatingMcpTokenId ? { kind: 'mcp', tokenId: auth.originatingMcpTokenId } : undefined;
    case 'session':
      return undefined;
  }
}

export interface CeilingDriveMembership {
  /** NULL = inherit: the credential acts as its user in this drive. */
  readonly role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
  readonly customRoleId: string | null;
}

export async function getCeilingAccessLevel(
  ceiling: CredentialCeiling,
  userId: string,
  pageId: string,
): Promise<PermissionLevel | null> {
  return ceiling.kind === 'mcp'
    ? getAppAccessLevel(ceiling.tokenId, pageId)
    : getScopedAccessLevel(ceiling.driveScopes, userId, pageId);
}

export async function getCeilingDriveAccessLevel(
  ceiling: CredentialCeiling,
  userId: string,
  driveId: string,
): Promise<PermissionLevel | null> {
  return ceiling.kind === 'mcp'
    ? getAppDriveAccessLevel(ceiling.tokenId, driveId)
    : getScopedDriveAccessLevel(ceiling.driveScopes, userId, driveId);
}

export async function getCeilingDriveMembership(
  ceiling: CredentialCeiling,
  userId: string,
  driveId: string,
): Promise<CeilingDriveMembership | null> {
  const membership = ceiling.kind === 'mcp'
    ? await getAppDriveMembership(ceiling.tokenId, driveId)
    : await getScopedDriveMembership(ceiling.driveScopes, userId, driveId);
  return membership && { role: membership.role, customRoleId: membership.customRoleId ?? null };
}

export async function hasCeilingDriveMembership(
  ceiling: CredentialCeiling,
  userId: string,
  driveId: string,
): Promise<boolean> {
  return ceiling.kind === 'mcp'
    ? hasAppDriveMembership(ceiling.tokenId, driveId)
    : hasScopedDriveMembership(ceiling.driveScopes, userId, driveId);
}

export async function getCeilingAccessiblePagesInDrive(
  ceiling: CredentialCeiling,
  userId: string,
  driveId: string,
): Promise<PageWithPermissions[]> {
  return ceiling.kind === 'mcp'
    ? getAppAccessiblePagesInDrive(ceiling.tokenId, driveId)
    : getScopedAccessiblePagesInDrive(ceiling.driveScopes, userId, driveId);
}
