/**
 * Auth engine imperative shell — the I/O half of the token-authentication
 * engine. Each function reads the database (or a service), delegates the
 * decision to a pure `decide*` function in `./auth-core`, then performs any
 * write the decision implies (revoke, touch lastUsed).
 *
 * This module's static import graph includes `@pagespace/db` and the session
 * service, so it must only be imported by server code. Pure consumers (types,
 * guards, scope decisions) should import from `./auth-types` / `./auth-core`
 * instead, which stay free of the database graph.
 */
import { db } from '@pagespace/db/db';
import { eq, and, isNull } from '@pagespace/db/operators';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { oauthAccessTokens } from '@pagespace/db/schema/oauth';
import { hashToken } from '@pagespace/lib/auth/token-utils';
import { sessionService, type SessionClaims } from '@pagespace/lib/auth/session-service';
import { findOAuthAccessTokenByValue } from '@pagespace/lib/auth/token-lookup';
import { EnforcedAuthContext } from '@pagespace/lib/permissions/enforced-context';
import { logSecurityEvent } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { getSessionFromCookies } from './cookie-config';
import {
  MCP_TOKEN_PREFIX,
  SESSION_TOKEN_PREFIX,
  OAUTH_ACCESS_TOKEN_PREFIX,
} from './token-prefixes';
import {
  getBearerToken,
  unauthorized,
  isAuthError,
  decideMcpAuth,
  decideOAuthAuth,
  sessionClaimsToResult,
  getAllowedDriveIds,
  isManageKeysOnly,
  manageKeysOnlyDeniedResponse,
} from './auth-core';
import type {
  AuthenticationResult,
  AuthResult,
  AuthenticateOptions,
  EnforcedAuthResult,
  MCPAuthResult,
  MCPAuthDetails,
  OAuthAuthResult,
  OAuthAuthDetails,
} from './auth-types';

// ─── Token validation (db read → pure decide → db write) ────────────────────────

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
            suspendedAt: true,
          },
        },
        driveScopes: {
          columns: {
            driveId: true,
          },
        },
      },
    });

    const decision = decideMcpAuth(tokenRecord ?? null);

    switch (decision.kind) {
      case 'not-found':
        return null;

      case 'suspended':
        // Non-null: 'suspended' is only returned when tokenRecord.user.suspendedAt.
        logSecurityEvent('unauthorized', {
          reason: 'mcp_token_user_suspended',
          userId: tokenRecord!.userId,
          tokenId: tokenRecord!.id,
          authType: 'mcp',
          action: 'revoke_and_deny',
        });
        await db
          .update(mcpTokens)
          .set({ revokedAt: new Date() })
          .where(eq(mcpTokens.id, tokenRecord!.id));
        return null;

      case 'scoped-no-drives':
        console.warn('MCP token denied - scoped token with no remaining drives', {
          tokenId: tokenRecord!.id,
          userId: tokenRecord!.userId,
        });
        return null;

      case 'ok':
        await db
          .update(mcpTokens)
          .set({ lastUsed: new Date() })
          .where(eq(mcpTokens.id, decision.details.tokenId));
        return decision.details;
    }
  } catch (error) {
    console.error('validateMCPToken error', error);
    return null;
  }
}

export async function validateOAuthAccessToken(token: string): Promise<OAuthAuthDetails | null> {
  try {
    if (!token || !token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
      return null;
    }

    const record = await findOAuthAccessTokenByValue(token);
    const decision = decideOAuthAuth(record, Date.now());

    if (decision.kind === 'suspended') {
      // Non-null: 'suspended' is only returned when record.user.suspendedAt.
      logSecurityEvent('unauthorized', {
        reason: 'oauth_token_user_suspended',
        userId: record!.userId,
        tokenId: record!.id,
        authType: 'oauth',
        action: 'revoke_and_deny',
      });

      await db
        .update(oauthAccessTokens)
        .set({ revokedAt: new Date(), revokedReason: 'user_suspended' })
        .where(eq(oauthAccessTokens.id, record!.id));

      return null;
    }

    if (decision.kind === 'reject') {
      return null;
    }

    return decision.details;
  } catch (error) {
    console.error('validateOAuthAccessToken error', error);
    return null;
  }
}

