import { NextResponse } from 'next/server';
import { db, mcpTokens, pages, eq, and, isNull } from '@pagespace/db';
import { hashToken, sessionService, type SessionClaims } from '@pagespace/lib/auth';
import { EnforcedAuthContext } from '@pagespace/lib/server';
import { getSessionFromCookies } from './cookie-config';

const BEARER_PREFIX = 'Bearer ';
const MCP_TOKEN_PREFIX = 'mcp_';
const SESSION_TOKEN_PREFIX = 'ps_sess_';

export type TokenType = 'mcp' | 'session';

interface BaseAuthDetails {
  userId: string;
  role: 'user' | 'admin';
  tokenVersion: number;
  adminRoleVersion: number;
}

interface MCPAuthDetails extends BaseAuthDetails {
  tokenId: string;
  // Drive IDs this token is scoped to. Empty array means access to ALL drives.
  allowedDriveIds: string[];
}

export interface MCPAuthResult extends MCPAuthDetails {
  tokenType: 'mcp';
}

export interface SessionAuthResult extends BaseAuthDetails {
  tokenType: 'session';
  sessionId: string;
}

export type AuthResult = MCPAuthResult | SessionAuthResult;

export interface AuthError {
  error: NextResponse;
}

export type AuthenticationResult = AuthResult | AuthError;

export type AllowedTokenType = TokenType;

export interface AuthenticateOptions {
  allow: ReadonlyArray<AllowedTokenType>;
  requireCSRF?: boolean;
  requireOriginValidation?: boolean;
}

function unauthorized(message: string, status = 401): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function getBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    return null;
  }
  return authHeader.slice(BEARER_PREFIX.length);
}

export async function validateMCPToken(token: string): Promise<MCPAuthDetails | null> {
  try {
    if (!token || !token.startsWith(MCP_TOKEN_PREFIX)) {
      return null;
    }

    const tokenHash = hashToken(token);

    const tokenRecord = await db.query.mcpTokens.findFirst({
      where: and(eq(mcpTokens.tokenHash, tokenHash), isNull(mcpTokens.revokedAt)),
      columns: {
        id: true,
        userId: true,
        isScoped: true,
      },
      with: {
        user: {
          columns: {
            id: true,
            role: true,
            tokenVersion: true,
            adminRoleVersion: true,
          },
        },
        driveScopes: {
          columns: {
            driveId: true,
          },
        },
      },
    });

    const user = tokenRecord?.user;
    if (!tokenRecord || !user) {
      return null;
    }

    // Extract allowed drive IDs from the scopes
    const allowedDriveIds = tokenRecord.driveScopes.map(scope => scope.driveId);

    // Fail-closed security: if token was originally scoped but all drives have been deleted,
    // deny access entirely (prevents privilege escalation from scoped -> unrestricted)
    if (tokenRecord.isScoped && allowedDriveIds.length === 0) {
      console.warn('MCP token denied - scoped token with no remaining drives', {
        tokenId: tokenRecord.id,
        userId: tokenRecord.userId,
      });
      return null;
    }

    await db
      .update(mcpTokens)
      .set({ lastUsed: new Date() })
      .where(eq(mcpTokens.id, tokenRecord.id));

    return {
      userId: tokenRecord.userId,
      role: user.role as 'user' | 'admin',
      tokenVersion: user.tokenVersion,
      adminRoleVersion: user.adminRoleVersion,
      tokenId: tokenRecord.id,
      allowedDriveIds,
    };
  } catch (error) {
    console.error('validateMCPToken error', error);
    return null;
  }
}

export async function validateSessionToken(token: string): Promise<SessionClaims | null> {
  try {
    if (!token) {
      return null;
    }
    return await sessionService.validateSession(token);
  } catch (error) {
    console.error('validateSessionToken error', error);
    return null;
  }
}

export async function authenticateMCPRequest(request: Request): Promise<AuthenticationResult> {
  const token = getBearerToken(request);

  if (!token || !token.startsWith(MCP_TOKEN_PREFIX)) {
    return {
      error: unauthorized('MCP token required'),
    };
  }

  const mcpDetails = await validateMCPToken(token);
  if (!mcpDetails) {
    return {
      error: unauthorized('Invalid MCP token'),
    };
  }

  return {
    ...mcpDetails,
    tokenType: 'mcp',
  } satisfies MCPAuthResult;
}

