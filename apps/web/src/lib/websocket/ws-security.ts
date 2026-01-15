import type { NextRequest } from 'next/server';
import { createHash } from 'crypto';
import { logger } from '@pagespace/lib';

/**
 * WebSocket Security Utilities
 *
 * Implements defense-in-depth security controls for WebSocket connections:
 * - Connection fingerprinting (IP + User-Agent hashing)
 * - Message size validation
 * - Security event logging
 *
 * Note: Authentication is now handled by session service (opaque tokens)
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
// SECURITY LOGGING
// ============================================================================

/**
 * Log security event (structured logging for SIEM integration)
 *
 * @param event - Security event type
 * @param details - Event details
 */
export function logSecurityEvent(
  event: string,
  details: {
    userId?: string;
    ip?: string;
    severity: 'info' | 'warn' | 'error' | 'critical';
    [key: string]: unknown;
  }
): void {
  // Extract severity for log level routing
  const { severity, ...restDetails } = details;

  // Create context for structured logging
  const context = {
    userId: details.userId,
    ip: details.ip,
    component: 'ws-security',
    eventType: event,
  };

  // Build metadata excluding severity and context fields
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(restDetails)) {
    if (key !== 'userId' && key !== 'ip') {
      metadata[key] = value;
    }
  }

  // Create child logger with context
  const securityLogger = logger.child(context);

  // Route to appropriate log level using structured logger
  switch (severity) {
    case 'critical':
      securityLogger.fatal(`WebSocket Security Event: ${event}`, metadata);
      break;
    case 'error':
      securityLogger.error(`WebSocket Security Event: ${event}`, metadata);
      break;
    case 'warn':
      securityLogger.warn(`WebSocket Security Event: ${event}`, metadata);
      break;
    case 'info':
    default:
      securityLogger.info(`WebSocket Security Event: ${event}`, metadata);
      break;
  }
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
