import { NextResponse } from 'next/server';
import { db, mcpTokens, eq, and, isNull } from '@pagespace/db';
import { hashToken, sessionService, type SessionClaims } from '@pagespace/lib/auth';
import { getSessionFromCookies } from './cookie-config';

const BEARER_PREFIX = 'Bearer ';
const MCP_TOKEN_PREFIX = 'mcp_';
const SESSION_TOKEN_PREFIX = 'ps_sess_';

export type TokenType = 'mcp' | 'session';

interface BaseAuthDetails {
  userId: string;
  role: 'user' | 'admin';
  tokenVersion: number;
}

interface MCPAuthDetails extends BaseAuthDetails {
  tokenId: string;
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
      },
      with: {
        user: {
          columns: {
            id: true,
            role: true,
            tokenVersion: true,
          },
        },
      },
    });

    const user = tokenRecord?.user;
    if (!tokenRecord || !user) {
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
      tokenId: tokenRecord.id,
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
export { getClientIP } from './auth-helpers';
export { validateLoginCSRFToken } from './login-csrf-utils';
export {
  COOKIE_CONFIG,
  createSessionCookie,
  createClearSessionCookie,
  appendSessionCookie,
  appendClearCookies,
  getSessionFromCookies,
} from './cookie-config';
