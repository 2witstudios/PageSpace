import type { NextRequest } from 'next/server';
import { createHash, randomBytes } from 'crypto';
import { logger } from '@pagespace/lib';

/**
 * WebSocket Security Utilities
 *
 * Implements defense-in-depth security controls for WebSocket connections:
 * - Challenge-response authentication
 * - Connection fingerprinting (IP + User-Agent hashing)
 * - Per-connection rate limiting
 * - Message size validation
 * - Security event logging
 */

// ============================================================================
// CHALLENGE-RESPONSE AUTHENTICATION
// ============================================================================

interface Challenge {
  challenge: string;
  expiresAt: number;
  attempts: number;
}

// Store active challenges by connection (in-memory for single-instance deployment)
const activeChallenges = new Map<string, Challenge>();

// Clean up expired challenges every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [key, challenge] of activeChallenges.entries()) {
      if (now > challenge.expiresAt) {
        activeChallenges.delete(key);
      }
    }
  },
  5 * 60 * 1000
);

/**
 * Generate a cryptographic challenge for post-connection verification
 *
 * @param userId - User ID to associate challenge with
 * @returns Challenge string to send to client
 */
export function generateChallenge(userId: string): string {
  // Generate 32-byte random challenge
  const challenge = randomBytes(32).toString('hex');

  // Store challenge with 30-second expiration
  activeChallenges.set(userId, {
    challenge,
    expiresAt: Date.now() + 30000, // 30 seconds
    attempts: 0,
  });

  return challenge;
}

/**
 * Verify challenge response from client
 *
 * Client must compute: SHA256(challenge + userId + sessionId)
 *
 * @param userId - User ID
 * @param response - Client's challenge response
 * @param sessionId - Session ID from JWT
 * @returns true if response is valid and within attempt limits
 */
export function verifyChallengeResponse(
  userId: string,
  response: string,
  sessionId: string
): { valid: boolean; failureReason?: string } {
  const challengeData = activeChallenges.get(userId);

  if (!challengeData) {
    return {
      valid: false,
      failureReason: 'No active challenge or challenge expired',
    };
  }

  // Check expiration
  if (Date.now() > challengeData.expiresAt) {
    activeChallenges.delete(userId);
    return { valid: false, failureReason: 'Challenge expired' };
  }

  // Increment attempt counter
  challengeData.attempts++;

  // Prevent brute force - max 3 attempts
  if (challengeData.attempts > 3) {
    activeChallenges.delete(userId);
    return {
      valid: false,
      failureReason: 'Too many failed challenge attempts',
    };
  }

  // Compute expected response: SHA256(challenge + userId + sessionId)
  const expectedResponse = createHash('sha256')
    .update(challengeData.challenge + userId + sessionId)
    .digest('hex');

  // Timing-safe comparison
  const valid = timingSafeEqual(
    Buffer.from(response, 'hex'),
    Buffer.from(expectedResponse, 'hex')
  );

  if (valid) {
    // Clear challenge on success
    activeChallenges.delete(userId);
    return { valid: true };
  }

  return { valid: false, failureReason: 'Invalid challenge response' };
}

/**
 * Timing-safe equality check to prevent timing attacks
 */
function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

/**
 * Clear challenge for a user (e.g., on disconnect)
 */
export function clearChallenge(userId: string): void {
  activeChallenges.delete(userId);
}

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
// RATE LIMITING
// ============================================================================

interface RateLimitState {
  requests: number[];
  blockedUntil?: number;
}

// Store rate limit state by userId
const rateLimitStates = new Map<string, RateLimitState>();

// Clean up old rate limit states every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    const cutoff = now - 60000; // 1 minute ago

    for (const [key, state] of rateLimitStates.entries()) {
      // Remove blocked entries that have expired
      if (state.blockedUntil && now > state.blockedUntil) {
        rateLimitStates.delete(key);
        continue;
      }

      // Remove requests older than 1 minute
      state.requests = state.requests.filter((timestamp) => timestamp > cutoff);

      // Remove entry if no recent requests
      if (state.requests.length === 0 && !state.blockedUntil) {
        rateLimitStates.delete(key);
      }
    }
  },
  5 * 60 * 1000
);

/**
 * Check tool execution rate limit
 *
 * Implements sliding window rate limiting:
 * - 100 tool execution requests per minute per user
 * - 15-minute block on violation
 *
 * @param userId - User ID
 * @returns Object indicating if request is allowed
 */
export function checkToolExecutionRateLimit(userId: string): {
  allowed: boolean;
  retryAfter?: number;
  requestsRemaining?: number;
} {
  const now = Date.now();
  const windowMs = 60000; // 1 minute
  const maxRequests = 100;
  const blockDurationMs = 15 * 60 * 1000; // 15 minutes

  let state = rateLimitStates.get(userId);

  if (!state) {
    state = { requests: [] };
    rateLimitStates.set(userId, state);
  }

  // Check if currently blocked
  if (state.blockedUntil && now < state.blockedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((state.blockedUntil - now) / 1000),
    };
  }

  // Block has expired - reset
  if (state.blockedUntil && now >= state.blockedUntil) {
    state.requests = [];
    delete state.blockedUntil;
  }

  // Remove requests outside the window
  state.requests = state.requests.filter(
    (timestamp) => now - timestamp < windowMs
  );

  // Check if rate limit exceeded
  if (state.requests.length >= maxRequests) {
    state.blockedUntil = now + blockDurationMs;
    return {
      allowed: false,
      retryAfter: Math.ceil(blockDurationMs / 1000),
    };
  }

  // Add current request
  state.requests.push(now);

  return {
    allowed: true,
    requestsRemaining: maxRequests - state.requests.length,
  };
}

/**
 * Reset rate limit for a user (e.g., on disconnect)
 */
export function resetRateLimit(userId: string): void {
  rateLimitStates.delete(userId);
}

/**
 * Get rate limit status without incrementing counter
 */
export function getRateLimitStatus(userId: string): {
  blocked: boolean;
  retryAfter?: number;
  requestsRemaining?: number;
} {
  const now = Date.now();
  const windowMs = 60000; // 1 minute
  const maxRequests = 100;

  const state = rateLimitStates.get(userId);

  if (!state) {
    return {
      blocked: false,
      requestsRemaining: maxRequests,
    };
  }

  // Check if currently blocked
  if (state.blockedUntil && now < state.blockedUntil) {
    return {
      blocked: true,
      retryAfter: Math.ceil((state.blockedUntil - now) / 1000),
    };
  }

  // Remove requests outside the window
  const recentRequests = state.requests.filter(
    (timestamp) => now - timestamp < windowMs
  );

  return {
    blocked: recentRequests.length >= maxRequests,
    requestsRemaining: Math.max(0, maxRequests - recentRequests.length),
  };
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

/**
 * Extract session ID from JWT payload
 *
 * Session ID is used for challenge-response and CSRF validation
 *
 * @param jwtPayload - Decoded JWT payload
 * @returns Session ID
 */
export function getSessionIdFromPayload(jwtPayload: {
  userId: string;
  tokenVersion: number;
  iat?: number;
}): string {
  // Session ID = hash(userId + tokenVersion + iat)
  // This ensures session changes when token refreshes
  return createHash('sha256')
    .update(
      `${jwtPayload.userId}:${jwtPayload.tokenVersion}:${jwtPayload.iat || 0}`
    )
    .digest('hex');
}
