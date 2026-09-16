/**
 * Proof-of-work for the agent signup doors (ADR 0007 Decision 10).
 *
 * Both doors require the caller to present a server-issued challenge and a
 * nonce such that SHA3-256(`${challenge}:${nonce}`) has at least
 * `difficultyBits` leading zero bits. PoW is rate-shaping, not identity
 * (threat model §4.2): it makes bulk creation cost CPU; the per-IP limits are
 * the real ceiling.
 *
 * `verifyPowSolution` is TOTAL — every malformed input is `false`, never a
 * throw — and pure. The challenge record's expiry/consumption is decided by
 * `decideAgentSignup`, not here. The env-reading edge for the difficulty is
 * the single `POW_DIFFICULTY_BITS` constant; routes pass it in.
 *
 * @module @pagespace/lib/auth/agent/pow
 */

import { createHash } from 'crypto';
import { envInt } from '../../billing/credit-pricing';

/** Default 20 bits ≈ 1M hashes ≈ well under a second on commodity hardware. */
export const POW_DIFFICULTY_BITS = envInt('AGENT_SIGNUP_POW_BITS', 20);

/** A challenge is single-use and expires five minutes after issue. */
export const POW_TTL_MS = 5 * 60 * 1000;

/** Policy ceiling: 64 bits is already astronomically expensive; anything above is a misconfiguration. */
export const POW_MAX_DIFFICULTY_BITS = 64;

export const POW_NONCE_MAX_LENGTH = 64;
const POW_CHALLENGE_MAX_LENGTH = 256;

export interface PowSolution {
  challenge: string;
  nonce: string;
  difficultyBits: number;
}

/**
 * Is `bits` a difficulty this server will issue or verify? An integer in
 * [1, POW_MAX_DIFFICULTY_BITS]. Routes validate the configured difficulty
 * with this before issuing a challenge; `verifyPowSolution` applies it too.
 */
export function isPowDifficultyInRange(bits: number): boolean {
  if (!Number.isInteger(bits)) return false;
  return bits >= 1 && bits <= POW_MAX_DIFFICULTY_BITS;
}

/** Printable ASCII with no whitespace, 1..max chars — bounded and linear. */
function isPrintableAscii(value: string, maxLength: number): boolean {
  if (value.length === 0 || value.length > maxLength) return false;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

/** Leading zero bits of SHA3-256(`${challenge}:${nonce}`). Inputs are assumed already shape-checked. */
export function powLeadingZeroBits(challenge: string, nonce: string): number {
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

/**
 * Accept iff the digest carries ≥ `difficultyBits` leading zero bits.
 * Difficulty must be an integer in [1, 64]; nonce and challenge must be
 * non-empty printable ASCII within their length caps. Anything else → false.
 */
export function verifyPowSolution(input: PowSolution): boolean {
  const { challenge, nonce, difficultyBits } = input;
  if (typeof challenge !== 'string' || typeof nonce !== 'string') return false;
  if (!isPowDifficultyInRange(difficultyBits)) return false;
  if (!isPrintableAscii(challenge, POW_CHALLENGE_MAX_LENGTH)) return false;
  if (!isPrintableAscii(nonce, POW_NONCE_MAX_LENGTH)) return false;
  return powLeadingZeroBits(challenge, nonce) >= difficultyBits;
}

/**
 * Brute-force a nonce for tests and the CLI/browser solvers. Iterates decimal
 * nonces; throws once `maxIterations` is exhausted so a misconfigured
 * difficulty can never spin forever.
 */
export function solvePow(challenge: string, difficultyBits: number, maxIterations = 50_000_000): string {
  for (let i = 0; i < maxIterations; i += 1) {
    const nonce = String(i);
    if (powLeadingZeroBits(challenge, nonce) >= difficultyBits) return nonce;
  }
  throw new Error(`solvePow: iteration budget of ${maxIterations} exhausted at ${difficultyBits} bits`);
}
