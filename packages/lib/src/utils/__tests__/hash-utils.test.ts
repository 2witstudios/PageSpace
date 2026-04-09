import { describe, it, expect } from 'vitest';
import { hashString, hashObject, hashWithPrefix } from '../hash-utils';

describe('hash-utils', () => {
  describe('hashString', () => {
    it('should return a 64-character hex string for a simple input', () => {
      const result = hashString('hello');
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should return a consistent SHA-256 hash for a known value', () => {
      // SHA-256 of "hello" is well-known
      expect(hashString('hello')).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
      );
    });

    it('should return the same hash for the same input called twice', () => {
      expect(hashString('consistent')).toBe(hashString('consistent'));
    });

    it('should return different hashes for different inputs', () => {
      expect(hashString('foo')).not.toBe(hashString('bar'));
    });

    it('should handle an empty string', () => {
      const result = hashString('');
      expect(result).toMatch(/^[0-9a-f]{64}$/);
      // SHA-256 of "" is well-known
      expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('should handle a string with unicode characters', () => {
      const result = hashString('hello 世界');
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('hashObject', () => {
    it('should return a consistent hash for a simple object', () => {
      const result = hashObject({ a: 1, b: 2 });
      expect(result).toMatch(/^[0-9a-f]{64}$/);
      expect(hashObject({ a: 1, b: 2 })).toBe(result);
    });

    it('should produce the same hash regardless of key insertion order', () => {
      const hash1 = hashObject({ a: 1, b: 2 });
      const hash2 = hashObject({ b: 2, a: 1 });
      expect(hash1).toBe(hash2);
    });

    it('should treat null and undefined the same way', () => {
      expect(hashObject(null)).toBe(hashObject(undefined));
    });

    it('should hash null to the same value as undefined', () => {
      const nullHash = hashObject(null);
      const undefinedHash = hashObject(undefined);
      expect(nullHash).toBe(undefinedHash);
    });

    it('given a string primitive, should hash it', () => {
      const result = hashObject('hello');
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('given a number primitive, should hash it', () => {
      const result = hashObject(42);
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('given a boolean primitive, should hash it', () => {
      expect(hashObject(true)).toMatch(/^[0-9a-f]{64}$/);
      expect(hashObject(false)).toMatch(/^[0-9a-f]{64}$/);
      expect(hashObject(true)).not.toBe(hashObject(false));
    });

    it('given an array, should hash it consistently', () => {
      expect(hashObject([1, 2, 3])).toBe(hashObject([1, 2, 3]));
    });

    it('given arrays with different order, should produce different hashes', () => {
      // Arrays are ordered, so [1,2] != [2,1]
      expect(hashObject([1, 2])).not.toBe(hashObject([2, 1]));
    });

    it('given a nested object, should hash it consistently', () => {
      const obj = { outer: { inner: 'value' }, count: 3 };
      expect(hashObject(obj)).toBe(hashObject(obj));
    });

    it('given nested objects with swapped key order, should produce the same hash', () => {
      const hash1 = hashObject({ x: { b: 2, a: 1 }, y: 0 });
      const hash2 = hashObject({ y: 0, x: { a: 1, b: 2 } });
      expect(hash1).toBe(hash2);
    });

    it('given objects with null values in fields, should hash them', () => {
      const result = hashObject({ key: null });
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('given an array containing null, should hash it', () => {
      const result = hashObject([null, 1, 'x']);
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce different hashes for objects with different values', () => {
      expect(hashObject({ a: 1 })).not.toBe(hashObject({ a: 2 }));
    });
  });

  describe('hashWithPrefix', () => {
    it('should return a 64-character hex string', () => {
      const result = hashWithPrefix('user', 'abc123');
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should return consistent results for the same prefix and value', () => {
      expect(hashWithPrefix('session', 'token-value')).toBe(
        hashWithPrefix('session', 'token-value')
      );
    });

    it('should produce different hashes for different prefixes with the same value', () => {
      const h1 = hashWithPrefix('user', 'abc');
      const h2 = hashWithPrefix('admin', 'abc');
      expect(h1).not.toBe(h2);
    });

    it('should produce different hashes for the same prefix with different values', () => {
      const h1 = hashWithPrefix('user', 'abc');
      const h2 = hashWithPrefix('user', 'xyz');
      expect(h1).not.toBe(h2);
    });

    it('should use a null byte separator so "ab"+"cd" differs from "a"+"bcd"', () => {
      // The separator prevents prefix="ab", value="cd" from colliding with
      // prefix="a", value="bcd" — since both without separator are "abcd".
      const h1 = hashWithPrefix('ab', 'cd');
      const h2 = hashWithPrefix('a', 'bcd');
      expect(h1).not.toBe(h2);
    });

    it('should handle empty prefix', () => {
      const result = hashWithPrefix('', 'value');
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should handle empty value', () => {
      const result = hashWithPrefix('prefix', '');
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should handle both empty prefix and value', () => {
      const result = hashWithPrefix('', '');
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
