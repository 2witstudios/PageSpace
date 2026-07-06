/**
 * User-code generation + normalization (task mwexjazwha2uhw5bmvc9a7kw).
 * Pure functions: randomness injected, no clock, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { generateUserCode, normalizeUserCode, USER_CODE_ALPHABET } from '../user-code';

function fixedBytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe('USER_CODE_ALPHABET', () => {
  it('is exactly 32 characters (unbiased byte % 32 mapping)', () => {
    expect(USER_CODE_ALPHABET.length).toBe(32);
  });

  it('excludes the ambiguous characters 0, O, 1, I', () => {
    for (const ambiguous of ['0', 'O', '1', 'I']) {
      expect(USER_CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('has no duplicate characters', () => {
    expect(new Set(USER_CODE_ALPHABET).size).toBe(USER_CODE_ALPHABET.length);
  });
});

describe('generateUserCode', () => {
  it('requests exactly 8 bytes of randomness', () => {
    let requestedSize: number | undefined;
    generateUserCode((size) => {
      requestedSize = size;
      return fixedBytes(0, 0, 0, 0, 0, 0, 0, 0);
    });

    expect(requestedSize).toBe(8);
  });

  it('formats as XXXX-XXXX using only alphabet characters', () => {
    const code = generateUserCode(() => fixedBytes(1, 2, 3, 4, 5, 6, 7, 8));

    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const stripped = code.replace('-', '');
    for (const ch of stripped) {
      expect(USER_CODE_ALPHABET).toContain(ch);
    }
  });

  it('is deterministic for a given random byte sequence', () => {
    const bytes = fixedBytes(0, 1, 2, 3, 4, 5, 6, 7);
    const expected = Array.from(bytes, (b) => USER_CODE_ALPHABET[b % 32]);
    const code = generateUserCode(() => bytes);

    expect(code).toBe(`${expected.slice(0, 4).join('')}-${expected.slice(4).join('')}`);
  });

  it('maps a full byte range (0-255) without bias via modulo 32', () => {
    // 256 is evenly divisible by 32 — byte 224 (7*32) and byte 0 both map to
    // alphabet index 0; this asserts the wraparound is exact, not off-by-one.
    const code = generateUserCode(() => fixedBytes(224, 0, 31, 32, 255, 0, 0, 0));
    const expectedChars = [224, 0, 31, 32, 255, 0, 0, 0].map((b) => USER_CODE_ALPHABET[b % 32]);
    expect(code).toBe(`${expectedChars.slice(0, 4).join('')}-${expectedChars.slice(4).join('')}`);
  });

  it('never contains ambiguous characters across many random seeds', () => {
    for (let seed = 0; seed < 50; seed++) {
      const bytes = fixedBytes(seed, seed + 1, seed + 2, seed + 3, seed + 4, seed + 5, seed + 6, seed + 7);
      const code = generateUserCode(() => bytes);
      for (const ambiguous of ['0', 'O', '1', 'I']) {
        expect(code).not.toContain(ambiguous);
      }
    }
  });
});

describe('normalizeUserCode', () => {
  it('uppercases lowercase input', () => {
    expect(normalizeUserCode('abcd-efgh')).toBe('ABCDEFGH');
  });

  it('strips hyphens', () => {
    expect(normalizeUserCode('ABCD-EFGH')).toBe('ABCDEFGH');
  });

  it('strips surrounding and internal whitespace', () => {
    expect(normalizeUserCode('  ABCD EFGH  ')).toBe('ABCDEFGH');
  });

  it('strips hyphens, case, and whitespace together', () => {
    expect(normalizeUserCode(' abcd - efgh ')).toBe('ABCDEFGH');
  });

  it('round-trips a generated code to its hyphen-free canonical form', () => {
    const code = generateUserCode(() => fixedBytes(2, 4, 6, 8, 10, 12, 14, 16));
    expect(normalizeUserCode(code)).toBe(code.replace('-', ''));
  });

  it('is idempotent on an already-normalized code', () => {
    const code = generateUserCode(() => fixedBytes(3, 5, 7, 9, 11, 13, 15, 17));
    const normalized = normalizeUserCode(code);
    expect(normalizeUserCode(normalized)).toBe(normalized);
  });
});
