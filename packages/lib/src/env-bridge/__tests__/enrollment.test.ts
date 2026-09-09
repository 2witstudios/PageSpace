import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  issueEnrollmentCode,
  verifyEnrollmentCode,
  normalizeEnrollmentCode,
  ENROLLMENT_CODE_LENGTH,
  ENROLLMENT_CODE_ALPHABET,
  ENROLLMENT_CODE_TTL_MS,
  type RandomBytes,
} from '../enrollment';
import type { HashBytes } from '../grant';

// Real primitives, INJECTED — the module never touches node:crypto or a clock.
const hash: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const random: RandomBytes = (length) => new Uint8Array(randomBytes(length));
const NOW = 1_800_000_000_000;

/** A code whose every symbol is decided by the injected bytes. */
const fixedRandom =
  (byte: number): RandomBytes =>
  (length) =>
    new Uint8Array(length).fill(byte);

function issued(overrides: Partial<Parameters<typeof issueEnrollmentCode>[0]> = {}) {
  return issueEnrollmentCode({ random, hash, now: NOW, ...overrides });
}

function verify(presented: unknown, code = issued(), overrides: Partial<Parameters<typeof verifyEnrollmentCode>[0]> = {}) {
  return verifyEnrollmentCode({ presented, storedHash: code.codeHash, exp: code.exp, usedAt: null, now: NOW, hash, ...overrides });
}

describe('issueEnrollmentCode — the one-time code a user hands to their machine', () => {
  it('given injected randomness, should produce a code of the fixed length drawn only from the unambiguous alphabet, its hash, and an expiry = now + TTL', () => {
    const code = issued();
    expect(code.code).toHaveLength(ENROLLMENT_CODE_LENGTH);
    for (const symbol of code.code) expect(ENROLLMENT_CODE_ALPHABET).toContain(symbol);
    expect(code.codeHash).toBe(hash(new TextEncoder().encode(code.code)));
    expect(code.exp).toBe(NOW + ENROLLMENT_CODE_TTL_MS);
  });

  it('given a caller-chosen TTL, should honour it', () => {
    expect(issued({ ttlMs: 5_000 }).exp).toBe(NOW + 5_000);
  });

  it('should derive every symbol from the injected bytes — same bytes, same code; the module has no randomness of its own', () => {
    expect(issued({ random: fixedRandom(0) }).code).toBe(issued({ random: fixedRandom(0) }).code);
    expect(issued({ random: fixedRandom(0) }).code).not.toBe(issued({ random: fixedRandom(1) }).code);
  });

  it('should never contain the symbols the alphabet excludes as ambiguous (I, L, O, U)', () => {
    for (let i = 0; i < 50; i += 1) expect(issued().code).not.toMatch(/[ILOU]/);
  });
});

describe('normalizeEnrollmentCode — what a human typed vs what was issued', () => {
  it('should uppercase, drop separators, and fold the Crockford look-alikes (i/l → 1, o → 0)', () => {
    expect(normalizeEnrollmentCode(' abcd-efgh 1o2i ')).toBe('ABCDEFGH1021');
    expect(normalizeEnrollmentCode('ab-cl')).toBe('ABC1');
  });

  it('given a non-string, should return null', () => {
    expect(normalizeEnrollmentCode(42)).toBeNull();
    expect(normalizeEnrollmentCode(null)).toBeNull();
  });
});

describe('verifyEnrollmentCode — single use, short-lived, timing-safe', () => {
  it('given the issued code presented before expiry and unused, should return ok', () => {
    const code = issued();
    expect(verify(code.code, code)).toEqual({ ok: true });
  });

  it('given the code typed in lower case with separators, should still match (normalization happens before hashing)', () => {
    const code = issued();
    const typed = `${code.code.slice(0, 5).toLowerCase()}-${code.code.slice(5)}`;
    expect(verify(typed, code)).toEqual({ ok: true });
  });

  it('given a wrong code, should return mismatch', () => {
    const code = issued();
    const wrong = `${code.code.slice(0, -1)}${code.code.endsWith('A') ? 'B' : 'A'}`;
    expect(verify(wrong, code)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('given a code of the wrong length or with symbols outside the alphabet, should return malformed WITHOUT hashing', () => {
    let hashed = 0;
    const counting: HashBytes = (bytes) => {
      hashed += 1;
      return hash(bytes);
    };
    expect(verify('SHORT', issued(), { hash: counting })).toEqual({ ok: false, reason: 'malformed' });
    expect(verify(`${'A'.repeat(ENROLLMENT_CODE_LENGTH - 1)}U`, issued(), { hash: counting })).toEqual({ ok: false, reason: 'malformed' });
    expect(verify(undefined, issued(), { hash: counting })).toEqual({ ok: false, reason: 'malformed' });
    expect(hashed).toBe(0);
  });

  it('given a code already used, should return used — a second presentation never enrolls again', () => {
    const code = issued();
    expect(verify(code.code, code, { usedAt: NOW - 1 })).toEqual({ ok: false, reason: 'used' });
  });

  it('given a code past its expiry, should return expired', () => {
    const code = issued();
    expect(verify(code.code, code, { now: code.exp + 1 })).toEqual({ ok: false, reason: 'expired' });
    expect(verify(code.code, code, { now: code.exp })).toEqual({ ok: true });
  });

  it('given a WRONG code against a used or expired entry, should say mismatch — the entry\'s state is disclosed only to whoever holds the right code', () => {
    const code = issued();
    const wrong = `${code.code.slice(0, -1)}${code.code.endsWith('A') ? 'B' : 'A'}`;
    expect(verify(wrong, code, { usedAt: NOW - 1 })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verify(wrong, code, { now: code.exp + 1 })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('given a used AND expired entry with the right code, should say used (the more specific fact)', () => {
    const code = issued();
    expect(verify(code.code, code, { usedAt: NOW - 1, now: code.exp + 1 })).toEqual({ ok: false, reason: 'used' });
  });
});