export async function authenticateSessionRequest(request: Request): Promise<AuthenticationResult> {
  // Check for bearer token first (desktop/mobile clients)
  const bearerToken = getBearerToken(request);

  if (bearerToken) {
    // Reject MCP tokens - wrong endpoint
    if (bearerToken.startsWith(MCP_TOKEN_PREFIX)) {
      return {
        error: unauthorized('MCP tokens are not permitted for this endpoint'),
      };
    }

    // Session token sent as Bearer (mobile/desktop)
    if (bearerToken.startsWith(SESSION_TOKEN_PREFIX)) {
      const sessionResult = await validateSessionToken(bearerToken);
      if (sessionResult) {
        return {
          userId: sessionResult.userId,
          role: sessionResult.userRole,
          tokenVersion: sessionResult.tokenVersion,
          adminRoleVersion: sessionResult.adminRoleVersion,
          sessionId: sessionResult.sessionId,
          tokenType: 'session',
        } satisfies SessionAuthResult;
      }
      return { error: unauthorized('Invalid or expired session') };
    }

    // Unknown Bearer token format
    return { error: unauthorized('Invalid token format') };
  }

  // No bearer token - try session cookie (web browsers)
  const cookieHeader = request.headers.get('cookie');
  const sessionToken = getSessionFromCookies(cookieHeader);

  if (!sessionToken) {
    return {
      error: unauthorized('Authentication required'),
    };
  }

  const sessionClaims = await validateSessionToken(sessionToken);
  if (!sessionClaims) {
    return {
      error: unauthorized('Invalid or expired session'),
    };
  }

  return {
    userId: sessionClaims.userId,
    role: sessionClaims.userRole,
    tokenVersion: sessionClaims.tokenVersion,
    adminRoleVersion: sessionClaims.adminRoleVersion,
    sessionId: sessionClaims.sessionId,
    tokenType: 'session',
  } satisfies SessionAuthResult;
}

export async function authenticateHybridRequest(request: Request): Promise<AuthenticationResult> {
  return authenticateRequestWithOptions(request, { allow: ['mcp', 'session'] });
}

export function isAuthError(result: AuthenticationResult): result is AuthError {
  return 'error' in result;
}

export function isMCPAuthResult(result: AuthenticationResult): result is MCPAuthResult {
  return !('error' in result) && result.tokenType === 'mcp';
}

export function isSessionAuthResult(result: AuthenticationResult): result is SessionAuthResult {
  return !('error' in result) && result.tokenType === 'session';
}

/**
 * Check if the auth result allows access to a specific drive.
 * For session auth, always returns true (no scope restrictions).
 * For MCP auth, checks if driveId is in allowedDriveIds (empty array = no restrictions).
 */
export function checkMCPDriveScope(auth: AuthResult, driveId: string): boolean {
  if (auth.tokenType === 'session') {
    return true; // Session auth has no drive scope restrictions
  }
  // MCP auth - check if drive is in allowed list (empty = all allowed)
  if (auth.allowedDriveIds.length === 0) {
    return true;
  }
  return auth.allowedDriveIds.includes(driveId);
}

/**
 * Get the page's driveId and check if the auth result allows access to it.
 * Returns null if page not found, true if access allowed, false if denied.
 */
export async function checkMCPPageScope(auth: AuthResult, pageId: string): Promise<boolean | null> {
  if (auth.tokenType === 'session') {
    return true; // Session auth has no drive scope restrictions
  }
  // MCP auth with no scope restrictions
  if (auth.allowedDriveIds.length === 0) {
    return true;
  }
  // Need to look up page's driveId
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { driveId: true },
  });
  if (!page) {
    return null;
  }
  return auth.allowedDriveIds.includes(page.driveId);
}

