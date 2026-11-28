/**
 * The browser's proof-of-work search for the agent signup door (ADR 0008
 * Decision 10). The server verifies with Node's SHA3-256
 * (`@pagespace/lib/auth/agent/pow`); browsers have no SHA3 in WebCrypto, so
 * this uses `@noble/hashes`. A test pins the two together bit for bit.
 *
 * Pure and synchronous: the web worker (`pow.worker.ts`) calls it in chunks so
 * it can report progress between them. Nonces are decimal strings, like the
 * lib's `solvePow`.
 */
import { sha3_256 } from '@noble/hashes/sha3';

const encoder = new TextEncoder();

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

/** Leading zero bits of SHA3-256(`${challenge}:${nonce}`). */
function browserPowZeroBits(challenge: string, nonce: string): number {
  return leadingZeroBits(sha3_256(encoder.encode(`${challenge}:${nonce}`)));
}

interface PowSearch {
  challenge: string;
  difficultyBits: number;
  /** First nonce to try. */
  start: number;
  /** How many consecutive nonces to try. */
  count: number;
}

/** The first solving nonce in [start, start + count), and how many were tried. */
export function searchPowNonce(input: PowSearch): { nonce: string | null; attempts: number } {
  for (let i = 0; i < input.count; i += 1) {
    const nonce = String(input.start + i);
    if (browserPowZeroBits(input.challenge, nonce) >= input.difficultyBits) {
      return { nonce, attempts: i + 1 };
    }
  }
  return { nonce: null, attempts: input.count };
}

/** Mean number of hashes a puzzle of this difficulty takes — for the progress text. */
export function expectedPowAttempts(difficultyBits: number): number {
  return 2 ** difficultyBits;
}
