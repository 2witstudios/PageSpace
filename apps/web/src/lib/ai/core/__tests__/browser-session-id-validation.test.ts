import { describe, it, expect } from 'vitest';
import { validateBrowserSessionIdHeader, MAX_BROWSER_SESSION_ID_LENGTH } from '../browser-session-id-validation';

describe('validateBrowserSessionIdHeader', () => {
  describe('rejection', () => {
    it('given a null header, should return ok=false with reason missing', () => {
      const result = validateBrowserSessionIdHeader(null);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('missing');
        expect(result.status).toBe(400);
        expect(result.message).toBe('X-Browser-Session-Id header is required');
      }
    });

    it('given an empty string, should return ok=false with reason missing', () => {
      const result = validateBrowserSessionIdHeader('');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('missing');
    });

    it('given a whitespace-only string, should return ok=false with reason missing', () => {
      const result = validateBrowserSessionIdHeader('   \t\n');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('missing');
    });

    it('given a header longer than the cap, should return ok=false with reason too_long', () => {
      const result = validateBrowserSessionIdHeader('a'.repeat(MAX_BROWSER_SESSION_ID_LENGTH + 1));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('too_long');
        expect(result.status).toBe(400);
        expect(result.message).toBe('X-Browser-Session-Id header exceeds maximum length');
      }
    });

    it('given a header containing control characters, should return ok=false with reason invalid_chars', () => {
      const result = validateBrowserSessionIdHeader('abc\x00def');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_chars');
        expect(result.message).toBe('X-Browser-Session-Id header contains invalid characters');
      }
    });

    it('given a header containing a newline, should return ok=false', () => {
      const result = validateBrowserSessionIdHeader('abc\ndef');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid_chars');
    });
  });

  describe('acceptance', () => {
    it('given a cuid2-style identifier, should return ok=true with the browserSessionId', () => {
      const result = validateBrowserSessionIdHeader('clrx7q8m70000abcdefghij');

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.browserSessionId).toBe('clrx7q8m70000abcdefghij');
    });

    it('given a header at exactly the cap length, should accept', () => {
      const maxId = 'a'.repeat(MAX_BROWSER_SESSION_ID_LENGTH);
      const result = validateBrowserSessionIdHeader(maxId);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.browserSessionId).toBe(maxId);
    });

    it('given a header containing hyphens or underscores, should accept', () => {
      const result = validateBrowserSessionIdHeader('session_id-with-mixed_chars-123');

      expect(result.ok).toBe(true);
    });
  });
});
