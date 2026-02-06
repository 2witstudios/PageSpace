/**
 * Cron Authentication Utility
 *
 * Two-layer security model:
 *   1. Primary: Cryptographic CRON_SECRET validation (timing-safe comparison)
 *   2. Defense-in-depth: Internal network header checks
 *
 * When CRON_SECRET is configured (production):
 *   - Requests MUST include valid Authorization: Bearer <secret>
 *   - Internal network checks still apply as additional layer
 *
 * When CRON_SECRET is not configured (development):
 *   - Falls back to internal network checks only
 *   - Logs a warning on first request
 */

import { timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';

let cronSecretWarningLogged = false;

/**
 * Check if request originates from internal network (not proxied from outside)
 *
 * Returns true if:
 * - No X-Forwarded-For header (not proxied from external source)
 * - Host is localhost, internal docker service name, or IP
 */
export function isInternalRequest(request: Request): boolean {
  const host = request.headers.get('host') ?? '';
  const forwardedFor = request.headers.get('x-forwarded-for');

  // If there's a forwarded-for header, request came through a proxy/load balancer
  // from an external source - reject it
  if (forwardedFor) {
    return false;
  }

  // Allow localhost (dev/testing)
  if (
    host.startsWith('localhost') ||
    host.startsWith('127.0.0.1') ||
    host.startsWith('[::1]')
  ) {
    return true;
  }

  // Allow internal docker service names (e.g., web:3000, web)
  // These are only reachable from within the docker network
  if (host.startsWith('web:') || host === 'web') {
    return true;
  }

  return false;
}

// Alias for backward compatibility with tests
export const isLocalhostRequest = isInternalRequest;

/**
 * Validate the Authorization header against CRON_SECRET using timing-safe comparison.
 * Expects: Authorization: Bearer <CRON_SECRET>
 */
export function hasValidCronSecret(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return false;
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    return false;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) {
    return false;
  }

  const provided = match[1];

  // Timing-safe comparison: both buffers must be same length
  const expectedBuffer = Buffer.from(cronSecret, 'utf-8');
  const providedBuffer = Buffer.from(provided, 'utf-8');

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/**
 * Validate cron request and return error response if invalid
 * Returns null if request is valid, error response if invalid
 *
 * When CRON_SECRET is configured: requires valid secret AND internal network origin
 * When CRON_SECRET is not configured: falls back to internal network check only (dev mode)
 */
export function validateCronRequest(request: Request): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    if (!cronSecretWarningLogged) {
      console.warn(
        '[cron-auth] CRON_SECRET is not configured. Falling back to network-only auth. Set CRON_SECRET in production.'
      );
      cronSecretWarningLogged = true;
    }
    // Dev fallback: internal network check only
    if (!isInternalRequest(request)) {
      return NextResponse.json(
        { error: 'Forbidden - cron endpoints only accessible from internal network' },
        { status: 403 }
      );
    }
    return null;
  }

  // Production: require valid secret
  if (!hasValidCronSecret(request)) {
    return NextResponse.json(
      { error: 'Forbidden - invalid or missing cron secret' },
      { status: 403 }
    );
  }

  // Defense-in-depth: also check internal network origin
  if (!isInternalRequest(request)) {
    return NextResponse.json(
      { error: 'Forbidden - cron endpoints only accessible from internal network' },
      { status: 403 }
    );
  }

  return null;
}