export async function authenticateRequestWithOptions(
  request: Request,
  options: AuthenticateOptions,
): Promise<AuthenticationResult> {
  const { allow, requireCSRF = false } = options;
  const requireOriginValidation = options.requireOriginValidation ?? requireCSRF;

  if (!allow.length) {
    return {
      error: unauthorized('No authentication methods permitted for this endpoint', 500),
    };
  }

  const allowedTypes = new Set(allow);
  const allowMCP = allowedTypes.has('mcp');
  const allowSession = allowedTypes.has('session');

  const bearerToken = getBearerToken(request);

  if (bearerToken?.startsWith(MCP_TOKEN_PREFIX)) {
    if (!allowMCP) {
      return {
        error: unauthorized('MCP tokens are not permitted for this endpoint'),
      };
    }
    return authenticateMCPRequest(request);
  }

  let authResult: AuthenticationResult;

  if (allowSession) {
    authResult = await authenticateSessionRequest(request);
  } else if (allowMCP) {
    authResult = await authenticateMCPRequest(request);
  } else {
    return {
      error: unauthorized('No authentication methods permitted for this endpoint', 500),
    };
  }

  if (isAuthError(authResult)) {
    return authResult;
  }

  // Apply origin and CSRF validation for session-based authentication
  const isSessionAuth = authResult.tokenType === 'session';

  if (requireOriginValidation && isSessionAuth) {
    const { validateOrigin } = await import('./origin-validation');
    const originError = validateOrigin(request);
    if (originError) {
      return { error: originError };
    }
  }

  if (requireCSRF && isSessionAuth) {
    // Skip CSRF for Bearer token auth - not vulnerable to CSRF attacks.
    // CSRF attacks exploit that browsers automatically send cookies with requests.
    // Bearer tokens must be explicitly set in JavaScript headers, so they can't
    // be exploited by malicious sites tricking users into making requests.
    const hasBearerAuth = !!getBearerToken(request);
    if (!hasBearerAuth) {
      const { validateCSRF } = await import('./csrf-validation');
      const csrfError = await validateCSRF(request);
      if (csrfError) {
        return { error: csrfError };
      }
    }
  }

  return authResult;
}

/**
 * Authenticate a request and return an EnforcedAuthContext.
 * This is the preferred method for zero-trust permission operations.
 */
export interface EnforcedAuthSuccess {
  ctx: EnforcedAuthContext;
}

export interface EnforcedAuthError {
  error: NextResponse;
}

export type EnforcedAuthResult = EnforcedAuthSuccess | EnforcedAuthError;

export function isEnforcedAuthError(result: EnforcedAuthResult): result is EnforcedAuthError {
  return 'error' in result;
}

export async function authenticateWithEnforcedContext(
  request: Request,
  options: AuthenticateOptions = { allow: ['session'], requireCSRF: true }
): Promise<EnforcedAuthResult> {
  // Note: 'allow' is not used - EnforcedAuthContext only supports session tokens
  // MCP tokens lack the full session claims needed for EnforcedAuthContext
  const { requireCSRF = true } = options;
  const requireOriginValidation = options.requireOriginValidation ?? requireCSRF;

  // Get bearer token or session cookie
  const bearerToken = getBearerToken(request);

  // Reject MCP tokens - EnforcedAuthContext requires full session claims
  if (bearerToken?.startsWith(MCP_TOKEN_PREFIX)) {
    return {
      error: unauthorized('MCP tokens are not permitted for this endpoint'),
    };
  }

  // Try bearer token first (mobile/desktop)
  if (bearerToken?.startsWith(SESSION_TOKEN_PREFIX)) {
    const sessionClaims = await validateSessionToken(bearerToken);
    if (!sessionClaims) {
      return { error: unauthorized('Invalid or expired session') };
    }
    return { ctx: EnforcedAuthContext.fromSession(sessionClaims) };
  }

  // Try session cookie (web browsers)
  const cookieHeader = request.headers.get('cookie');
  const sessionToken = getSessionFromCookies(cookieHeader);

  if (!sessionToken) {
    return { error: unauthorized('Authentication required') };
  }

  const sessionClaims = await validateSessionToken(sessionToken);
  if (!sessionClaims) {
    return { error: unauthorized('Invalid or expired session') };
  }

  // Apply origin validation for session-based auth
  if (requireOriginValidation) {
    const { validateOrigin } = await import('./origin-validation');
    const originError = validateOrigin(request);
    if (originError) {
      return { error: originError };
    }
  }

  // Apply CSRF validation for session-based auth (skip for Bearer token)
  if (requireCSRF && !bearerToken) {
    const { validateCSRF } = await import('./csrf-validation');
    const csrfError = await validateCSRF(request);
    if (csrfError) {
      return { error: csrfError };
    }
  }

  return { ctx: EnforcedAuthContext.fromSession(sessionClaims) };
}

