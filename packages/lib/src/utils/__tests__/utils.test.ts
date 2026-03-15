import { describe, it, expect } from 'vitest';
import { slugify } from '../utils';

describe('utils', () => {
  describe('slugify', () => {
    it('given a simple lowercase string, should return it unchanged', () => {
      expect(slugify('hello')).toBe('hello');
    });

    it('given an uppercase string, should lowercase it', () => {
      expect(slugify('Hello World')).toBe('hello-world');
    });

    it('given a string with spaces, should replace them with hyphens', () => {
      expect(slugify('hello world')).toBe('hello-world');
    });

    it('given multiple consecutive spaces, should produce a single hyphen', () => {
      expect(slugify('hello   world')).toBe('hello-world');
    });

    it('given a string with tabs, should replace them with hyphens', () => {
      expect(slugify('hello\tworld')).toBe('hello-world');
    });

    it('given a string with special characters, should remove them', () => {
      expect(slugify('hello & world!')).toBe('hello-world');
    });

    it('given a string with punctuation, should strip it', () => {
      expect(slugify('foo, bar.')).toBe('foo-bar');
    });

    it('given a string with leading hyphens after processing, should remove them', () => {
      expect(slugify('--hello')).toBe('hello');
    });

    it('given a string with trailing hyphens after processing, should remove them', () => {
      expect(slugify('hello--')).toBe('hello');
    });

    it('given a string with multiple consecutive hyphens, should collapse to one', () => {
      expect(slugify('hello---world')).toBe('hello-world');
    });

    it('given a string with numbers, should preserve them', () => {
      expect(slugify('chapter 1')).toBe('chapter-1');
    });

    it('given a string that is all special chars, should return empty string', () => {
      expect(slugify('!@#$%')).toBe('');
    });

    it('given an empty string, should return an empty string', () => {
      expect(slugify('')).toBe('');
    });

    it('given a string with underscores, should preserve them (word chars)', () => {
      expect(slugify('hello_world')).toBe('hello_world');
    });

    it('given a mixed case string with dashes and spaces, should normalize fully', () => {
      expect(slugify('  My Page Title -- 2025  ')).toBe('my-page-title-2025');
    });

    it('given a string with accented characters, should strip them (non-word)', () => {
      // Non-ASCII letters are removed by the [^\w-]+ regex
      expect(slugify('café')).toBe('caf');
    });

    it('given a number value coerced to string via toString, should work', () => {
      // slugify calls .toString() internally, so passing a number-like string is valid
      expect(slugify('42')).toBe('42');
    });

    it('given a string with only spaces, should return empty string', () => {
      expect(slugify('   ')).toBe('');
    });

    it('given a single word, should return it as-is in lowercase', () => {
      expect(slugify('TYPESCRIPT')).toBe('typescript');
    });
  });
});
