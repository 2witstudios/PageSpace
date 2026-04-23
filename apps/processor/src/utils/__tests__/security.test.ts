import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the underlying lib security module
vi.mock('@pagespace/lib/security/path-validator', () => ({
    resolvePathWithinSync: vi.fn((base: string, ...segs: string[]) => {
    const path = require('path');
    const joined = path.join(base, ...segs);
    if (
      segs.some(s => s.includes('..') || s.includes('\0'))
    ) {
      return null;
    }
    return joined;
  }),
}));
vi.mock('@pagespace/lib/security', () => ({
    validateExternalURL: vi.fn().mockResolvedValue({ valid: true }),
}));

import {
  sanitizeExtension,
  resolvePathWithin,
  normalizeIdentifier,
  sanitizeFilename,
  isDangerousMimeType,
  SAFE_EXTENSION_PATTERN,
  DEFAULT_EXTENSION,
  DEFAULT_IMAGE_EXTENSION,
  IDENTIFIER_PATTERN,
  DANGEROUS_MIME_TYPES,
} from '../security';

describe('sanitizeExtension', () => {
  it('returns .jpg for a file with .jpg extension', () => {
    expect(sanitizeExtension('photo.jpg')).toBe('.jpg');
  });

  it('returns .png for a file with .png extension', () => {
    expect(sanitizeExtension('image.png')).toBe('.png');
  });

  it('returns default .bin for no extension', () => {
    expect(sanitizeExtension('noext')).toBe('.bin');
  });

  it('returns default for null input', () => {
    expect(sanitizeExtension(null)).toBe('.bin');
  });

  it('returns default for undefined input', () => {
    expect(sanitizeExtension(undefined)).toBe('.bin');
  });

  it('returns default for empty string', () => {
    expect(sanitizeExtension('')).toBe('.bin');
  });

  it('returns custom fallback when provided', () => {
    expect(sanitizeExtension('noext', '.txt')).toBe('.txt');
  });

  it('returns default for unsafe extension with dots', () => {
    // Extensions longer than 8 chars are unsafe
    expect(sanitizeExtension('file.verylongext')).toBe('.bin');
  });

  it('normalizes extension to lowercase', () => {
    expect(sanitizeExtension('FILE.JPG')).toBe('.jpg');
  });

  it('returns default for extension with special characters', () => {
    expect(sanitizeExtension('file.ex!e')).toBe('.bin');
  });

  it('handles files with multiple dots', () => {
    // Takes the last extension
    const result = sanitizeExtension('file.tar.gz');
    expect(result).toBe('.gz');
  });
});

describe('resolvePathWithin', () => {
  it('returns resolved path for valid segment', () => {
    const result = resolvePathWithin('/base', 'subdir');
    expect(result).toContain('/base');
    expect(result).toContain('subdir');
  });

  it('returns null for path traversal', () => {
    const result = resolvePathWithin('/base', '../etc/passwd');
    expect(result).toBeNull();
  });

  it('returns null for null byte injection', () => {
    const result = resolvePathWithin('/base', 'file\0.txt');
    expect(result).toBeNull();
  });
});

describe('normalizeIdentifier', () => {
  it('returns trimmed string for valid identifier', () => {
    expect(normalizeIdentifier('abc123')).toBe('abc123');
  });

  it('returns null for non-string input', () => {
    expect(normalizeIdentifier(123)).toBeNull();
    expect(normalizeIdentifier(null)).toBeNull();
    expect(normalizeIdentifier(undefined)).toBeNull();
  });

  it('returns null for string that does not match default pattern', () => {
    expect(normalizeIdentifier('ab')).toBeNull(); // too short (min 3)
    expect(normalizeIdentifier('a'.repeat(65))).toBeNull(); // too long (max 64)
  });

  it('returns null for string with invalid characters', () => {
    expect(normalizeIdentifier('hello world!')).toBeNull();
  });

  it('accepts custom pattern', () => {
    const emailPattern = /^[a-z]+@[a-z]+\.[a-z]+$/;
    expect(normalizeIdentifier('user@example.com', emailPattern)).toBe('user@example.com');
    expect(normalizeIdentifier('notanemail', emailPattern)).toBeNull();
  });

  it('trims whitespace before pattern check', () => {
    // 'abc123' trimmed is 'abc123' which matches
    expect(normalizeIdentifier('  abc123  ')).toBe('abc123');
  });
});

