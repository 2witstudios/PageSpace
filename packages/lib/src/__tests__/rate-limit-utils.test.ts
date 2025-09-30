import { describe, it, expect, beforeEach, vi } from 'vitest'
import { checkRateLimit, resetRateLimit, getRateLimitStatus, RATE_LIMIT_CONFIGS } from '../rate-limit-utils'

describe('rate-limit-utils', () => {
  beforeEach(() => {
    // Clear rate limit cache by resetting for all test identifiers
    resetRateLimit('test-user-1')
    resetRateLimit('test-user-2')
    resetRateLimit('test-user-3')
  })

  describe('checkRateLimit', () => {
    it('allows requests within limit', () => {
      const identifier = 'test-user-1'
      const config = { maxAttempts: 10, windowMs: 60000 }

      const result1 = checkRateLimit(identifier, config)
      expect(result1.allowed).toBe(true)
      expect(result1.attemptsRemaining).toBe(9)

      const result2 = checkRateLimit(identifier, config)
      expect(result2.allowed).toBe(true)
      expect(result2.attemptsRemaining).toBe(8)
    })

    it('blocks requests when limit exceeded', () => {
      const identifier = 'test-user-2'
      const config = { maxAttempts: 3, windowMs: 60000 }

      // Make requests up to limit
      checkRateLimit(identifier, config)
      checkRateLimit(identifier, config)
      checkRateLimit(identifier, config)

      // Next request should be blocked
      const result = checkRateLimit(identifier, config)
      expect(result.allowed).toBe(false)
      expect(result.retryAfter).toBeGreaterThan(0)
    })

    it('resets after time window', async () => {
      const identifier = 'test-user-3'
      const config = { maxAttempts: 2, windowMs: 100 } // 100ms window

      checkRateLimit(identifier, config)
      checkRateLimit(identifier, config)

      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 150))

      // Should work again
      const result = checkRateLimit(identifier, config)
      expect(result.allowed).toBe(true)
      expect(result.attemptsRemaining).toBe(1)
    })

    it('uses separate limits for different identifiers', () => {
      const user1 = 'user-a'
      const user2 = 'user-b'
      const config = { maxAttempts: 2, windowMs: 60000 }

      checkRateLimit(user1, config)
      checkRateLimit(user1, config)

      // user1 should be at limit
      const result1 = checkRateLimit(user1, config)
      expect(result1.allowed).toBe(false)

      // user2 should still have full quota
      const result2 = checkRateLimit(user2, config)
      expect(result2.allowed).toBe(true)
      expect(result2.attemptsRemaining).toBe(1)
    })

    it('implements progressive delay when enabled', () => {
      const identifier = 'progressive-test'
      const config = {
        maxAttempts: 2,
        windowMs: 60000,
        blockDurationMs: 1000,
        progressiveDelay: true
      }

      // Exceed limit
      checkRateLimit(identifier, config)
      checkRateLimit(identifier, config)

      const result1 = checkRateLimit(identifier, config) // 1st violation
      expect(result1.allowed).toBe(false)

      const result2 = checkRateLimit(identifier, config) // 2nd violation
      expect(result2.allowed).toBe(false)
      // Delay should increase with each violation
    })

    it('uses custom block duration when specified', () => {
      const identifier = 'block-duration-test'
      const config = {
        maxAttempts: 1,
        windowMs: 60000,
        blockDurationMs: 5000 // 5 seconds
      }

      checkRateLimit(identifier, config)

      const result = checkRateLimit(identifier, config)
      expect(result.allowed).toBe(false)
      expect(result.retryAfter).toBeLessThanOrEqual(5)
      expect(result.retryAfter).toBeGreaterThan(0)
    })

    it('respects block duration', async () => {
      const identifier = 'block-test'
      const config = {
        maxAttempts: 1,
        windowMs: 60000,
        blockDurationMs: 100 // 100ms block
      }

      checkRateLimit(identifier, config)
      checkRateLimit(identifier, config) // Blocked

      // Wait for block to expire
      await new Promise(resolve => setTimeout(resolve, 150))

      // Should be allowed again
      const result = checkRateLimit(identifier, config)
      expect(result.allowed).toBe(true)
    })
  })

  describe('resetRateLimit', () => {
    it('clears rate limit for identifier', () => {
      const identifier = 'reset-test'
      const config = { maxAttempts: 2, windowMs: 60000 }

      checkRateLimit(identifier, config)
      checkRateLimit(identifier, config)
      checkRateLimit(identifier, config) // Should be blocked

      resetRateLimit(identifier)

      // Should work again immediately
      const result = checkRateLimit(identifier, config)
      expect(result.allowed).toBe(true)
      expect(result.attemptsRemaining).toBe(1)
    })

    it('does not affect other identifiers', () => {
      const user1 = 'reset-test-1'
      const user2 = 'reset-test-2'
      const config = { maxAttempts: 2, windowMs: 60000 }

      checkRateLimit(user1, config)
      checkRateLimit(user1, config)
      checkRateLimit(user2, config)
      checkRateLimit(user2, config)

      resetRateLimit(user1)

      // user1 should be reset
      const result1 = checkRateLimit(user1, config)
      expect(result1.allowed).toBe(true)

      // user2 should still be at limit
      const result2 = checkRateLimit(user2, config)
      expect(result2.allowed).toBe(false)
    })
  })

  describe('getRateLimitStatus', () => {
    it('returns status without incrementing counter', () => {
      const identifier = 'status-test'
      const config = { maxAttempts: 5, windowMs: 60000 }

      // Check status multiple times
      const status1 = getRateLimitStatus(identifier, config)
      expect(status1.blocked).toBe(false)
      expect(status1.attemptsRemaining).toBe(5)

      const status2 = getRateLimitStatus(identifier, config)
      expect(status2.blocked).toBe(false)
      expect(status2.attemptsRemaining).toBe(5)

      // Counter should not have changed
      const check = checkRateLimit(identifier, config)
      expect(check.attemptsRemaining).toBe(4) // First actual attempt
    })

    it('correctly reports blocked status', () => {
      const identifier = 'blocked-status-test'
      const config = { maxAttempts: 1, windowMs: 60000 }

      checkRateLimit(identifier, config)
      checkRateLimit(identifier, config) // Blocked

      const status = getRateLimitStatus(identifier, config)
      expect(status.blocked).toBe(true)
      expect(status.retryAfter).toBeGreaterThan(0)
    })
  })

  describe('predefined configurations', () => {
    it('LOGIN config has reasonable limits', () => {
      expect(RATE_LIMIT_CONFIGS.LOGIN.maxAttempts).toBe(5)
      expect(RATE_LIMIT_CONFIGS.LOGIN.windowMs).toBe(15 * 60 * 1000)
      expect(RATE_LIMIT_CONFIGS.LOGIN.progressiveDelay).toBe(true)
    })

    it('SIGNUP config has stricter limits', () => {
      expect(RATE_LIMIT_CONFIGS.SIGNUP.maxAttempts).toBe(3)
      expect(RATE_LIMIT_CONFIGS.SIGNUP.windowMs).toBe(60 * 60 * 1000)
    })

    it('REFRESH config allows more attempts for short window', () => {
      expect(RATE_LIMIT_CONFIGS.REFRESH.maxAttempts).toBe(10)
      expect(RATE_LIMIT_CONFIGS.REFRESH.windowMs).toBe(5 * 60 * 1000)
    })
  })
})