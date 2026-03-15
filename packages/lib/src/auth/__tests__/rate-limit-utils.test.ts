import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, resetRateLimit, getRateLimitStatus, RATE_LIMIT_CONFIGS } from '../rate-limit-utils';

describe('rate-limit-utils', () => {
  beforeEach(() => {
    // Reset all rate limits between tests
    resetRateLimit('test-user');
    resetRateLimit('test-user-2');
    resetRateLimit('progressive-user');
    resetRateLimit('status-user');
    resetRateLimit('block-user');
    resetRateLimit('window-user');
  });

  describe('checkRateLimit', () => {
    const config = { maxAttempts: 3, windowMs: 60000 };

    it('should allow first attempt', () => {
      const result = checkRateLimit('test-user', config);
      expect(result.allowed).toBe(true);
      expect(result.attemptsRemaining).toBe(2);
    });

    it('should allow attempts within limit', () => {
      checkRateLimit('test-user', config);
      checkRateLimit('test-user', config);
      const result = checkRateLimit('test-user', config);
      expect(result.allowed).toBe(true);
      expect(result.attemptsRemaining).toBe(0);
    });

    it('should block when limit exceeded', () => {
      for (let i = 0; i < 3; i++) checkRateLimit('test-user', config);
      const result = checkRateLimit('test-user', config);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should return blocked status when currently blocked', () => {
      const blockConfig = { maxAttempts: 1, windowMs: 60000, blockDurationMs: 5000 };
      checkRateLimit('block-user', blockConfig);
      checkRateLimit('block-user', blockConfig); // exceeds limit
      const result = checkRateLimit('block-user', blockConfig);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should use progressive delay when configured', () => {
      const progressiveConfig = {
        maxAttempts: 2,
        windowMs: 60000,
        blockDurationMs: 1000,
        progressiveDelay: true,
      };
      checkRateLimit('progressive-user', progressiveConfig);
      checkRateLimit('progressive-user', progressiveConfig);
      // First excess
      const r1 = checkRateLimit('progressive-user', progressiveConfig);
      expect(r1.allowed).toBe(false);
      expect(r1.retryAfter).toBe(1); // 1000ms / 1000 = 1s
    });

    it('should cap progressive delay at 30 minutes', () => {
      const progressiveConfig = {
        maxAttempts: 1,
        windowMs: 60000,
        blockDurationMs: 60000,
        progressiveDelay: true,
      };
      checkRateLimit('progressive-user', progressiveConfig);
      // Many excess attempts to trigger high delay
      for (let i = 0; i < 30; i++) {
        checkRateLimit('progressive-user', progressiveConfig);
      }
      const result = checkRateLimit('progressive-user', progressiveConfig);
      expect(result.retryAfter).toBeLessThanOrEqual(1800); // 30 min
    });
  });

  describe('resetRateLimit', () => {
    it('should clear rate limit for identifier', () => {
      const config = { maxAttempts: 1, windowMs: 60000 };
      checkRateLimit('test-user', config);
      checkRateLimit('test-user', config); // blocked

      resetRateLimit('test-user');

      const result = checkRateLimit('test-user', config);
      expect(result.allowed).toBe(true);
    });
  });

  describe('getRateLimitStatus', () => {
    const config = { maxAttempts: 3, windowMs: 60000 };

    it('should return unblocked for unknown identifier', () => {
      const status = getRateLimitStatus('status-user', config);
      expect(status.blocked).toBe(false);
      expect(status.attemptsRemaining).toBe(3);
    });

    it('should report remaining attempts', () => {
      checkRateLimit('status-user', config);
      checkRateLimit('status-user', config);
      const status = getRateLimitStatus('status-user', config);
      expect(status.blocked).toBe(false);
      expect(status.attemptsRemaining).toBe(1);
    });

    it('should report blocked when limit reached', () => {
      for (let i = 0; i < 3; i++) checkRateLimit('status-user', config);
      checkRateLimit('status-user', config); // triggers block
      const status = getRateLimitStatus('status-user', config);
      expect(status.blocked).toBe(true);
      expect(status.retryAfter).toBeGreaterThan(0);
    });

    it('should report unblocked when window expired', async () => {
      const shortConfig = { maxAttempts: 1, windowMs: 50 };
      checkRateLimit('window-user', shortConfig);
      // Wait for window to expire
      await new Promise(r => setTimeout(r, 100));
      const status = getRateLimitStatus('window-user', shortConfig);
      expect(status.blocked).toBe(false);
      expect(status.attemptsRemaining).toBe(1);
    });

    it('should return blocked=true when count >= maxAttempts', () => {
      // Fill up exactly to the limit (3 attempts)
      for (let i = 0; i < 3; i++) checkRateLimit('status-user', config);
      // Status should report blocked (at limit)
      const status = getRateLimitStatus('status-user', config);
      expect(status.blocked).toBe(true);
      expect(status.attemptsRemaining).toBe(0);
    });
  });

  describe('RATE_LIMIT_CONFIGS', () => {
    it('should have LOGIN config with progressive delay', () => {
      expect(RATE_LIMIT_CONFIGS.LOGIN.maxAttempts).toBe(5);
      expect(RATE_LIMIT_CONFIGS.LOGIN.progressiveDelay).toBe(true);
    });

    it('should have SIGNUP config', () => {
      expect(RATE_LIMIT_CONFIGS.SIGNUP.maxAttempts).toBe(3);
    });

    it('should have PASSWORD_RESET config', () => {
      expect(RATE_LIMIT_CONFIGS.PASSWORD_RESET.maxAttempts).toBe(3);
    });

    it('should have REFRESH config', () => {
      expect(RATE_LIMIT_CONFIGS.REFRESH.maxAttempts).toBe(10);
    });
  });

  describe('block expiry', () => {
    it('should allow requests after block expires', async () => {
      const config = { maxAttempts: 1, windowMs: 60000, blockDurationMs: 50 };
      checkRateLimit('block-user', config);
      checkRateLimit('block-user', config); // triggers block

      await new Promise(r => setTimeout(r, 100));

      const result = checkRateLimit('block-user', config);
      expect(result.allowed).toBe(true);
      expect(result.attemptsRemaining).toBe(0); // reset to 1 then used = 0 remaining
    });
  });

  describe('window expiry', () => {
    it('should reset count after window expires', async () => {
      const config = { maxAttempts: 2, windowMs: 50 };
      checkRateLimit('window-user', config);
      checkRateLimit('window-user', config);

      await new Promise(r => setTimeout(r, 100));

      const result = checkRateLimit('window-user', config);
      expect(result.allowed).toBe(true);
      expect(result.attemptsRemaining).toBe(1);
    });
  });
});
