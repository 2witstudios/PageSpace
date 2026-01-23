import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCookieValue, getCookieValueFromHeader } from '../get-cookie-value';

describe('get-cookie-value', () => {
  describe('getCookieValue (client-side)', () => {
    const originalDocument = global.document;

    beforeEach(() => {
      // Mock document.cookie for browser environment
      Object.defineProperty(global, 'document', {
        value: { cookie: '' },
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      // Restore original document
      Object.defineProperty(global, 'document', {
        value: originalDocument,
        writable: true,
        configurable: true,
      });
    });

    it('returns null when document is undefined (server-side)', () => {
      Object.defineProperty(global, 'document', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      expect(getCookieValue('test')).toBeNull();
    });

    it('returns null when cookie is not found', () => {
      document.cookie = 'other=value';
      expect(getCookieValue('test')).toBeNull();
    });

    it('extracts simple cookie value', () => {
      document.cookie = 'ps_session=abc123';
      expect(getCookieValue('ps_session')).toBe('abc123');
    });

    it('extracts cookie from multiple cookies', () => {
      document.cookie = 'first=one; ps_session=myToken; last=three';
      expect(getCookieValue('ps_session')).toBe('myToken');
    });

    it('handles cookies with = in the value (JWT tokens)', () => {
      // JWT tokens often contain = characters in their base64 encoding
      const jwtWithEquals = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0=';
      document.cookie = `ps_session=${jwtWithEquals}`;
      expect(getCookieValue('ps_session')).toBe(jwtWithEquals);
    });

    it('handles URL-encoded values', () => {
      document.cookie = 'name=hello%20world';
      expect(getCookieValue('name')).toBe('hello world');
    });

    it('handles cookies with spaces around semicolons', () => {
      document.cookie = 'first=one;   ps_session=token  ; last=three';
      expect(getCookieValue('ps_session')).toBe('token  ');
    });

    it('returns null and does not throw on malformed cookies', () => {
      // This shouldn't throw, just return null if parsing fails
      document.cookie = '%invalid%cookie%value';
      // getCookieValue should handle errors gracefully
      const result = getCookieValue('invalid');
      expect(result).toBeNull();
    });
  });

  describe('getCookieValueFromHeader (server-side)', () => {
    it('returns null when cookieHeader is null', () => {
      expect(getCookieValueFromHeader(null, 'ps_session')).toBeNull();
    });

    it('returns null when cookieHeader is empty string', () => {
      expect(getCookieValueFromHeader('', 'ps_session')).toBeNull();
    });

    it('returns null when cookie is not found', () => {
      expect(getCookieValueFromHeader('other=value', 'ps_session')).toBeNull();
    });

    it('extracts simple cookie value', () => {
      expect(getCookieValueFromHeader('ps_session=abc123', 'ps_session')).toBe('abc123');
    });

    it('extracts cookie from multiple cookies', () => {
      const header = 'first=one; ps_session=myToken; last=three';
      expect(getCookieValueFromHeader(header, 'ps_session')).toBe('myToken');
    });

    it('handles cookies with = in the value (JWT tokens)', () => {
      const jwtWithEquals = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0=';
      const header = `ps_session=${jwtWithEquals}`;
      expect(getCookieValueFromHeader(header, 'ps_session')).toBe(jwtWithEquals);
    });

    it('handles multiple = characters in value', () => {
      const valueWithMultipleEquals = 'data=abc=def=ghi';
      const header = `token=${valueWithMultipleEquals}`;
      // The first = separates name from value, the rest are part of the value
      expect(getCookieValueFromHeader(header, 'token')).toBe('data=abc=def=ghi');
    });

    it('handles URL-encoded values', () => {
      expect(getCookieValueFromHeader('name=hello%20world', 'name')).toBe('hello world');
    });

    it('handles cookies with leading/trailing spaces', () => {
      const header = '  ps_session=token  ';
      expect(getCookieValueFromHeader(header, 'ps_session')).toBe('token  ');
    });

    it('does not match partial cookie names', () => {
      // 'ps_session' should not match 'myAccessToken'
      const header = 'myAccessToken=wrong; ps_session=correct';
      expect(getCookieValueFromHeader(header, 'ps_session')).toBe('correct');
    });

    it('handles empty value correctly', () => {
      expect(getCookieValueFromHeader('token=', 'token')).toBe('');
    });
  });
});