// ============================================================================
// MCP Drive Scope Enforcement Helpers
// ============================================================================
// These helpers enforce drive-level access restrictions for scoped MCP tokens.
// Policy: If allowedDriveIds is empty, the token has full access to all user's drives.
//         If allowedDriveIds is non-empty, only those specific drives are accessible.
// ============================================================================

/**
 * Get allowed drive IDs from an authentication result.
 * Returns empty array for session auth (full access) or unscoped MCP tokens.
 */
export function getAllowedDriveIds(auth: AuthResult): string[] {
  if (isMCPAuthResult(auth)) {
    return auth.allowedDriveIds;
  }
  return []; // Session auth = full access
}

/**
 * Check if an MCP token has access to a specific drive.
 * Returns null if access is allowed, or a 403 response if denied.
 *
 * @param auth - The authentication result
 * @param driveId - The drive ID to check access for
 * @returns null if allowed, NextResponse with 403 if denied
 */
export function checkMCPDriveScope(
  auth: AuthResult,
  driveId: string
): NextResponse | null {
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
  return NextResponse.json(
    { error: 'This token does not have access to this drive' },
    { status: 403 }
  );
}

/**
 * Check if an MCP token has access to a page by looking up its drive.
 * Returns null if access is allowed, or a 403/404 response if denied/not found.
 *
 * @param auth - The authentication result
 * @param pageId - The page ID to check access for
 * @returns null if allowed, NextResponse with 403/404 if denied/not found
 */
export async function checkMCPPageScope(
  auth: AuthResult,
  pageId: string
): Promise<NextResponse | null> {
  const allowedDriveIds = getAllowedDriveIds(auth);

  // Empty allowedDriveIds means full access
  if (allowedDriveIds.length === 0) {
    return null;
  }

  // Need to look up the page's drive
  const { pages, eq } = await import('@pagespace/db');
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { driveId: true },
  });

  if (!page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  if (!allowedDriveIds.includes(page.driveId)) {
    return NextResponse.json(
      { error: 'This token does not have access to this drive' },
      { status: 403 }
    );
  }

  return null;
}

/**
 * Filter a list of drive IDs by MCP token scope.
 * Returns all drives for session auth or unscoped tokens.
 *
 * @param auth - The authentication result
 * @param driveIds - List of drive IDs to filter
 * @returns Filtered list of drive IDs that are within scope
 */
export function filterDrivesByMCPScope(
  auth: AuthResult,
  driveIds: string[]
): string[] {
  const allowedDriveIds = getAllowedDriveIds(auth);

  // Empty allowedDriveIds means full access
  if (allowedDriveIds.length === 0) {
    return driveIds;
  }

  // Filter to only allowed drives
  const allowedSet = new Set(allowedDriveIds);
  return driveIds.filter(id => allowedSet.has(id));
}

/**
 * Check if a scoped MCP token is trying to create resources outside its scope.
 * Scoped tokens should not be able to create new drives or resources in unscoped drives.
 * Returns null if the operation is allowed, or a 403 response if denied.
 *
 * @param auth - The authentication result
 * @param targetDriveId - Optional drive ID where resource will be created (null for drive creation)
 * @returns null if allowed, NextResponse with 403 if denied
 */
export function checkMCPCreateScope(
  auth: AuthResult,
  targetDriveId: string | null
): NextResponse | null {
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
    return NextResponse.json(
      { error: 'This token does not have access to this drive' },
      { status: 403 }
    );
  }

  return null;
}

// Re-export from other auth modules
export { verifyAuth, verifyAdminAuth, type VerifiedUser } from './auth';
export { validateCSRF } from './csrf-validation';
export {
  validateOrigin,
  requiresOriginValidation,
  validateOriginForMiddleware,
  isOriginValidationBlocking,
  type OriginValidationMode,
  type MiddlewareOriginValidationResult,
} from './origin-validation';
export { getClientIP, isSafeReturnUrl } from './auth-helpers';
export { validateLoginCSRFToken } from './login-csrf-utils';
export {
  COOKIE_CONFIG,
  createSessionCookie,
  createClearSessionCookie,
  appendSessionCookie,
  appendClearCookies,
  getSessionFromCookies,
} from './cookie-config';
