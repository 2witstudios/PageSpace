// Simple in-memory rate limiter for local deployment
// For production with multiple instances, consider Redis-based rate limiting

interface RateLimitAttempt {
  count: number;
  firstAttempt: number;
  lastAttempt: number;
  blockedUntil?: number;
}

interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
  blockDurationMs?: number;
  progressiveDelay?: boolean;
}

const attempts = new Map<string, RateLimitAttempt>();

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  const cutoff = now - (24 * 60 * 60 * 1000); // 24 hours ago
  
  for (const [key, attempt] of attempts.entries()) {
    if (attempt.lastAttempt < cutoff) {
      attempts.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Rate limiting for authentication endpoints
 */
export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig
): { allowed: boolean; retryAfter?: number; attemptsRemaining?: number } {
  const now = Date.now();
  const key = `auth:${identifier}`;
  
  let attempt = attempts.get(key);
  
  if (!attempt) {
    // First attempt
    attempt = {
      count: 1,
      firstAttempt: now,
      lastAttempt: now
    };
    attempts.set(key, attempt);
    
    return {
      allowed: true,
      attemptsRemaining: config.maxAttempts - 1
    };
  }
  
  // Check if currently blocked
  if (attempt.blockedUntil && now < attempt.blockedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((attempt.blockedUntil - now) / 1000)
    };
  }

  // Block has expired - reset state
  if (attempt.blockedUntil && now >= attempt.blockedUntil) {
    attempt.count = 1;
    attempt.firstAttempt = now;
    attempt.lastAttempt = now;
    delete attempt.blockedUntil;

    return {
      allowed: true,
      attemptsRemaining: config.maxAttempts - 1
    };
  }

  // Check if window has expired
  if (now - attempt.firstAttempt > config.windowMs) {
    // Reset the window
    attempt.count = 1;
    attempt.firstAttempt = now;
    attempt.lastAttempt = now;
    delete attempt.blockedUntil;
    
    return {
      allowed: true,
      attemptsRemaining: config.maxAttempts - 1
    };
  }
  
  // Increment attempt count
  attempt.count++;
  attempt.lastAttempt = now;
  
  if (attempt.count <= config.maxAttempts) {
    return {
      allowed: true,
      attemptsRemaining: config.maxAttempts - attempt.count
    };
  }
  
  // Rate limit exceeded
  let blockDuration = config.blockDurationMs || config.windowMs;
  
  // Progressive delay - increase block time for repeated violations
  if (config.progressiveDelay) {
    const excessAttempts = attempt.count - config.maxAttempts;
    blockDuration = Math.min(
      blockDuration * Math.pow(2, excessAttempts - 1),
      30 * 60 * 1000 // Max 30 minutes
    );
  }
  
  attempt.blockedUntil = now + blockDuration;
  
  return {
    allowed: false,
    retryAfter: Math.ceil(blockDuration / 1000)
  };
}

/**
 * Record a successful authentication (resets the rate limit for this identifier)
 */
export function resetRateLimit(identifier: string): void {
  const key = `auth:${identifier}`;
  attempts.delete(key);
}

/**
 * Get rate limit status without incrementing
 */
export function getRateLimitStatus(
  identifier: string,
  config: RateLimitConfig
): { blocked: boolean; retryAfter?: number; attemptsRemaining?: number } {
  const now = Date.now();
  const key = `auth:${identifier}`;
  
  const attempt = attempts.get(key);
  
  if (!attempt) {
    return {
      blocked: false,
      attemptsRemaining: config.maxAttempts
    };
  }
  
  // Check if currently blocked
  if (attempt.blockedUntil && now < attempt.blockedUntil) {
    return {
      blocked: true,
      retryAfter: Math.ceil((attempt.blockedUntil - now) / 1000)
    };
  }
  
  // Check if window has expired
  if (now - attempt.firstAttempt > config.windowMs) {
    return {
      blocked: false,
      attemptsRemaining: config.maxAttempts
    };
  }
  
  return {
    blocked: attempt.count >= config.maxAttempts,
    attemptsRemaining: Math.max(0, config.maxAttempts - attempt.count)
  };
}

// Predefined rate limit configurations
export const RATE_LIMIT_CONFIGS = {
  LOGIN: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000, // 15 minutes
    blockDurationMs: 15 * 60 * 1000, // 15 minutes
    progressiveDelay: true
  },
  SIGNUP: {
    maxAttempts: 3,
    windowMs: 60 * 60 * 1000, // 1 hour
    blockDurationMs: 60 * 60 * 1000, // 1 hour
    progressiveDelay: false
  },
  PASSWORD_RESET: {
    maxAttempts: 3,
    windowMs: 60 * 60 * 1000, // 1 hour  
    blockDurationMs: 60 * 60 * 1000, // 1 hour
    progressiveDelay: false
  },
  REFRESH: {
    maxAttempts: 10,
    windowMs: 5 * 60 * 1000, // 5 minutes
    blockDurationMs: 5 * 60 * 1000, // 5 minutes
    progressiveDelay: false
  }
} as const;