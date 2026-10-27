import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Origin Validation for WebSocket Connections (Defense-in-Depth with Blocking)
 *
 * This module provides explicit origin validation that BLOCKS invalid origins.
 * Socket.IO CORS is a first line of defense, but this provides defense-in-depth
 * by rejecting connections from unexpected origins at the middleware level.
 *
 * The allowlist is the web app's origin (CORS_ORIGIN, else WEB_APP_URL) plus
 * ADDITIONAL_ALLOWED_ORIGINS. Any browser app on another origin must be listed
 * there — imago in local dev (http://localhost:3006) is, see .env.example.
 */

/**
 * Normalizes an origin URL by extracting protocol, host, and port
 * This ensures consistent comparison between origins
 *
 * @param origin - The origin URL to normalize
 * @returns Normalized origin (protocol://host:port) or empty string if invalid
 */
export function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.origin;
  } catch {
    return '';
  }
}

/**
 * Gets the list of allowed origins from environment configuration
 *
 * @returns Array of allowed origin URLs
 */
export function getAllowedOrigins(): string[] {
  const origins: string[] = [];

  // Primary origins from CORS_ORIGIN or WEB_APP_URL (matches Socket.IO CORS config)
  const corsOrigin = process.env.CORS_ORIGIN;
  const webAppUrl = process.env.WEB_APP_URL;

  if (corsOrigin) {
    const normalized = normalizeOrigin(corsOrigin);
    if (normalized) origins.push(normalized);
  } else if (webAppUrl) {
    const normalized = normalizeOrigin(webAppUrl);
    if (normalized) origins.push(normalized);
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
 * Checks if the given origin is in the allowed list
 *
 * @param origin - The origin to validate
 * @param allowedOrigins - List of allowed origins
 * @returns true if origin is allowed, false otherwise
 */
export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  return allowedOrigins.some((allowed) => allowed === normalizedOrigin);
}

/**
 * Validates WebSocket connection origin and returns whether to allow the connection
 *
 * This function BLOCKS connections from invalid origins (defense-in-depth).
 * Socket.IO CORS is a first line of defense, but this provides additional protection.
 *
 * @param origin - The Origin header value from the connection request
 * @param metadata - Additional metadata for logging (socketId, IP, etc.)
 * @returns true if connection should be allowed, false if it should be rejected
 */
export function validateAndLogWebSocketOrigin(
  origin: string | undefined,
  metadata: { socketId: string; ip: string | undefined; userAgent: string | undefined }
): boolean {
  const allowedOrigins = getAllowedOrigins();

  // No origin header - non-browser client (curl, mobile apps, etc.)
  // Allow these as they authenticate via tokens, not cookies
  if (!origin) {
    loggers.realtime.debug('WebSocket origin validation: no Origin header', {
      ...metadata,
      reason: 'Non-browser client or same-origin request',
    });
    return true;
  }

  // No allowed origins configured in production is a misconfiguration
  // In development, allow but warn. In production, this should fail closed.
  if (allowedOrigins.length === 0) {
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction) {
      loggers.realtime.error('WebSocket origin validation: REJECTED - no allowed origins configured in production', {
        ...metadata,
        origin,
        severity: 'security',
        reason: 'CORS_ORIGIN and WEB_APP_URL not set in production',
      });
      return false;
    }
    loggers.realtime.warn('WebSocket origin validation: no allowed origins configured (allowing in development)', {
      ...metadata,
      origin,
      reason: 'CORS_ORIGIN and WEB_APP_URL not set',
    });
    return true;
  }

  // Check if origin is allowed
  if (isOriginAllowed(origin, allowedOrigins)) {
    loggers.realtime.debug('WebSocket origin validation: valid origin', {
      ...metadata,
      origin,
    });
    return true;
  }

  // Origin not in allowed list - REJECT the connection
  loggers.realtime.warn('WebSocket origin validation: REJECTED - unexpected origin', {
    ...metadata,
    origin,
    allowedOrigins,
    severity: 'security',
    reason: 'Origin not in allowed list - connection rejected',
  });
  return false;
}

/**
 * Socket.IO's CORS `origin` option: the browser-facing first line of defense.
 * No Origin header (a non-browser client) and an empty allowlist both pass,
 * and the connection middleware decides (validateAndLogWebSocketOrigin).
 */
export function corsOrigin(
  origin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void
): void {
  if (!origin) return callback(null, true);
  const allowed = getAllowedOrigins();
  if (allowed.length === 0 || allowed.includes(normalizeOrigin(origin))) {
    callback(null, true);
  } else {
    callback(new Error('Origin not allowed'));
  }
}
