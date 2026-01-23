import { NextResponse } from 'next/server';
import { validateCSRFToken, sessionService } from '@pagespace/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { getSessionFromCookies } from './cookie-config';

/**
 * CSRF Token Validation for API Routes
 *
 * This module provides CSRF protection for authenticated API endpoints.
 * CSRF tokens are required for all mutation operations (POST, PATCH, PUT, DELETE)
 * to prevent Cross-Site Request Forgery attacks.
 *
 * Session-based CSRF: Tokens are bound to server-validated session IDs,
 * not client-controlled JWT claims.
 *
 * Usage:
 * ```typescript
 * import { validateCSRF } from '@/lib/auth/csrf-validation';
 *
 * export async function POST(request: Request) {
 *   const csrfError = await validateCSRF(request);
 *   if (csrfError) return csrfError;
 *
 *   // Continue with authenticated request
 * }
 * ```
 */

const CSRF_HEADER = 'x-csrf-token';

/**
 * Safe methods that don't require CSRF protection
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Validates CSRF token for the current request
 *
 * This function:
 * 1. Skips validation for safe HTTP methods (GET, HEAD, OPTIONS)
 * 2. Extracts the CSRF token from the X-CSRF-Token header
 * 3. Validates the token against the server-validated session ID
 * 4. Returns an error response if validation fails
 *
 * @param request - The incoming HTTP request
 * @returns NextResponse with 403 error if validation fails, null if valid
 */
export async function validateCSRF(request: Request): Promise<NextResponse | null> {
  const method = request.method;

  // Skip CSRF validation for safe methods
  if (SAFE_METHODS.has(method)) {
    return null;
  }

  // Extract CSRF token from headers
  const csrfToken = request.headers.get(CSRF_HEADER);
  if (!csrfToken) {
    loggers.auth.warn('CSRF token missing from request', {
      method,
      url: request.url,
    });
    return NextResponse.json(
      {
        error: 'CSRF token required',
        code: 'CSRF_TOKEN_MISSING',
        details: 'Include X-CSRF-Token header with your request',
      },
      { status: 403 }
    );
  }

  // Extract session token from cookies
  const cookieHeader = request.headers.get('cookie');
  const sessionToken = getSessionFromCookies(cookieHeader);

  if (!sessionToken) {
    loggers.auth.warn('CSRF validation failed: no session token', {
      method,
      url: request.url,
    });
    return NextResponse.json(
      {
        error: 'Authentication required for CSRF validation',
        code: 'CSRF_NO_SESSION',
      },
      { status: 401 }
    );
  }

  // Validate session with server
  const sessionClaims = await sessionService.validateSession(sessionToken);
  if (!sessionClaims) {
    loggers.auth.warn('CSRF validation failed: invalid session', {
      method,
      url: request.url,
    });
    return NextResponse.json(
      {
        error: 'Invalid session for CSRF validation',
        code: 'CSRF_INVALID_SESSION',
      },
      { status: 401 }
    );
  }

  // Validate CSRF token against session ID
  const isValid = validateCSRFToken(csrfToken, sessionClaims.sessionId);

  if (!isValid) {
    loggers.auth.warn('CSRF token validation failed', {
      method,
      url: request.url,
      userId: sessionClaims.userId,
    });
    return NextResponse.json(
      {
        error: 'Invalid or expired CSRF token',
        code: 'CSRF_TOKEN_INVALID',
        details: 'Your CSRF token is invalid or has expired. Refresh and try again.',
      },
      { status: 403 }
    );
  }

  loggers.auth.debug('CSRF token validated successfully', {
    method,
    url: request.url,
    userId: sessionClaims.userId,
  });

  return null;
}

/**
 * Checks if a request requires CSRF protection
 */
export function requiresCSRFProtection(request: Request): boolean {
  return !SAFE_METHODS.has(request.method);
}
