/**
 * Auth engine functional core — pure, I/O-free decision logic.
 *
 * Every function here is deterministic: no database, no network, no clock. The
 * only runtime imports are `next/server` (for building `NextResponse` values,
 * which have no side effects) and the dependency-free scope parser
 * (`@pagespace/lib/auth/oauth/scopes`). This keeps the module cheap to import
 * from client/edge code and makes each branch unit-testable in isolation.
 *
 * The imperative shell (`./request-auth`) reads the database, calls the
 * `decide*` functions below, then performs any writes the decision implies.
 */
import { NextResponse } from 'next/server';
import { parseScopeList, scopeSetToDriveScopes } from '@pagespace/lib/auth/oauth/scopes';
import type { SessionClaims } from '@pagespace/lib/auth/session-service';
import type { OAuthAccessTokenRecord } from '@pagespace/lib/auth/token-lookup';
import type {
  AuthResult,
  AuthError,
  AuthenticationResult,
  MCPAuthResult,
  MCPAuthDetails,
  OAuthAuthDetails,
  SessionAuthResult,
  OAuthAuthResult,
  EnforcedAuthResult,
  EnforcedAuthError,
} from './auth-types';

const BEARER_PREFIX = 'Bearer ';

// ─── Response builders (pure — NextResponse construction is side-effect free) ──

export function unauthorized(message: string, status = 401): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function manageKeysOnlyDeniedResponse(): NextResponse {
  return NextResponse.json(
    { error: 'This credential is management-only and has no drive content access' },
    { status: 403 }
  );
}

function driveAccessDeniedResponse(): NextResponse {
  return NextResponse.json(
    { error: 'This token does not have access to this drive' },
    { status: 403 }
  );
}

// ─── Header parsing ───────────────────────────────────────────────────────────

export function getBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    return null;
  }
  return authHeader.slice(BEARER_PREFIX.length);
}

// ─── Type guards ───────────────────────────────────────────────────────────────

export function isAuthError(result: AuthenticationResult): result is AuthError {
  return 'error' in result;
}

export function isMCPAuthResult(result: AuthenticationResult): result is MCPAuthResult {
  return !('error' in result) && result.tokenType === 'mcp';
}

export function isSessionAuthResult(result: AuthenticationResult): result is SessionAuthResult {
  return !('error' in result) && result.tokenType === 'session';
}

export function isOAuthAuthResult(result: AuthenticationResult): result is OAuthAuthResult {
  return !('error' in result) && result.tokenType === 'oauth';
}

export function isEnforcedAuthError(result: EnforcedAuthResult): result is EnforcedAuthError {
  return 'error' in result;
}

// ─── Pure result mappers ────────────────────────────────────────────────────────

/**
 * Map validated session claims onto a SessionAuthResult. Pure — the shell owns
 * the (impure) `sessionService.validateSession` call that produces the claims.
 */
export function sessionClaimsToResult(claims: SessionClaims): SessionAuthResult {
  return {
    userId: claims.userId,
    role: claims.userRole,
    tokenVersion: claims.tokenVersion,
    adminRoleVersion: claims.adminRoleVersion,
    sessionId: claims.sessionId,
    tokenType: 'session',
  } satisfies SessionAuthResult;
}

// ─── Pure token-authentication decisions ────────────────────────────────────────
//
// The `decide*` functions classify a fetched token record into an action the
// shell must take. Side effects the decision implies (security logging, marking
// a token revoked, touching lastUsed) are performed by the shell, never here.

/** Minimal shape of the `mcp_tokens` row `validateMCPToken` fetches. */
export interface McpTokenAuthRecord {
  id: string;
  userId: string;
  isScoped: boolean;
  user: {
    role: string;
    tokenVersion: number;
    adminRoleVersion: number;
    suspendedAt: Date | null;
  } | null;
  driveScopes: { driveId: string }[];
}

export type McpAuthDecision =
  // Token/user not found — deny with no side effect.
  | { kind: 'not-found' }
  // Suspended user — shell logs a security event, revokes the token, then denies.
  | { kind: 'suspended' }
  // Fail-closed: token was scoped but all its drives are gone — shell warns, denies.
  | { kind: 'scoped-no-drives' }
  // Valid — shell touches lastUsed, then returns these details.
  | { kind: 'ok'; details: MCPAuthDetails };

