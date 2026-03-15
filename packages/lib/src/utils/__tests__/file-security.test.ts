import { describe, it, expect } from 'vitest';
import {
  sanitizeFilenameForHeader,
  isDangerousMimeType,
  getCSPHeaderForFile,
  DANGEROUS_MIME_TYPES,
} from '../file-security';

describe('file-security', () => {
  describe('DANGEROUS_MIME_TYPES', () => {
    it('should contain all expected dangerous types', () => {
      expect(DANGEROUS_MIME_TYPES).toContain('text/html');
      expect(DANGEROUS_MIME_TYPES).toContain('application/xhtml+xml');
      expect(DANGEROUS_MIME_TYPES).toContain('image/svg+xml');
      expect(DANGEROUS_MIME_TYPES).toContain('application/xml');
      expect(DANGEROUS_MIME_TYPES).toContain('text/xml');
    });

    it('should have exactly 5 entries', () => {
      expect(DANGEROUS_MIME_TYPES).toHaveLength(5);
    });
  });

  describe('sanitizeFilenameForHeader', () => {
    it('given null, should return "download"', () => {
      expect(sanitizeFilenameForHeader(null)).toBe('download');
    });

    it('given undefined, should return "download"', () => {
      expect(sanitizeFilenameForHeader(undefined)).toBe('download');
    });

    it('given an empty string, should return "download"', () => {
      expect(sanitizeFilenameForHeader('')).toBe('download');
    });

    it('given a normal filename, should return it unchanged', () => {
      expect(sanitizeFilenameForHeader('report.pdf')).toBe('report.pdf');
    });

    it('given a filename with uppercase and spaces, should preserve them', () => {
      expect(sanitizeFilenameForHeader('My Report 2025.pdf')).toBe('My Report 2025.pdf');
    });

    it('given a filename with CRLF injection attempt, should strip control chars', () => {
      const result = sanitizeFilenameForHeader('file\r\nmalicious.txt');
      expect(result).not.toContain('\r');
      expect(result).not.toContain('\n');
    });

    it('given a filename with embedded null byte, should remove it', () => {
      const result = sanitizeFilenameForHeader('file\x00name.txt');
      expect(result).not.toContain('\x00');
      expect(result).toBe('filename.txt');
    });

    it('given a filename with control characters in 0x7F-0x9F range, should remove them', () => {
      const result = sanitizeFilenameForHeader('file\x80\x9Fname.txt');
      expect(result).toBe('filename.txt');
    });

    it('given a filename with double quotes, should remove them', () => {
      expect(sanitizeFilenameForHeader('fi"le.txt')).toBe('file.txt');
    });

    it('given a filename with single quotes, should remove them', () => {
      expect(sanitizeFilenameForHeader("fi'le.txt")).toBe('file.txt');
    });

    it('given a filename with backticks, should remove them', () => {
      expect(sanitizeFilenameForHeader('fi`le.txt')).toBe('file.txt');
    });

    it('given a filename with backslashes, should remove them', () => {
      expect(sanitizeFilenameForHeader('path\\to\\file.txt')).toBe('pathtofile.txt');
    });

    it('given a filename with semicolons, should remove them', () => {
      expect(sanitizeFilenameForHeader('file;name.txt')).toBe('filename.txt');
    });

    it('given a filename with Unicode non-breaking space (U+00A0), should replace with regular space', () => {
      const result = sanitizeFilenameForHeader('file\u00A0name.txt');
      expect(result).toBe('file name.txt');
    });

    it('given a filename with narrow no-break space (U+202F), should replace with regular space', () => {
      const result = sanitizeFilenameForHeader('file\u202Fname.txt');
      expect(result).toBe('file name.txt');
    });

    it('given a filename with general punctuation spaces (U+2000-U+200B), should replace with regular space', () => {
      const result = sanitizeFilenameForHeader('file\u2003name.txt');
      expect(result).toBe('file name.txt');
    });

    it('given a filename with BOM character (U+FEFF), should replace with regular space and trim', () => {
      const result = sanitizeFilenameForHeader('\uFEFFfile.txt');
      // BOM replaced by space, then trimmed
      expect(result).toBe('file.txt');
    });

    it('given multiple consecutive spaces, should normalize to a single space', () => {
      expect(sanitizeFilenameForHeader('file   name.txt')).toBe('file name.txt');
    });

    it('given leading and trailing whitespace, should trim it', () => {
      expect(sanitizeFilenameForHeader('  report.pdf  ')).toBe('report.pdf');
    });

    it('given a filename longer than 200 characters, should truncate to 200', () => {
      const long = 'a'.repeat(300) + '.txt';
      const result = sanitizeFilenameForHeader(long);
      expect(result.length).toBeLessThanOrEqual(200);
    });

    it('given a filename that is only control characters, should return "download"', () => {
      expect(sanitizeFilenameForHeader('\x00\x01\x1F')).toBe('download');
    });

    it('given a filename that is only quotes and semicolons, should return "download"', () => {
      expect(sanitizeFilenameForHeader('";\'`')).toBe('download');
    });
  });

  describe('isDangerousMimeType', () => {
    it('given null, should return false', () => {
      expect(isDangerousMimeType(null)).toBe(false);
    });

    it('given undefined, should return false', () => {
      expect(isDangerousMimeType(undefined)).toBe(false);
    });

    it('given empty string, should return false', () => {
      expect(isDangerousMimeType('')).toBe(false);
    });

    it('given "text/html", should return true', () => {
      expect(isDangerousMimeType('text/html')).toBe(true);
    });

    it('given "TEXT/HTML" (uppercase), should return true', () => {
      expect(isDangerousMimeType('TEXT/HTML')).toBe(true);
    });

    it('given "application/xhtml+xml", should return true', () => {
      expect(isDangerousMimeType('application/xhtml+xml')).toBe(true);
    });

    it('given "image/svg+xml", should return true', () => {
      expect(isDangerousMimeType('image/svg+xml')).toBe(true);
    });

    it('given "application/xml", should return true', () => {
      expect(isDangerousMimeType('application/xml')).toBe(true);
    });

    it('given "text/xml", should return true', () => {
      expect(isDangerousMimeType('text/xml')).toBe(true);
    });

    it('given "text/html; charset=utf-8" with parameters, should return true', () => {
      expect(isDangerousMimeType('text/html; charset=utf-8')).toBe(true);
    });

    it('given "image/svg+xml;charset=utf-8" without space before params, should return true', () => {
      expect(isDangerousMimeType('image/svg+xml;charset=utf-8')).toBe(true);
    });

    it('given "image/png", should return false', () => {
      expect(isDangerousMimeType('image/png')).toBe(false);
    });

    it('given "application/json", should return false', () => {
      expect(isDangerousMimeType('application/json')).toBe(false);
    });

    it('given "text/plain", should return false', () => {
      expect(isDangerousMimeType('text/plain')).toBe(false);
    });

    it('given "application/pdf", should return false', () => {
      expect(isDangerousMimeType('application/pdf')).toBe(false);
    });

    it('given "video/mp4", should return false', () => {
      expect(isDangerousMimeType('video/mp4')).toBe(false);
    });
  });

  describe('getCSPHeaderForFile', () => {
    it('given a dangerous MIME type, should return the strict CSP with sandbox', () => {
      const csp = getCSPHeaderForFile('text/html');
      expect(csp).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox;");
    });

    it('given "image/svg+xml", should return the strict CSP', () => {
      const csp = getCSPHeaderForFile('image/svg+xml');
      expect(csp).toContain('sandbox');
      expect(csp).toContain("default-src 'none'");
    });

    it('given a safe MIME type, should return the basic restrictive CSP', () => {
      const csp = getCSPHeaderForFile('image/png');
      expect(csp).toBe("default-src 'none';");
    });

    it('given null, should return the basic restrictive CSP', () => {
      const csp = getCSPHeaderForFile(null);
      expect(csp).toBe("default-src 'none';");
    });

    it('given undefined, should return the basic restrictive CSP', () => {
      const csp = getCSPHeaderForFile(undefined);
      expect(csp).toBe("default-src 'none';");
    });

    it('given "application/json", should return the basic restrictive CSP', () => {
      const csp = getCSPHeaderForFile('application/json');
      expect(csp).toBe("default-src 'none';");
    });

    it('given "text/html; charset=utf-8", should return the strict sandbox CSP', () => {
      const csp = getCSPHeaderForFile('text/html; charset=utf-8');
      expect(csp).toContain('sandbox');
    });
  });
});
