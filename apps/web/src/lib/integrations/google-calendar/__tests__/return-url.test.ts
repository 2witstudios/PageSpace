/**
 * Tests for return-url.ts
 * URL normalization for open redirect prevention.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeGoogleCalendarReturnPath,
  GOOGLE_CALENDAR_DEFAULT_RETURN_PATH,
} from '../return-url';

const DEFAULT = '/settings/integrations/google-calendar';

describe('GOOGLE_CALENDAR_DEFAULT_RETURN_PATH', () => {
  it('should equal the settings integrations path', () => {
    expect(GOOGLE_CALENDAR_DEFAULT_RETURN_PATH).toBe(DEFAULT);
  });
});

describe('normalizeGoogleCalendarReturnPath', () => {
  describe('returns default when input is absent or invalid type', () => {
    it('should return default when called with undefined', () => {
      expect(normalizeGoogleCalendarReturnPath(undefined)).toBe(DEFAULT);
    });

    it('should return default when called with null', () => {
      expect(normalizeGoogleCalendarReturnPath(null)).toBe(DEFAULT);
    });

    it('should return default when called with empty string', () => {
      expect(normalizeGoogleCalendarReturnPath('')).toBe(DEFAULT);
    });

    it('should return default when called with whitespace-only string', () => {
      expect(normalizeGoogleCalendarReturnPath('   ')).toBe(DEFAULT);
    });
  });

  describe('blocks open redirects', () => {
    it('should return default for absolute http URL', () => {
      expect(normalizeGoogleCalendarReturnPath('http://evil.com/steal')).toBe(DEFAULT);
    });

    it('should return default for absolute https URL', () => {
      expect(normalizeGoogleCalendarReturnPath('https://attacker.io')).toBe(DEFAULT);
    });

    it('should return default for protocol-relative URL (//)', () => {
      expect(normalizeGoogleCalendarReturnPath('//evil.com')).toBe(DEFAULT);
    });

    it('should return default for protocol-relative path with slashes', () => {
      expect(normalizeGoogleCalendarReturnPath('//example.com/path')).toBe(DEFAULT);
    });

    it('should return default for URL without leading slash', () => {
      expect(normalizeGoogleCalendarReturnPath('evil.com/path')).toBe(DEFAULT);
    });

    it('should return default for javascript: pseudo-URL', () => {
      expect(normalizeGoogleCalendarReturnPath('javascript:alert(1)')).toBe(DEFAULT);
    });
  });

  describe('allows valid relative paths', () => {
    it('should return the path for a simple relative path', () => {
      expect(normalizeGoogleCalendarReturnPath('/dashboard')).toBe('/dashboard');
    });

    it('should return the path for a nested relative path', () => {
      expect(normalizeGoogleCalendarReturnPath('/settings/profile')).toBe('/settings/profile');
    });

    it('should preserve query parameters in relative paths', () => {
      expect(normalizeGoogleCalendarReturnPath('/search?q=hello')).toBe('/search?q=hello');
    });

    it('should preserve multiple query parameters', () => {
      expect(normalizeGoogleCalendarReturnPath('/page?a=1&b=2')).toBe('/page?a=1&b=2');
    });

    it('should return pathname+search and strip hash fragments', () => {
      // URL parsing strips hash when building pathname+search
      const result = normalizeGoogleCalendarReturnPath('/page#section');
      expect(result).toBe('/page');
    });

    it('should handle the default path itself as input', () => {
      expect(normalizeGoogleCalendarReturnPath(DEFAULT)).toBe(DEFAULT);
    });

    it('should trim whitespace before validating', () => {
      expect(normalizeGoogleCalendarReturnPath('  /dashboard  ')).toBe('/dashboard');
    });
  });
});
