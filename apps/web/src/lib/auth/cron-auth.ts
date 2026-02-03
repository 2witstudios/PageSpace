/**
 * Cron Authentication Utility
 *
 * Zero-trust approach: Cron endpoints only accessible from internal network.
 * No secret comparison needed - requests must not come through external proxy.
 *
 * Security model:
 *   - External requests go through reverse proxy → adds x-forwarded-for → REJECTED
 *   - Internal docker network requests → no x-forwarded-for → ALLOWED
 *   - Localhost requests (dev/testing) → no x-forwarded-for → ALLOWED
 *
 * Usage:
 *   1. Cron service (inside docker) hits http://web:3000/api/cron/...
 *   2. Route calls validateCronRequest(request)
 *   3. No secrets needed, no timing attacks, request stays internal
 */

import { NextResponse } from 'next/server';

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
 * Validate cron request and return error response if invalid
 * Returns null if request is valid, error response if invalid
 */
export function validateCronRequest(request: Request): NextResponse | null {
  if (!isInternalRequest(request)) {
    return NextResponse.json(
      { error: 'Forbidden - cron endpoints only accessible from localhost' },
      { status: 403 }
    );
  }
  return null;
}