describe('sanitizeFilename', () => {
  it('returns filename unchanged when safe', () => {
    expect(sanitizeFilename('document.pdf')).toBe('document.pdf');
  });

  it('returns "file" for null input', () => {
    expect(sanitizeFilename(null)).toBe('file');
  });

  it('returns "file" for undefined input', () => {
    expect(sanitizeFilename(undefined)).toBe('file');
  });

  it('returns "file" for empty string', () => {
    expect(sanitizeFilename('')).toBe('file');
  });

  it('removes control characters (CRLF injection)', () => {
    const result = sanitizeFilename('file\r\nContent-Disposition: attack');
    expect(result).not.toContain('\r');
    expect(result).not.toContain('\n');
  });

  it('removes quotes', () => {
    const result = sanitizeFilename('file"name"');
    expect(result).not.toContain('"');
  });

  it('removes backslashes', () => {
    const result = sanitizeFilename('file\\name');
    expect(result).not.toContain('\\');
  });

  it('removes semicolons', () => {
    const result = sanitizeFilename('file;name');
    expect(result).not.toContain(';');
  });

  it('normalizes multiple spaces', () => {
    const result = sanitizeFilename('file   name');
    expect(result).toBe('file name');
  });

  it('limits length to 200 characters', () => {
    const longName = 'a'.repeat(300) + '.pdf';
    const result = sanitizeFilename(longName);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('returns "file" when only whitespace remains', () => {
    const result = sanitizeFilename('   ');
    expect(result).toBe('file');
  });

  it('returns "file" when only control chars', () => {
    const result = sanitizeFilename('\x00\x01\x02');
    expect(result).toBe('file');
  });

  it('replaces unicode spaces', () => {
    const result = sanitizeFilename('file\u00A0name');
    expect(result).not.toContain('\u00A0');
  });
});

describe('isDangerousMimeType', () => {
  it('returns true for text/html', () => {
    expect(isDangerousMimeType('text/html')).toBe(true);
  });

  it('returns true for application/xhtml+xml', () => {
    expect(isDangerousMimeType('application/xhtml+xml')).toBe(true);
  });

  it('returns true for image/svg+xml', () => {
    expect(isDangerousMimeType('image/svg+xml')).toBe(true);
  });

  it('returns true for application/xml', () => {
    expect(isDangerousMimeType('application/xml')).toBe(true);
  });

  it('returns true for text/xml', () => {
    expect(isDangerousMimeType('text/xml')).toBe(true);
  });

  it('returns false for image/jpeg', () => {
    expect(isDangerousMimeType('image/jpeg')).toBe(false);
  });

  it('returns false for application/pdf', () => {
    expect(isDangerousMimeType('application/pdf')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isDangerousMimeType(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isDangerousMimeType(undefined)).toBe(false);
  });

  it('handles MIME type with parameters (charset)', () => {
    expect(isDangerousMimeType('text/html; charset=utf-8')).toBe(true);
  });

  it('handles uppercase MIME type', () => {
    expect(isDangerousMimeType('TEXT/HTML')).toBe(true);
  });
});

describe('DANGEROUS_MIME_TYPES constant', () => {
  it('contains expected types', () => {
    expect(DANGEROUS_MIME_TYPES).toContain('text/html');
    expect(DANGEROUS_MIME_TYPES).toContain('image/svg+xml');
  });
});

describe('exported constants', () => {
  it('SAFE_EXTENSION_PATTERN matches valid extensions', () => {
    expect(SAFE_EXTENSION_PATTERN.test('jpg')).toBe(true);
    expect(SAFE_EXTENSION_PATTERN.test('png')).toBe(true);
    expect(SAFE_EXTENSION_PATTERN.test('PDF')).toBe(true);
  });

  it('SAFE_EXTENSION_PATTERN rejects invalid extensions', () => {
    expect(SAFE_EXTENSION_PATTERN.test('')).toBe(false);
    expect(SAFE_EXTENSION_PATTERN.test('verylontext')).toBe(false);
    expect(SAFE_EXTENSION_PATTERN.test('ex!e')).toBe(false);
  });

  it('DEFAULT_EXTENSION is .bin', () => {
    expect(DEFAULT_EXTENSION).toBe('.bin');
  });

  it('DEFAULT_IMAGE_EXTENSION is .png', () => {
    expect(DEFAULT_IMAGE_EXTENSION).toBe('.png');
  });

  it('IDENTIFIER_PATTERN matches valid identifiers', () => {
    expect(IDENTIFIER_PATTERN.test('abc-123')).toBe(true);
    expect(IDENTIFIER_PATTERN.test('abc_123')).toBe(true);
  });
});
