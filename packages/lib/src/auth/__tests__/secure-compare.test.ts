import { describe, it, expect } from 'vitest';
import { secureCompare } from '../secure-compare';

/**
 * secureCompare is the pure timing-safe comparison primitive used to validate
 * shared secrets (SERVICE_API_SECRET, INTERNAL_API_SECRET, device tokens, ...).
 *
 * It hashes both inputs with SHA-256 and compares the digests with
 * crypto.timingSafeEqual, so the comparison time does not leak the length or
 * prefix structure of the secret. These tests pin the security-relevant
 * contract: equal -> true, anything else -> false, and non-string / empty
 * inputs never accidentally authenticate.
 */
describe('secureCompare', () => {
  it('returns true for identical strings', () => {
    expect(secureCompare('s3cr3t-value', 's3cr3t-value')).toBe(true);
  });

  it('returns false for strings that differ', () => {
    expect(secureCompare('s3cr3t-value', 's3cr3t-valuf')).toBe(false);
  });

  it('returns false when one string is a prefix of the other (no length leak)', () => {
    expect(secureCompare('secret', 'secret-extra')).toBe(false);
    expect(secureCompare('secret-extra', 'secret')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    // Empty == empty is structurally true; callers MUST fail-closed BEFORE
    // calling secureCompare when the configured secret is empty/unset.
    expect(secureCompare('', '')).toBe(true);
  });

  it('returns false when comparing a non-empty value against an empty string', () => {
    expect(secureCompare('something', '')).toBe(false);
    expect(secureCompare('', 'something')).toBe(false);
  });

  it('returns false when either input is not a string (undefined env secret)', () => {
    // process.env.X is `string | undefined`; an undefined secret must never match.
    expect(secureCompare('value', undefined as unknown as string)).toBe(false);
    expect(secureCompare(undefined as unknown as string, 'value')).toBe(false);
    expect(secureCompare(undefined as unknown as string, undefined as unknown as string)).toBe(false);
    expect(secureCompare('value', null as unknown as string)).toBe(false);
  });

  it('is case sensitive', () => {
    expect(secureCompare('Secret', 'secret')).toBe(false);
  });
});
