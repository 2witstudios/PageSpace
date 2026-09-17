/**
 * ADR 0007 Decision 10 — proof-of-work on both signup doors. SHA3-256 over
 * `${challenge}:${nonce}` must carry ≥ difficultyBits leading zero bits.
 * Total: bad inputs are `false`, never a throw. Boundary + mutation-checked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import {
  verifyPowSolution,
  solvePow,
  powLeadingZeroBits,
  isPowDifficultyInRange,
  POW_MAX_DIFFICULTY_BITS,
  POW_TTL_MS,
  POW_NONCE_MAX_LENGTH,
} from '../pow';

const CHALLENGE = 'c9f1a2b3d4e5f60718293a4b5c6d7e8f';

function leadingZeroBits(challenge: string, nonce: string): number {
  const digest = createHash('sha3-256').update(`${challenge}:${nonce}`).digest();
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/** Find a nonce whose digest has EXACTLY `n` leading zero bits (not more). */
function nonceWithExactly(n: number): string {
  for (let i = 0; i < 1_000_000; i += 1) {
    const nonce = `x${i}`;
    if (leadingZeroBits(CHALLENGE, nonce) === n) return nonce;
  }
  throw new Error('no exact nonce found');
}

describe('verifyPowSolution — boundary', () => {
  const N = 8;
  const exact = nonceWithExactly(N);

  it('accepts a nonce with exactly N leading zero bits at difficulty N', () => {
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: exact, difficultyBits: N })).toBe(true);
  });

  it('accepts the same nonce at difficulty N-1 (more work than required is fine)', () => {
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: exact, difficultyBits: N - 1 })).toBe(true);
  });

  it('rejects the same nonce at difficulty N+1 (one bit short)', () => {
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: exact, difficultyBits: N + 1 })).toBe(false);
  });

  it('rejects a nonce with N-1 leading zero bits at difficulty N', () => {
    const short = nonceWithExactly(N - 1);
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: short, difficultyBits: N })).toBe(false);
  });

  it('is bound to the challenge: the same nonce against another challenge is (almost surely) rejected', () => {
    expect(verifyPowSolution({ challenge: `${CHALLENGE}0`, nonce: exact, difficultyBits: N })).toBe(false);
  });

  it('hashes exactly `${challenge}:${nonce}` with SHA3-256 (the wire-documented input)', () => {
    expect(powLeadingZeroBits(CHALLENGE, exact)).toBe(leadingZeroBits(CHALLENGE, exact));
    expect(powLeadingZeroBits(CHALLENGE, exact)).toBe(N);
  });
});

