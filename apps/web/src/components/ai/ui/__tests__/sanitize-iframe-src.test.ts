import { describe, it, expect } from 'vitest';
import { sanitizeIframeSrc } from '../web-preview';

describe('sanitizeIframeSrc', () => {
  describe('given empty or undefined input', () => {
    it('should return empty string for undefined', () => {
      expect(sanitizeIframeSrc(undefined)).toBe('');
    });

    it('should return empty string for empty string', () => {
      expect(sanitizeIframeSrc('')).toBe('');
    });
  });

  describe('given valid URLs with allowed protocols', () => {
    it('should accept https URLs', () => {
      const result = sanitizeIframeSrc('https://example.com/page');
      expect(result).toBe('https://example.com/page');
    });

    it('should accept http URLs', () => {
      const result = sanitizeIframeSrc('http://example.com');
      expect(result).toBe('http://example.com/');
    });

    it('should accept blob URLs', () => {
      const result = sanitizeIframeSrc('blob:http://localhost:3000/abc-123');
      expect(result).toBe('blob:http://localhost:3000/abc-123');
    });

    it('should preserve query parameters and fragments', () => {
      const result = sanitizeIframeSrc('https://example.com/path?q=1&r=2#section');
      expect(result).toBe('https://example.com/path?q=1&r=2#section');
    });
  });

  describe('given dangerous protocols', () => {
    it('should reject javascript: protocol', () => {
      expect(sanitizeIframeSrc('javascript:alert(1)')).toBe('');
    });

    it('should reject data: protocol', () => {
      expect(sanitizeIframeSrc('data:text/html,<script>alert(1)</script>')).toBe('');
    });

    it('should reject vbscript: protocol', () => {
      expect(sanitizeIframeSrc('vbscript:msgbox(1)')).toBe('');
    });
  });

  describe('given relative URLs', () => {
    it('should resolve relative URLs against origin', () => {
      const result = sanitizeIframeSrc('/page/123');
      // jsdom defaults to http://localhost
      expect(result).toContain('/page/123');
      expect(result).toMatch(/^https?:\/\//);
    });
  });

  describe('given malformed URLs', () => {
    it('should return empty string for completely invalid URL', () => {
      // new URL() with a base will resolve most strings, so test with
      // something that actually throws a TypeError
      expect(sanitizeIframeSrc('http://[invalid')).toBe('');
    });
  });
});
