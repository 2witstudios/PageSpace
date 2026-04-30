import { describe, it, expect } from 'vitest';
import { validateTabIdHeader, MAX_TAB_ID_LENGTH } from '../tab-id-validation';

describe('validateTabIdHeader', () => {
  describe('rejection', () => {
    it('given a null header, should return ok=false with reason missing', () => {
      const result = validateTabIdHeader(null);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('missing');
        expect(result.status).toBe(400);
      }
    });

    it('given an empty string, should return ok=false with reason missing', () => {
      const result = validateTabIdHeader('');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('missing');
    });

    it('given a whitespace-only string, should return ok=false with reason missing', () => {
      const result = validateTabIdHeader('   \t\n');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('missing');
    });

    it('given a header longer than the cap, should return ok=false with reason too_long', () => {
      const result = validateTabIdHeader('a'.repeat(MAX_TAB_ID_LENGTH + 1));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('too_long');
        expect(result.status).toBe(400);
      }
    });

    it('given a header containing control characters, should return ok=false', () => {
      const result = validateTabIdHeader('abc\x00def');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid_chars');
    });

    it('given a header containing a newline, should return ok=false', () => {
      const result = validateTabIdHeader('abc\ndef');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid_chars');
    });
  });

  describe('acceptance', () => {
    it('given a cuid2-style identifier, should return ok=true with the tabId', () => {
      const result = validateTabIdHeader('clrx7q8m70000abcdefghij');

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.tabId).toBe('clrx7q8m70000abcdefghij');
    });

    it('given a header at exactly the cap length, should accept', () => {
      const maxId = 'a'.repeat(MAX_TAB_ID_LENGTH);
      const result = validateTabIdHeader(maxId);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.tabId).toBe(maxId);
    });

    it('given a header containing hyphens or underscores, should accept', () => {
      const result = validateTabIdHeader('tab_id-with-mixed_chars-123');

      expect(result.ok).toBe(true);
    });
  });
});
