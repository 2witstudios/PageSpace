import type { NextRequest } from 'next/server';
import { createHash } from 'crypto';

/**
 * WebSocket Security Utilities
 *
 * Implements defense-in-depth security controls for WebSocket connections:
 * - Connection fingerprinting (IP + User-Agent hashing)
 * - Message size validation
 *
 * Note: Authentication is now handled by session service (opaque tokens).
 * Security event logging is handled by the centralized `audit()` pipeline
 * from `@pagespace/lib/server`.
 */

// ============================================================================
// CONNECTION FINGERPRINTING
// ============================================================================

/**
 * Generate connection fingerprint from IP address and User-Agent
 *
 * @param request - NextRequest object
 * @returns SHA256 hash of IP + User-Agent
 */
export function getConnectionFingerprint(request: NextRequest): string {
  // Extract IP address (handle proxies)
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';

  // Extract User-Agent
  const userAgent = request.headers.get('user-agent') || 'unknown';

  // Hash IP + User-Agent for privacy and consistency
  const fingerprint = createHash('sha256')
    .update(`${ip}:${userAgent}`)
    .digest('hex');

  return fingerprint;
}

/**
 * Verify connection fingerprint matches stored fingerprint
 *
 * Used to detect if user's IP or browser changed mid-session
 *
 * @param currentFingerprint - Current connection fingerprint
 * @param storedFingerprint - Previously stored fingerprint
 * @returns true if fingerprints match
 */
export function verifyFingerprint(
  currentFingerprint: string,
  storedFingerprint: string
): boolean {
  return currentFingerprint === storedFingerprint;
}

// ============================================================================
// MESSAGE VALIDATION
// ============================================================================

const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB

/**
 * Validate WebSocket message size
 *
 * @param message - Message data
 * @returns true if message is within size limits
 */
export function validateMessageSize(message: Buffer | ArrayBuffer | Buffer[] | string): {
  valid: boolean;
  size?: number;
  maxSize?: number;
} {
  let size: number;

  if (typeof message === 'string') {
    size = Buffer.byteLength(message);
  } else if (Buffer.isBuffer(message)) {
    size = message.length;
  } else if (message instanceof ArrayBuffer) {
    size = message.byteLength;
  } else if (Array.isArray(message)) {
    size = message.reduce((total, buf) => total + buf.length, 0);
  } else {
    size = 0;
  }

  if (size > MAX_MESSAGE_SIZE) {
    return {
      valid: false,
      size,
      maxSize: MAX_MESSAGE_SIZE,
    };
  }

  return { valid: true };
}

// ============================================================================
// CONNECTION VALIDATION
// ============================================================================

/**
 * Verify WebSocket connection uses secure protocol in production
 *
 * Checks X-Forwarded-Proto header first (for reverse proxy deployments),
 * then falls back to URL protocol check (for direct connections).
 *
 * @param url - Request URL
 * @param request - Optional NextRequest object to check headers
 * @returns true if connection is secure or in development
 */
export function isSecureConnection(url: string, request?: { headers: { get: (name: string) => string | null } }): boolean {
  // Allow localhost connections (development only)
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    return true;
  }

  // Always allow in development
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }

  // In production behind reverse proxy: check X-Forwarded-Proto header
  // This tells us the original client protocol (https) even if the backend receives http
  if (request) {
    const forwardedProto = request.headers.get('x-forwarded-proto');
    if (forwardedProto === 'https' || forwardedProto === 'wss') {
      return true;
    }
  }

  // Fallback: check URL protocol directly (for direct connections without proxy)
  return url.startsWith('wss://') || url.startsWith('https://');
}
