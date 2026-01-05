/**
 * Security Module
 *
 * Provides security utilities for PageSpace:
 * - Distributed rate limiting
 * - JTI (JWT ID) tracking and revocation
 * - Session management
 * - SSRF prevention (coming soon)
 * - Path traversal prevention (coming soon)
 */

// Security Redis operations
export {
  getSecurityRedisClient,
  isSecurityRedisAvailable,
  tryGetSecurityRedisClient,
  checkSecurityRedisHealth,
  // JTI operations
  recordJTI,
  isJTIRevoked,
  revokeJTI,
  revokeAllUserJTIs,
  // Session operations
  setSessionData,
  getSessionData,
  deleteSessionData,
} from './security-redis';

// Distributed rate limiting
export {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  getDistributedRateLimitStatus,
  initializeDistributedRateLimiting,
  shutdownRateLimiting,
  DISTRIBUTED_RATE_LIMITS,
  type RateLimitConfig,
  type RateLimitResult,
} from './distributed-rate-limit';
