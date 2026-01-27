import { describe, it, expect } from 'vitest';
import { isValidPreset, isValidContentHash } from '../content-store';

describe('isValidPreset', () => {
  describe('given valid preset names', () => {
    it('should accept alphanumeric presets', () => {
      expect(isValidPreset('thumbnail')).toBe(true);
      expect(isValidPreset('preview')).toBe(true);
      expect(isValidPreset('large')).toBe(true);
    });

    it('should accept presets with hyphens and underscores', () => {
      expect(isValidPreset('ai-chat')).toBe(true);
      expect(isValidPreset('preview_large')).toBe(true);
      expect(isValidPreset('my-preset_v2')).toBe(true);
    });

    it('should accept presets with dots (file extensions)', () => {
      expect(isValidPreset('extracted-text.txt')).toBe(true);
      expect(isValidPreset('ocr-text.txt')).toBe(true);
      expect(isValidPreset('thumbnail.webp')).toBe(true);
      expect(isValidPreset('preview.png')).toBe(true);
    });

    it('should accept single character presets', () => {
      expect(isValidPreset('a')).toBe(true);
      expect(isValidPreset('Z')).toBe(true);
      expect(isValidPreset('0')).toBe(true);
    });

    it('should accept presets at max length (64 chars)', () => {
      expect(isValidPreset('a'.repeat(64))).toBe(true);
    });
  });

  describe('given invalid preset names', () => {
    it('should reject empty string', () => {
      expect(isValidPreset('')).toBe(false);
    });

    it('should reject presets exceeding max length', () => {
      expect(isValidPreset('a'.repeat(65))).toBe(false);
    });

    it('should reject path traversal sequences', () => {
      expect(isValidPreset('../etc')).toBe(false);
      expect(isValidPreset('foo/../bar')).toBe(false);
      expect(isValidPreset('..')).toBe(false);
    });

    it('should reject presets with path separators', () => {
      expect(isValidPreset('foo/bar')).toBe(false);
      expect(isValidPreset('foo\\bar')).toBe(false);
    });

    it('should reject presets with spaces', () => {
      expect(isValidPreset('my preset')).toBe(false);
    });

    it('should reject presets with special characters', () => {
      expect(isValidPreset('preset;rm')).toBe(false);
      expect(isValidPreset('preset$(cmd)')).toBe(false);
      expect(isValidPreset('preset`cmd`')).toBe(false);
    });

    it('should reject non-string inputs', () => {
      expect(isValidPreset(null as unknown as string)).toBe(false);
      expect(isValidPreset(undefined as unknown as string)).toBe(false);
      expect(isValidPreset(123 as unknown as string)).toBe(false);
    });
  });
});

describe('isValidContentHash', () => {
  describe('given valid SHA-256 hashes', () => {
    it('should accept 64-character lowercase hex', () => {
      expect(isValidContentHash('a'.repeat(64))).toBe(true);
      expect(isValidContentHash('0123456789abcdef'.repeat(4))).toBe(true);
    });

    it('should accept uppercase hex', () => {
      expect(isValidContentHash('A'.repeat(64))).toBe(true);
      expect(isValidContentHash('0123456789ABCDEF'.repeat(4))).toBe(true);
    });

    it('should accept mixed case hex', () => {
      expect(isValidContentHash('aAbBcCdDeEfF0011'.repeat(4))).toBe(true);
    });
  });

  describe('given invalid content hashes', () => {
    it('should reject empty string', () => {
      expect(isValidContentHash('')).toBe(false);
    });

    it('should reject wrong length (63 chars)', () => {
      expect(isValidContentHash('a'.repeat(63))).toBe(false);
    });

    it('should reject wrong length (65 chars)', () => {
      expect(isValidContentHash('a'.repeat(65))).toBe(false);
    });

    it('should reject non-hex characters', () => {
      expect(isValidContentHash('g'.repeat(64))).toBe(false);
      expect(isValidContentHash('z'.repeat(64))).toBe(false);
    });

    it('should reject hashes with path separators', () => {
      expect(isValidContentHash('a'.repeat(32) + '/' + 'a'.repeat(31))).toBe(false);
    });

    it('should reject non-string inputs', () => {
      expect(isValidContentHash(null as unknown as string)).toBe(false);
      expect(isValidContentHash(undefined as unknown as string)).toBe(false);
      expect(isValidContentHash(123 as unknown as string)).toBe(false);
    });
  });
});
