/**
 * Cron Authentication Utility
 *
 * Security model:
 *   1. Primary: HMAC-SHA256 signed requests with anti-replay protection
 *   2. Defense-in-depth: Internal network header checks
 *
 * Production (CRON_SECRET required):
 *   - Requests MUST include valid signed headers (timestamp, nonce, signature)
 *   - Rejects if CRON_SECRET not configured (fail-closed)
 *   - Internal network checks still apply as additional layer
 *
 * Development (CRON_SECRET optional):
 *   - Falls back to internal network checks only
 *   - Logs a warning on first request
 */

import { createHmac, timingSafeEqual } from 'crypto';
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


// ============================================================
// HMAC-Signed Request Validation (anti-replay upgrade)
// ============================================================

const TIMESTAMP_MAX_AGE_SECONDS = 300; // 5 minutes
const NONCE_CLEANUP_INTERVAL_MS = 600_000; // 10 minutes

const usedNonces = new Map<string, number>(); // nonce → epoch ms when recorded
let lastNonceCleanup = Date.now();

/**
 * Compute HMAC-SHA256 signature for cron request validation.
 * Message format: `${timestamp}:${nonce}:${method}:${path}`
 */
export function computeCronSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  method: string,
  path: string
): string {
  const message = `${timestamp}:${nonce}:${method}:${path}`;
  return createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Check if a nonce has been seen before and record it.
 * Periodically prunes nonces older than the timestamp acceptance window,
 * preventing the race condition where a blanket clear could evict still-valid nonces.
 */
export function checkAndRecordNonce(nonce: string): boolean {
  const now = Date.now();
  if (now - lastNonceCleanup > NONCE_CLEANUP_INTERVAL_MS) {
    const cutoffMs = now - TIMESTAMP_MAX_AGE_SECONDS * 1000;
    for (const [n, ts] of usedNonces) {
      if (ts < cutoffMs) usedNonces.delete(n);
    }
    lastNonceCleanup = now;
  }

  if (usedNonces.has(nonce)) {
    return false; // Replay detected
  }

  usedNonces.set(nonce, now);
  return true;
}

/** Exported for testing only */
export function _resetNonceStore(): void {
  usedNonces.clear();
  lastNonceCleanup = Date.now();
}

/**
 * Validate an HMAC-signed cron request.
 *
 * Expected headers:
 *   X-Cron-Timestamp: Unix epoch seconds
 *   X-Cron-Nonce: Random UUID per request
 *   X-Cron-Signature: HMAC-SHA256(CRON_SECRET, `${timestamp}:${nonce}:${method}:${path}`)
 *
 * Validation:
 *   1. Reject if CRON_SECRET not configured (fail-closed in production)
 *   2. Reject if any required header is missing
 *   3. Reject if timestamp older than 5 minutes (anti-replay)
 *   4. Recompute signature and timing-safe compare
 *   5. Reject if nonce already seen (recorded after signature verified)
 *   6. Defense-in-depth: require internal network origin
 *
 * Returns null on success, 403 NextResponse on failure.
 */
export function validateSignedCronRequest(request: Request): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    // Fail-closed in production: CRON_SECRET must be configured
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'Forbidden - CRON_SECRET must be configured in production' },
        { status: 403 }
      );
    }
    // Development fallback: network-only auth
    if (!cronSecretWarningLogged) {
      console.warn(
        '[cron-auth] CRON_SECRET is not configured. Falling back to network-only auth. Set CRON_SECRET in production.'
      );
      cronSecretWarningLogged = true;
    }
    if (!isInternalRequest(request)) {
      return NextResponse.json(
        { error: 'Forbidden - cron endpoints only accessible from internal network' },
        { status: 403 }
      );
    }
    return null;
  }

  const timestamp = request.headers.get('x-cron-timestamp');
  const nonce = request.headers.get('x-cron-nonce');
  const signature = request.headers.get('x-cron-signature');

  if (!timestamp || !nonce || !signature) {
    return NextResponse.json(
      { error: 'Forbidden - missing cron authentication headers' },
      { status: 403 }
    );
  }

  // Anti-replay: check timestamp freshness
  const requestTime = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(requestTime) || Math.abs(now - requestTime) >= TIMESTAMP_MAX_AGE_SECONDS) {
    return NextResponse.json(
      { error: 'Forbidden - cron request timestamp expired' },
      { status: 403 }
    );
  }

  // Recompute and compare signature (before recording nonce to avoid burning valid nonces)
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  const expectedSignature = computeCronSignature(cronSecret, timestamp, nonce, method, path);

  const expectedBuffer = Buffer.from(expectedSignature, 'utf-8');
  const providedBuffer = Buffer.from(signature, 'utf-8');

  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    return NextResponse.json(
      { error: 'Forbidden - invalid cron signature' },
      { status: 403 }
    );
  }

  // Anti-replay: check nonce uniqueness (after signature verified)
  if (!checkAndRecordNonce(nonce)) {
    return NextResponse.json(
      { error: 'Forbidden - cron request nonce already used' },
      { status: 403 }
    );
  }

  // Defense-in-depth: require internal network origin
  if (!isInternalRequest(request)) {
    return NextResponse.json(
      { error: 'Forbidden - cron endpoints only accessible from internal network' },
      { status: 403 }
    );
  }

  return null;
}
