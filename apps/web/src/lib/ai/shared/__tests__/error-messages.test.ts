import { describe, it, expect } from 'vitest';
import { getAIErrorMessage, isAuthenticationError, isRateLimitError } from '../error-messages';

describe('error-messages', () => {
  describe('getAIErrorMessage', () => {
    it('should return default message for undefined', () => {
      expect(getAIErrorMessage(undefined)).toBe('Something went wrong. Please try again.');
    });

    it('should return auth message for Unauthorized', () => {
      expect(getAIErrorMessage('Unauthorized access')).toContain('Authentication failed');
    });

    it('should return auth message for 401', () => {
      expect(getAIErrorMessage('HTTP 401 error')).toContain('Authentication failed');
    });

    it('should return rate limit message for rate limit errors', () => {
      expect(getAIErrorMessage('Rate limit exceeded')).toContain('rate limit');
    });

    it('should return rate limit message for 429', () => {
      expect(getAIErrorMessage('HTTP 429')).toContain('rate limit');
    });

    it('should return rate limit message for 402', () => {
      expect(getAIErrorMessage('HTTP 402')).toContain('rate limit');
    });

    it('should return rate limit message for Failed after', () => {
      expect(getAIErrorMessage('Failed after 3 retries')).toContain('rate limit');
    });

    it('should return rate limit message for Provider returned error', () => {
      expect(getAIErrorMessage('Provider returned error')).toContain('rate limit');
    });

    it('should return default message for unknown errors', () => {
      expect(getAIErrorMessage('Something weird happened')).toBe('Something went wrong. Please try again.');
    });
  });

  describe('isAuthenticationError', () => {
    it('should return false for undefined', () => {
      expect(isAuthenticationError(undefined)).toBe(false);
    });

    it('should return true for Unauthorized', () => {
      expect(isAuthenticationError('Unauthorized')).toBe(true);
    });

    it('should return true for 401', () => {
      expect(isAuthenticationError('HTTP 401')).toBe(true);
    });

    it('should return false for other errors', () => {
      expect(isAuthenticationError('Server error')).toBe(false);
    });
  });

  describe('isRateLimitError', () => {
    it('should return false for undefined', () => {
      expect(isRateLimitError(undefined)).toBe(false);
    });

    it('should return true for rate in message', () => {
      expect(isRateLimitError('rate limited')).toBe(true);
    });

    it('should return true for limit in message', () => {
      expect(isRateLimitError('request limit exceeded')).toBe(true);
    });

    it('should return true for 429', () => {
      expect(isRateLimitError('Status 429')).toBe(true);
    });

    it('should return true for 402', () => {
      expect(isRateLimitError('Error 402')).toBe(true);
    });

    it('should return false for other errors', () => {
      expect(isRateLimitError('Network error')).toBe(false);
    });
  });
});
