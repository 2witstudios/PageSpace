/**
 * The browser's proof-of-work search (Agent Signup Phase 3). It must agree
 * bit-for-bit with the server's verifier (`@pagespace/lib/auth/agent/pow`,
 * Node's SHA3-256), or a browser agent solves puzzles the server rejects.
 */
import { describe, it, expect } from 'vitest';
import { powLeadingZeroBits, solvePow, verifyPowSolution } from '@pagespace/lib/auth/agent/pow';
import { expectedPowAttempts, searchPowNonce } from '../pow-solver';

const CHALLENGE = 'ps_pow_abcdefghijklmnopqrstuvwxyz012345';

describe('the browser digest agrees with the server (bit for bit)', () => {
  it.each([1, 3, 5, 8, 11])('at %i bits, should find exactly the nonce the server-side solver finds', (bits) => {
    for (const challenge of [CHALLENGE, 'ps_pow_0000000000000000000000000000000z', 'ps_pow_x']) {
      const browser = searchPowNonce({ challenge, difficultyBits: bits, start: 0, count: 1_000_000 });
      expect(browser.nonce).toBe(solvePow(challenge, bits));
    }
  });
});

describe('searchPowNonce', () => {
  it('given a range containing a solution, should return a nonce the server verifies', () => {
    const result = searchPowNonce({ challenge: CHALLENGE, difficultyBits: 8, start: 0, count: 100_000 });
    expect(result.nonce).not.toBeNull();
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: result.nonce ?? '', difficultyBits: 8 })).toBe(true);
  });

  it('should return the FIRST solving nonce in the range and how many it tried', () => {
    const result = searchPowNonce({ challenge: CHALLENGE, difficultyBits: 6, start: 0, count: 100_000 });
    const first = Number(result.nonce);
    for (let i = 0; i < first; i += 1) expect(powLeadingZeroBits(CHALLENGE, String(i))).toBeLessThan(6);
    expect(result.attempts).toBe(first + 1);
  });

  it('given a range with no solution, should return null having tried every nonce', () => {
    const result = searchPowNonce({ challenge: CHALLENGE, difficultyBits: 40, start: 0, count: 50 });
    expect(result).toEqual({ nonce: null, attempts: 50 });
  });

  it('should continue from start', () => {
    const result = searchPowNonce({ challenge: CHALLENGE, difficultyBits: 1, start: 1000, count: 100 });
    expect(Number(result.nonce)).toBeGreaterThanOrEqual(1000);
  });
});

describe('expectedPowAttempts', () => {
  it('should be 2^bits', () => {
    expect(expectedPowAttempts(20)).toBe(1_048_576);
    expect(expectedPowAttempts(1)).toBe(2);
  });
});