export async function validateSessionToken(token: string): Promise<SessionClaims | null> {
  try {
    if (!token) {
      return null;
    }
    // Only browser/user sessions may authenticate generic web requests. Other
    // session types (service, mcp, device, socket) have their own dedicated
    // validation surfaces and must not be replayable as a session cookie or
    // bearer session token.
    return await sessionService.validateSession(token, { expectedType: 'user' });
  } catch (error) {
    console.error('validateSessionToken error', error);
    return null;
  }
}

// ─── Request authenticators ──────────────────────────────────────────────────────

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

export async function authenticateOAuthRequest(request: Request): Promise<AuthenticationResult> {
  const token = getBearerToken(request);

  if (!token || !token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    return {
      error: unauthorized('OAuth access token required'),
    };
  }

  const oauthDetails = await validateOAuthAccessToken(token);
  if (!oauthDetails) {
    return {
      error: unauthorized('Invalid OAuth access token'),
    };
  }

  return {
    ...oauthDetails,
    tokenType: 'oauth',
  } satisfies OAuthAuthResult;
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
        return sessionClaimsToResult(sessionResult);
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

  return sessionClaimsToResult(sessionClaims);
}

export async function authenticateHybridRequest(request: Request): Promise<AuthenticationResult> {
  return authenticateRequestWithOptions(request, { allow: ['mcp', 'session'] });
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
  const allowOAuth = allowedTypes.has('oauth');

  const bearerToken = getBearerToken(request);

  if (bearerToken?.startsWith(MCP_TOKEN_PREFIX)) {
    if (!allowMCP) {
      return {
        error: unauthorized('MCP tokens are not permitted for this endpoint'),
      };
    }
    return authenticateMCPRequest(request);
  }

  if (bearerToken?.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    if (!allowOAuth) {
      return {
        error: unauthorized('OAuth tokens are not permitted for this endpoint'),
      };
    }
    return authenticateOAuthRequest(request);
  }

  let authResult: AuthenticationResult;

  if (allowSession) {
    authResult = await authenticateSessionRequest(request);
  } else if (allowMCP) {
    authResult = await authenticateMCPRequest(request);
  } else if (allowOAuth) {
    authResult = await authenticateOAuthRequest(request);
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

  // Reject unknown Bearer token formats — prevents CSRF bypass where an attacker
  // sends `Authorization: Bearer <garbage>` to skip CSRF validation while still
  // authenticating via the victim's session cookie.
  if (bearerToken) {
    logSecurityEvent('unauthorized', {
      reason: 'unknown_bearer_format',
      authType: 'bearer',
      action: 'deny',
    });
    return { error: unauthorized('Invalid token format') };
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

  // Apply CSRF validation for cookie-based session auth
  if (requireCSRF) {
    const { validateCSRF } = await import('./csrf-validation');
    const csrfError = await validateCSRF(request);
    if (csrfError) {
      return { error: csrfError };
    }
  }

  return { ctx: EnforcedAuthContext.fromSession(sessionClaims) };
}

/**
 * Check if an MCP token has access to a page by looking up its drive.
 * Returns null if access is allowed, or a 403/404 response if denied/not found.
 *
 * Impure (page → drive database lookup), so it lives in the shell rather than
 * alongside the pure scope helpers in `./auth-core`.
 */
export async function checkMCPPageScope(
  auth: AuthResult,
  pageId: string
): Promise<NextResponse | null> {
  if (isManageKeysOnly(auth)) {
    return manageKeysOnlyDeniedResponse();
  }

  const allowedDriveIds = getAllowedDriveIds(auth);

  // Empty allowedDriveIds means full access
  if (allowedDriveIds.length === 0) {
    return null;
  }

  // Need to look up the page's drive
  const { pages } = await import('@pagespace/db/schema/core');
  const { eq } = await import('@pagespace/db/operators');
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
