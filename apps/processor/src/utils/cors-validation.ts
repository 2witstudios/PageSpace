import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Normalizes an origin URL by extracting protocol, host, and port.
 */
export function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return '';
  }
}

/**
 * Gets the list of allowed origins from environment configuration.
 * Reads CORS_ORIGIN, WEB_APP_URL, and ADDITIONAL_ALLOWED_ORIGINS.
 */
export function getAllowedOrigins(): string[] {
  const origins: string[] = [];

  const corsOrigin = process.env.CORS_ORIGIN;
  const webAppUrl = process.env.WEB_APP_URL;

  if (corsOrigin) {
    const normalized = normalizeOrigin(corsOrigin);
    if (normalized) origins.push(normalized);
  } else if (webAppUrl) {
    const normalized = normalizeOrigin(webAppUrl);
    if (normalized) origins.push(normalized);
  }

  const additional = process.env.ADDITIONAL_ALLOWED_ORIGINS;
  if (additional) {
    origins.push(
      ...additional
        .split(',')
        .map((o) => normalizeOrigin(o.trim()))
        .filter((o) => o.length > 0)
    );
  }

  return origins;
}

export interface CorsCallbackResult {
  error: Error | null;
  allowed: boolean;
}

/**
 * Validates a CORS origin against the allowed origins list.
 * Returns a result indicating whether the origin should be allowed.
 */
export function validateCorsOrigin(origin: string | undefined): CorsCallbackResult {
  // No origin = non-browser client (curl, MCP, mobile) - allow
  if (!origin) {
    return { error: null, allowed: true };
  }

  const allowedOrigins = getAllowedOrigins();

  // No config in production = fail closed
  if (allowedOrigins.length === 0) {
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction) {
      loggers.processor.error('CORS rejected: no allowed origins configured', {
        origin,
        severity: 'security',
      });
      return { error: new Error('CORS not configured'), allowed: false };
    }
    loggers.processor.warn('CORS: no allowed origins configured (allowing in dev)', { origin });
    return { error: null, allowed: true };
  }

  // Check origin against allowed list
  const normalized = normalizeOrigin(origin);
  if (allowedOrigins.includes(normalized)) {
    return { error: null, allowed: true };
  }

  // Reject unknown origin
  loggers.processor.warn('CORS rejected: origin not in allowed list', {
    origin,
    allowedOrigins,
    severity: 'security',
  });
  return { error: new Error('Origin not allowed'), allowed: false };
}