describe('verifyPowSolution — totality (never throws, fails closed)', () => {
  const nonce = 'x1';

  it('rejects difficultyBits ≤ 0', () => {
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce, difficultyBits: 0 })).toBe(false);
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce, difficultyBits: -1 })).toBe(false);
  });

  it('rejects difficultyBits > 64 (even a genuinely valid solution is refused — the ceiling is policy)', () => {
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce, difficultyBits: 65 })).toBe(false);
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce, difficultyBits: 256 })).toBe(false);
  });

  it('accepts difficultyBits exactly 1 and exactly 64 as in-range policy values', () => {
    const one = nonceWithExactly(1);
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: one, difficultyBits: 1 })).toBe(true);
    // 64 is in range; no nonce here has 64 leading zero bits, so the answer is a clean false, not a throw.
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: one, difficultyBits: 64 })).toBe(false);
  });

  it('rejects a non-integer or non-finite difficulty', () => {
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce, difficultyBits: 2.5 })).toBe(false);
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce, difficultyBits: Number.NaN })).toBe(false);
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce, difficultyBits: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it('rejects an empty, over-long, non-ASCII or whitespace-bearing nonce', () => {
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: '', difficultyBits: 1 })).toBe(false);
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: 'a'.repeat(POW_NONCE_MAX_LENGTH + 1), difficultyBits: 1 })).toBe(false);
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: 'é', difficultyBits: 1 })).toBe(false);
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: 'a b', difficultyBits: 1 })).toBe(false);
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: 'a\n', difficultyBits: 1 })).toBe(false);
  });

  it('accepts a nonce at exactly the max length when the work is done', () => {
    const base = 'a'.repeat(POW_NONCE_MAX_LENGTH - 6);
    let found: string | null = null;
    for (let i = 0; i < 100_000 && found === null; i += 1) {
      const candidate = base + String(i).padStart(6, '0');
      if (leadingZeroBits(CHALLENGE, candidate) >= 4) found = candidate;
    }
    expect(found).not.toBeNull();
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: found as string, difficultyBits: 4 })).toBe(true);
  });

  it('rejects an empty, over-long or non-ASCII challenge', () => {
    expect(verifyPowSolution({ challenge: '', nonce, difficultyBits: 1 })).toBe(false);
    expect(verifyPowSolution({ challenge: 'c'.repeat(257), nonce, difficultyBits: 1 })).toBe(false);
    expect(verifyPowSolution({ challenge: 'ché', nonce, difficultyBits: 1 })).toBe(false);
  });

  it('rejects non-string inputs without throwing (defensive against an unvalidated caller)', () => {
    const bad = { challenge: 42 as unknown as string, nonce, difficultyBits: 1 };
    expect(verifyPowSolution(bad)).toBe(false);
    const badNonce = { challenge: CHALLENGE, nonce: null as unknown as string, difficultyBits: 1 };
    expect(verifyPowSolution(badNonce)).toBe(false);
  });
});

describe('isPowDifficultyInRange — the observable [1, 64] policy boundary', () => {
  it('accepts 1 and 64, rejects 0 and 65', () => {
    expect(POW_MAX_DIFFICULTY_BITS).toBe(64);
    expect(isPowDifficultyInRange(1)).toBe(true);
    expect(isPowDifficultyInRange(64)).toBe(true);
    expect(isPowDifficultyInRange(0)).toBe(false);
    expect(isPowDifficultyInRange(65)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(isPowDifficultyInRange(2.5)).toBe(false);
    expect(isPowDifficultyInRange(Number.NaN)).toBe(false);
  });
});

describe('solvePow', () => {
  it('finds a nonce that verifies at a small difficulty, in milliseconds', () => {
    const nonce = solvePow(CHALLENGE, 10);
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce, difficultyBits: 10 })).toBe(true);
  });

  it('returns a nonce that passes the nonce shape rules', () => {
    const nonce = solvePow(CHALLENGE, 4);
    expect(nonce.length).toBeGreaterThan(0);
    expect(nonce.length).toBeLessThanOrEqual(POW_NONCE_MAX_LENGTH);
  });

  it('throws when the iteration budget is exhausted (never spins forever)', () => {
    expect(() => solvePow(CHALLENGE, 64, 10)).toThrow(/budget/);
  });
});

describe('policy constants', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AGENT_SIGNUP_POW_BITS;
  });
  afterEach(() => {
    delete process.env.AGENT_SIGNUP_POW_BITS;
  });

  it('POW_TTL_MS is five minutes', () => {
    expect(POW_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('POW_DIFFICULTY_BITS defaults to 20', async () => {
    const mod = await import('../pow');
    expect(mod.POW_DIFFICULTY_BITS).toBe(20);
  });

  it('POW_DIFFICULTY_BITS reads AGENT_SIGNUP_POW_BITS through envInt (integer literal only)', async () => {
    process.env.AGENT_SIGNUP_POW_BITS = '12';
    let mod = await import('../pow');
    expect(mod.POW_DIFFICULTY_BITS).toBe(12);

    vi.resetModules();
    process.env.AGENT_SIGNUP_POW_BITS = '12abc';
    mod = await import('../pow');
    expect(mod.POW_DIFFICULTY_BITS).toBe(20);
  });
});
