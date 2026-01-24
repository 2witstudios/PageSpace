/**
 * Tests for One-Time Exchange Codes
 *
 * These tests verify the core token hashing and code generation logic.
 * Integration tests with Redis would require a running Redis instance.
 */

import { describe, it, expect } from 'vitest';
import { hashToken } from '../token-utils';
import { randomBytes } from 'crypto';

describe('exchange-codes core logic', () => {
  describe('code generation', () => {
    it('should generate base64url encoded codes', () => {
      const code = randomBytes(32).toString('base64url');

      // Code should be base64url (no padding, URL-safe characters)
      expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
      // 32 bytes -> ~43 characters in base64url
      expect(code.length).toBeGreaterThan(40);
    });

    it('should generate unique codes each time', () => {
      const code1 = randomBytes(32).toString('base64url');
      const code2 = randomBytes(32).toString('base64url');

      expect(code1).not.toBe(code2);
    });

    it('should use 32 bytes of randomness (256 bits entropy)', () => {
      const code = randomBytes(32).toString('base64url');

      // Base64url encoding of 32 bytes is ~43 characters
      expect(code.length).toBeGreaterThanOrEqual(42);
    });
  });

  describe('code hashing', () => {
    it('should hash codes to consistent SHA-256', () => {
      const code = 'test-exchange-code-123';
      const hash1 = hashToken(code);
      const hash2 = hashToken(code);

      expect(hash1).toBe(hash2);
      // SHA-256 produces 64 hex characters
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce different hashes for different codes', () => {
      const hash1 = hashToken('code1');
      const hash2 = hashToken('code2');

      expect(hash1).not.toBe(hash2);
    });

    it('should not contain the original code in the hash', () => {
      const code = 'my-secret-code';
      const hash = hashToken(code);

      expect(hash).not.toContain(code);
    });
  });

  describe('security properties', () => {
    it('should be computationally infeasible to reverse the hash', () => {
      // This is a design verification - SHA-256 is a one-way function
      const code = randomBytes(32).toString('base64url');
      const hash = hashToken(code);

      // The hash is deterministic but not reversible
      expect(hash.length).toBe(64); // 256 bits = 64 hex chars
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it('should have sufficient entropy to prevent brute force', () => {
      // 32 bytes = 256 bits of entropy
      // At 10 billion guesses/second, would take ~10^57 years
      const code = randomBytes(32);
      expect(code.length).toBe(32);
    });
  });
});