export function decideMcpAuth(tokenRecord: McpTokenAuthRecord | null): McpAuthDecision {
  const user = tokenRecord?.user;
  if (!tokenRecord || !user) {
    return { kind: 'not-found' };
  }

  // Revoke previously issued MCP tokens when a suspended user attempts to
  // authenticate. This makes suspension enforcement sticky for future requests.
  if (user.suspendedAt) {
    return { kind: 'suspended' };
  }

  // Extract allowed drive IDs from the scopes
  const allowedDriveIds = tokenRecord.driveScopes.map((scope) => scope.driveId);

  // Fail-closed security: if token was originally scoped but all drives have been
  // deleted, deny access entirely (prevents privilege escalation from scoped ->
  // unrestricted).
  if (tokenRecord.isScoped && allowedDriveIds.length === 0) {
    return { kind: 'scoped-no-drives' };
  }

  return {
    kind: 'ok',
    details: {
      userId: tokenRecord.userId,
      role: user.role as 'user' | 'admin',
      tokenVersion: user.tokenVersion,
      adminRoleVersion: user.adminRoleVersion,
      tokenId: tokenRecord.id,
      allowedDriveIds,
    },
  };
}

export type OAuthAuthDecision =
  // Any fail-closed rejection that returns null with no write.
  | { kind: 'reject' }
  // Suspended user — shell logs, revokes with reason 'user_suspended', then denies.
  | { kind: 'suspended' }
  // Valid — shell returns these details.
  | { kind: 'ok'; details: OAuthAuthDetails };

/**
 * Classify an OAuth access-token record. `now` (epoch ms) is injected so this
 * stays deterministic — the shell passes `Date.now()`.
 */
export function decideOAuthAuth(
  record: OAuthAccessTokenRecord | null,
  now: number,
): OAuthAuthDecision {
  if (!record) {
    return { kind: 'reject' };
  }

  const user = record.user;

  // Revoke on sight, mirroring the mcp_token_user_suspended handling.
  if (user.suspendedAt) {
    return { kind: 'suspended' };
  }

  if (record.expiresAt.getTime() <= now) {
    return { kind: 'reject' };
  }

  // Stale token: the user's tokenVersion moved on (password change/global
  // logout) since this access token was minted — mirrors device-auth-utils.
  if (record.tokenVersion !== user.tokenVersion) {
    return { kind: 'reject' };
  }

  const parsed = parseScopeList(record.scopes.join(' '));
  if (!parsed.ok) {
    // Fail closed: corrupt/unparseable stored scope data must never resolve.
    return { kind: 'reject' };
  }

  // Fail closed at the mechanism level: `update_key:<id>`/`activate_key:<id>`
  // grants are one-shot consent ceremonies, never bearer scopes — the
  // authorization-code exchange intercepts them before any token family is
  // minted (`oauth-repository.ts`'s ok_mcp_update/ok_mcp_activate branches), so
  // no access token should ever carry either. If one somehow does (a future
  // issuance path persisting scopes verbatim, a reordered exchange branch),
  // honoring it would turn a consent ceremony into live access. Reject the token
  // outright rather than trusting every mint door to remember the interception.
  if (parsed.scopes.updateKeyId !== null || parsed.scopes.activateKeyId !== null) {
    return { kind: 'reject' };
  }

  // Same fail-closed reasoning, same shape of guard: `all_drives` only ever
  // resolves correctly as an unscoped (`isScoped: false`) `mcp_tokens` row
  // (`oauth-repository.ts`'s `isAllDrivesGrant` branch) — as a bearer OAuth
  // access token it would carry `allowedDriveIds: []` on a non-`account` token,
  // a shape this codebase's two authorization-helper families disagree on
  // (deny-everything via `isScopedOAuthAuth`/`getScopedAccessLevel`, or
  // grant-everything via `getAllowedDriveIds`/`checkMCPDriveScope`, depending on
  // which a given route calls). Today exactly two upstream gates keep
  // `all_drives` from ever reaching a persisted access token (the
  // authorization_code exchange's early intercept, and the device-authorization
  // endpoint's outright rejection) — reject here too rather than trust both to
  // remember it forever.
  if (parsed.scopes.allDrives) {
    return { kind: 'reject' };
  }

  const driveScopes = scopeSetToDriveScopes(parsed.scopes);
  const allowedDriveIds = parsed.scopes.account ? [] : driveScopes.map((scope) => scope.driveId);

  return {
    kind: 'ok',
    details: {
      userId: record.userId,
      role: user.role as 'user' | 'admin',
      tokenVersion: user.tokenVersion,
      adminRoleVersion: user.adminRoleVersion,
      tokenId: record.id,
      scopes: parsed.scopes,
      driveScopes,
      allowedDriveIds,
    },
  };
}

