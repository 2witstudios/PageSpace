import { NextResponse } from 'next/server';
import { parse } from 'cookie';
import { decodeToken } from '@pagespace/lib/server';
import { db, mcpTokens, users, eq, and, isNull } from '@pagespace/db';

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

    const tokenRecord = await db.query.mcpTokens.findFirst({
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

  // Apply CSRF validation only for JWT-authenticated requests
  // MCP tokens are exempt from CSRF protection (they use Bearer auth, not cookies)
  if (requireCSRF && authResult.tokenType === 'jwt') {
    const { validateCSRF } = await import('./csrf-validation');
    const csrfError = await validateCSRF(request);
    if (csrfError) {
      return { error: csrfError };
    }
  }

  return authResult;
}
