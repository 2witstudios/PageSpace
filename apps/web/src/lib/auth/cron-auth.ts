/**
 * Cron Authentication Utility
 *
 * Security model: HMAC-SHA256 signed requests with anti-replay protection.
 *
 * Production / staging (CRON_SECRET required):
 *   - Requests MUST include valid signed headers (timestamp, nonce, signature)
 *   - Rejects if CRON_SECRET not configured (fail-closed for any non-dev env)
 *
 * Local development / test (CRON_SECRET optional):
 *   - All requests allowed with a one-time warning
 */

import { createHmac } from 'crypto';
import { NextResponse } from 'next/server';
import { secureCompare } from '@pagespace/lib';

let cronSecretWarningLogged = false;

// ============================================================
// HMAC-Signed Request Validation (anti-replay upgrade)
// ============================================================

const TIMESTAMP_MAX_AGE_SECONDS = 300; // 5 minutes
const NONCE_CLEANUP_INTERVAL_MS = 600_000; // 10 minutes
const MAX_NONCES = 10_000; // Memory exhaustion safeguard

// In-memory nonce store for replay detection.
// NOTE: This is process-local and won't prevent replay across multiple server instances.
// For horizontal scaling (multiple replicas, serverless), back this with a Postgres
// TTL-keyed table (same pattern as auth_handoff_tokens / rate_limit_buckets).
// The HMAC signature + 5-minute timestamp window still provides strong protection.
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
 * Rejects if nonce store exceeds MAX_NONCES to prevent memory exhaustion.
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

  // Memory exhaustion safeguard: reject if store is full
  if (usedNonces.size >= MAX_NONCES) {
    return false;
  }

  usedNonces.set(nonce, now);
  return true;
}

/** Exported for testing only */
export function _resetNonceStore(): void {
  usedNonces.clear();
  lastNonceCleanup = Date.now();
}

/** Exported for testing only - resets the warning flag */
export function _resetWarningFlag(): void {
  cronSecretWarningLogged = false;
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
 *
 * Returns null on success, 403 NextResponse on failure.
 */
export function validateSignedCronRequest(request: Request): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    // Fail-closed for all non-local envs: staging, custom NODE_ENV, etc.
    const isLocalDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
    if (!isLocalDev) {
      return NextResponse.json(
        { error: 'Forbidden - CRON_SECRET must be configured' },
        { status: 403 }
      );
    }
    // Local dev/test only: allow with a one-time warning
    if (!cronSecretWarningLogged) {
      console.warn(
        '[cron-auth] CRON_SECRET is not configured. All cron requests allowed in local dev/test. Set CRON_SECRET in all deployed environments.'
      );
      cronSecretWarningLogged = true;
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

  if (!secureCompare(signature, expectedSignature)) {
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

  return null;
}