// ============================================================================
// MCP Drive Scope Enforcement Helpers (pure)
// ============================================================================
// These helpers enforce drive-level access restrictions for scoped MCP tokens.
// Policy: If allowedDriveIds is empty, the token has full access to all user's drives.
//         If allowedDriveIds is non-empty, only those specific drives are accessible.
// Exception: a manage-keys-only OAuth credential (auth.scopes.manageKeys) has no
//            content access at all, so it must never benefit from the "empty means
//            full access" convention below — every helper here fails it closed.
// ============================================================================

/**
 * True iff this credential can only manage keys and must never resolve to
 * content access. `parseScopeList` (see ScopeSet.manageKeys) mints this today
 * via the `manage_keys` token, through both the authorize and
 * device-authorization flows — every helper below exists because this is a
 * real, reachable credential shape, not a hypothetical one.
 */
export function isManageKeysOnly(auth: AuthResult): boolean {
  return isOAuthAuthResult(auth) && auth.scopes.manageKeys === true;
}

// Never equals a real drive id (cuid2 ids are lowercase alphanumeric only).
// Lets a manage-keys-only credential resolve through the same allowedDriveIds
// contract as every other scoped credential, so any caller that reads
// `allowedDriveIds.length` directly — not just the helpers below — also sees
// "no drives" rather than the empty-array-means-full-access default.
const manageKeysNoDriveAccess: readonly string[] = ['MANAGE_KEYS_ONLY_NO_DRIVE_ACCESS'];

/**
 * Get allowed drive IDs from an authentication result.
 * Returns empty array for session auth (full access) or unscoped MCP tokens.
 */
export function getAllowedDriveIds(auth: AuthResult): string[] {
  if (isManageKeysOnly(auth)) {
    return [...manageKeysNoDriveAccess];
  }
  if (isMCPAuthResult(auth)) {
    return auth.allowedDriveIds;
  }
  if (isOAuthAuthResult(auth)) {
    return auth.allowedDriveIds; // Empty for the `account` scope = full access
  }
  return []; // Session auth = full access
}

/**
 * Check if an MCP token has access to a specific drive.
 * Returns null if access is allowed, or a 403 response if denied.
 */
export function checkMCPDriveScope(
  auth: AuthResult,
  driveId: string
): NextResponse | null {
  if (isManageKeysOnly(auth)) {
    return manageKeysOnlyDeniedResponse();
  }

  const allowedDriveIds = getAllowedDriveIds(auth);

  // Empty allowedDriveIds means full access (unscoped token or session auth)
  if (allowedDriveIds.length === 0) {
    return null;
  }

  // Check if the drive is in the allowed list
  if (allowedDriveIds.includes(driveId)) {
    return null;
  }

  // Drive not in scope - return 403
  return driveAccessDeniedResponse();
}

/**
 * Filter a list of drive IDs by MCP token scope.
 * Returns all drives for session auth or unscoped tokens.
 */
export function filterDrivesByMCPScope(
  auth: AuthResult,
  driveIds: string[]
): string[] {
  if (isManageKeysOnly(auth)) {
    return [];
  }

  const allowedDriveIds = getAllowedDriveIds(auth);

  // Empty allowedDriveIds means full access
  if (allowedDriveIds.length === 0) {
    return driveIds;
  }

  // Filter to only allowed drives
  const allowedSet = new Set(allowedDriveIds);
  return driveIds.filter((id) => allowedSet.has(id));
}

/**
 * Check if a scoped MCP token is trying to create resources outside its scope.
 * Scoped tokens should not be able to create new drives or resources in unscoped drives.
 * Returns null if the operation is allowed, or a 403 response if denied.
 */
export function checkMCPCreateScope(
  auth: AuthResult,
  targetDriveId: string | null
): NextResponse | null {
  if (isManageKeysOnly(auth)) {
    return manageKeysOnlyDeniedResponse();
  }

  const allowedDriveIds = getAllowedDriveIds(auth);

  // Unscoped tokens can create anywhere
  if (allowedDriveIds.length === 0) {
    return null;
  }

  // Scoped tokens cannot create new drives
  if (targetDriveId === null) {
    return NextResponse.json(
      { error: 'Scoped tokens cannot create new drives' },
      { status: 403 }
    );
  }

  // Check if target drive is in scope
  if (!allowedDriveIds.includes(targetDriveId)) {
    return driveAccessDeniedResponse();
  }

  return null;
}
