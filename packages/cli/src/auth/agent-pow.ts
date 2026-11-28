/**
 * The agent signup proof-of-work (ADR 0008 Decision 10; auth.md "Prove
 * work"): find a nonce such that SHA3-256(`<challenge>:<nonce>`) has at least
 * `difficultyBits` leading zero bits. ~1M hashes at the default 20 bits —
 * well under a second.
 *
 * An inlined copy of `@pagespace/lib/auth/agent/pow`'s `solvePow` (the
 * published CLI never runtime-imports `@pagespace/lib`); `agent-pow.test.ts`
 * pins it to the server's `verifyPowSolution`. `isAgentSecretShape` is
 * likewise a copy of the server's shape check, so a mistyped secret is
 * refused before it is ever sent.
 */
import { createHash } from 'node:crypto';

const POW_MAX_DIFFICULTY_BITS = 64;
const DEFAULT_MAX_ITERATIONS = 50_000_000;

function leadingZeroBits(digest: Uint8Array): number {
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

/** Brute-forces decimal nonces. Throws on an out-of-policy difficulty or an exhausted budget — never spins forever. */
export function solveAgentPow(challenge: string, difficultyBits: number, maxIterations = DEFAULT_MAX_ITERATIONS): string {
  if (!Number.isInteger(difficultyBits) || difficultyBits < 1 || difficultyBits > POW_MAX_DIFFICULTY_BITS) {
    throw new RangeError(`Proof-of-work difficulty must be an integer from 1 to ${POW_MAX_DIFFICULTY_BITS}; the server sent ${difficultyBits}.`);
  }
  for (let i = 0; i < maxIterations; i += 1) {
    const nonce = String(i);
    if (leadingZeroBits(createHash('sha3-256').update(`${challenge}:${nonce}`).digest()) >= difficultyBits) {
      return nonce;
    }
  }
  throw new Error(`Proof-of-work iteration budget of ${maxIterations} exhausted at ${difficultyBits} bits.`);
}

const AGENT_SECRET_HEAD = 'ps_agent_';
const AGENT_SECRET_BODY_LENGTH = 32;

/** Exactly `ps_agent_` + 32 lowercase alphanumerics — the server's own shape rule. */
export function isAgentSecretShape(value: string): boolean {
  if (value.length !== AGENT_SECRET_HEAD.length + AGENT_SECRET_BODY_LENGTH) return false;
  if (!value.startsWith(AGENT_SECRET_HEAD)) return false;
  for (let i = AGENT_SECRET_HEAD.length; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 122))) return false;
  }
  return true;
}
