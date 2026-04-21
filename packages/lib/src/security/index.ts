/**
 * Security Module
 *
 * Provides security utilities for PageSpace:
 * - Distributed rate limiting (Postgres)
 * - JTI (JWT ID) tracking and revocation (Postgres)
 * - Auth handoff token sweep (Postgres)
 * - SSRF prevention (URL validation)
 * - Path traversal prevention
 */

// JTI (JWT ID) revocation
export {
  recordJTI,
  isJTIRevoked,
  revokeJTI,
  revokeAllUserJTIs,
  sweepExpiredRevokedJTIs,
} from './jti-revocation';

// Distributed rate limiting
export {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  getDistributedRateLimitStatus,
  initializeDistributedRateLimiting,
  shutdownRateLimiting,
  sweepExpiredRateLimitBuckets,
  DISTRIBUTED_RATE_LIMITS,
  type RateLimitConfig,
  type RateLimitResult,
} from './distributed-rate-limit';

// Auth handoff token sweep
export { sweepExpiredAuthHandoffTokens } from './auth-handoff-sweep';

// SSRF prevention (URL validation)
export {
  validateExternalURL,
  validateLocalProviderURL,
  safeFetch,
  isBlockedIP,
  type URLValidationResult,
} from './url-validator';

// Path traversal prevention
export {
  resolvePathWithin,
  resolvePathWithinSync,
  validateFilename,
  isPathWithinBase,
  type PathValidationResult,
} from './path-validator';
