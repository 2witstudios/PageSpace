import { NextResponse } from 'next/server';
import { parse } from 'cookie';
import { decodeToken } from '@pagespace/lib/server';
import { db, mcpTokens, users, eq, and, isNull } from '@pagespace/db';
import { hashToken } from '@pagespace/lib/auth';

const BEARER_PREFIX = 'Bearer ';
const MCP_TOKEN_PREFIX = 'mcp_';

export type TokenType = 'mcp' | 'jwt';

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

export interface WebAuthResult extends BaseAuthDetails {
  tokenType: 'jwt';
  source: 'header' | 'cookie';
}

export type AuthResult = MCPAuthResult | WebAuthResult;

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

function getCookieToken(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) {
    return null;
  }

  const cookies = parse(cookieHeader);
  return cookies.accessToken ?? null;
}

export async function validateMCPToken(token: string): Promise<MCPAuthDetails | null> {
  try {
    if (!token || !token.startsWith(MCP_TOKEN_PREFIX)) {
      return null;
    }

    // P1-T3: Hash-based token lookup with plaintext fallback for migration
    const tokenHash = hashToken(token);

    // Try hash lookup first (new tokens)
    let tokenRecord = await db.query.mcpTokens.findFirst({
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

    // Fall back to plaintext lookup (legacy tokens during migration)
    if (!tokenRecord) {
      tokenRecord = await db.query.mcpTokens.findFirst({
        where: and(eq(mcpTokens.token, token), isNull(mcpTokens.revokedAt)),
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
    }

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

export async function validateJWTToken(token: string): Promise<BaseAuthDetails | null> {
  try {
    if (!token) {
      return null;
    }

    const payload = await decodeToken(token);
    if (!payload) {
      return null;
    }

    const userRecord = await db.query.users.findFirst({
      where: eq(users.id, payload.userId),
      columns: {
        id: true,
        role: true,
        tokenVersion: true,
      },
    });

    if (!userRecord || userRecord.tokenVersion !== payload.tokenVersion) {
      return null;
    }

    return {
      userId: userRecord.id,
      role: userRecord.role as 'user' | 'admin',
      tokenVersion: userRecord.tokenVersion,
    };
  } catch (error) {
    console.error('validateJWTToken error', error);
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

export async function authenticateWebRequest(request: Request): Promise<AuthenticationResult> {
  const bearerToken = getBearerToken(request);

  if (bearerToken?.startsWith(MCP_TOKEN_PREFIX)) {
    return {
      error: unauthorized('MCP tokens are not permitted for this endpoint'),
    };
  }

  const jwtToken = bearerToken ?? getCookieToken(request);

  if (!jwtToken) {
    return {
      error: unauthorized('Authentication required'),
    };
  }

  const jwtDetails = await validateJWTToken(jwtToken);
  if (!jwtDetails) {
    return {
      error: unauthorized('Invalid or expired session'),
    };
  }

  return {
    ...jwtDetails,
    tokenType: 'jwt',
    source: bearerToken ? 'header' : 'cookie',
  } satisfies WebAuthResult;
}

export async function authenticateHybridRequest(request: Request): Promise<AuthenticationResult> {
  return authenticateRequestWithOptions(request, { allow: ['mcp', 'jwt'] });
}

export function isAuthError(result: AuthenticationResult): result is AuthError {
  return 'error' in result;
}

export function isMCPAuthResult(result: AuthenticationResult): result is MCPAuthResult {
  return !('error' in result) && result.tokenType === 'mcp';
}

export function isWebAuthResult(result: AuthenticationResult): result is WebAuthResult {
  return !('error' in result) && result.tokenType === 'jwt';
}

export async function authenticateRequestWithOptions(
  request: Request,
  options: AuthenticateOptions,
): Promise<AuthenticationResult> {
  const { allow, requireCSRF = false } = options;
  // Origin validation is automatically enabled when requireCSRF is true (defense-in-depth)
  // It can be explicitly disabled per-route by setting requireOriginValidation: false
  const requireOriginValidation = options.requireOriginValidation ?? requireCSRF;

  if (!allow.length) {
    return {
      error: unauthorized('No authentication methods permitted for this endpoint', 500),
    };
  }

  const allowedTypes = new Set(allow);
  const allowMCP = allowedTypes.has('mcp');
  const allowJWT = allowedTypes.has('jwt');

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

  if (allowJWT) {
    authResult = await authenticateWebRequest(request);
  } else if (allowMCP) {
    authResult = await authenticateMCPRequest(request);
  } else {
    return {
      error: unauthorized('No authentication methods permitted for this endpoint', 500),
    };
  }

  // If authentication failed, return the error
  if (isAuthError(authResult)) {
    return authResult;
  }

  // Apply origin and CSRF validation only for cookie-based JWT authentication
  // Bearer tokens (header-based auth) are exempt because they're not sent automatically by browsers
  const isCookieBasedAuth = authResult.tokenType === 'jwt' && authResult.source === 'cookie';

  // Origin validation (defense-in-depth) - happens before CSRF validation
  if (requireOriginValidation && isCookieBasedAuth) {
    const { validateOrigin } = await import('./origin-validation');
    const originError = validateOrigin(request);
    if (originError) {
      return { error: originError };
    }
  }

  // CSRF validation
  if (requireCSRF && isCookieBasedAuth) {
    const { validateCSRF } = await import('./csrf-validation');
    const csrfError = await validateCSRF(request);
    if (csrfError) {
      return { error: csrfError };
    }
  }

  return authResult;
}

// Re-export from other auth modules for barrel export pattern
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
