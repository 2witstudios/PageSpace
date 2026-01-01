import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/server';

/**
 * Origin Header Validation for API Routes (Defense-in-Depth)
 *
 * This module provides Origin header validation as supplementary CSRF protection.
 * While SameSite=strict cookies provide the primary defense, Origin validation
 * adds an additional security layer against potential browser vulnerabilities
 * or misconfigurations.
 *
 * Key behaviors:
 * - Missing Origin header is ALLOWED (same-origin requests, non-browser clients like curl, MCP)
 * - Invalid Origin header returns 403 Forbidden
 * - Uses WEB_APP_URL environment variable for allowed origins
 *
 * Usage:
 * ```typescript
 * import { validateOrigin } from '@/lib/auth/origin-validation';
 *
 * export async function POST(request: Request) {
 *   const originError = validateOrigin(request);
 *   if (originError) return originError;
 *
 *   // Continue with request processing
 * }
 * ```
 */

/**
 * Safe methods that typically don't require origin validation
 * These methods should not modify server state per HTTP specification
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Extracts Origin header from request
 */
function getOriginFromRequest(request: Request): string | null {
  return request.headers.get('origin');
}

/**
 * Gets the list of allowed origins from environment configuration
 *
 * @returns Array of allowed origin URLs
 */
function getAllowedOrigins(): string[] {
  const origins: string[] = [];

  // Primary origin from WEB_APP_URL
  const webAppUrl = process.env.WEB_APP_URL;
  if (webAppUrl) {
    origins.push(normalizeOrigin(webAppUrl));
  }

  // Additional origins from ADDITIONAL_ALLOWED_ORIGINS (comma-separated)
  const additionalOrigins = process.env.ADDITIONAL_ALLOWED_ORIGINS;
  if (additionalOrigins) {
    const parsed = additionalOrigins
      .split(',')
      .map((o) => normalizeOrigin(o.trim()))
      .filter((o) => o.length > 0);
    origins.push(...parsed);
  }

  return origins;
}

/**
 * Normalizes an origin URL by extracting protocol, host, and port
 * This ensures consistent comparison between origins
 *
 * @param origin - The origin URL to normalize
 * @returns Normalized origin (protocol://host:port) or empty string if invalid
 */
function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    // Origin is scheme://host:port (port may be implicit for standard ports)
    return url.origin;
  } catch {
    return '';
  }
}

/**
 * Checks if the given origin is in the allowed list
 *
 * @param origin - The origin to validate
 * @param allowedOrigins - List of allowed origins
 * @returns true if origin is allowed, false otherwise
 */
function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  return allowedOrigins.some((allowed) => allowed === normalizedOrigin);
}

/**
 * Validates the Origin header for the current request
 *
 * This function:
 * 1. Allows requests without Origin header (non-browser clients, same-origin)
 * 2. Validates Origin against configured allowed origins
 * 3. Logs security warnings for rejected origins
 * 4. Returns an error response if validation fails
 *
 * @param request - The incoming HTTP request
 * @returns NextResponse with 403 error if validation fails, null if valid
 */
export function validateOrigin(request: Request): NextResponse | null {
  const origin = getOriginFromRequest(request);

  // Allow requests without Origin header
  // This handles same-origin requests, non-browser clients (curl, MCP), and older browsers
  if (!origin) {
    loggers.auth.debug('Origin validation: no Origin header present (allowed)', {
      method: request.method,
      url: request.url,
    });
    return null;
  }

  const allowedOrigins = getAllowedOrigins();

  // If no allowed origins configured, log warning but allow request
  if (allowedOrigins.length === 0) {
    loggers.auth.warn('Origin validation: WEB_APP_URL not configured, skipping validation', {
      method: request.method,
      url: request.url,
      origin,
    });
    return null;
  }

  // Validate origin against allowed list
  if (isOriginAllowed(origin, allowedOrigins)) {
    loggers.auth.debug('Origin validation successful', {
      method: request.method,
      url: request.url,
      origin,
    });
    return null;
  }

  // Origin not in allowed list - reject with 403
  loggers.auth.warn('Origin validation failed: unexpected origin', {
    method: request.method,
    url: request.url,
    origin,
    allowedOrigins,
  });

  return NextResponse.json(
    {
      error: 'Origin not allowed',
      code: 'ORIGIN_INVALID',
      details: 'The request origin is not in the list of allowed origins',
    },
    { status: 403 }
  );
}

/**
 * Checks if a request requires origin validation
 * Origin validation is recommended for mutation methods (non-safe methods)
 *
 * @param request - The incoming HTTP request
 * @returns true if origin validation is recommended, false otherwise
 */
export function requiresOriginValidation(request: Request): boolean {
  return !SAFE_METHODS.has(request.method);
}
