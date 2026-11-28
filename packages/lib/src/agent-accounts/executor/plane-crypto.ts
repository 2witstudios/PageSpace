/**
 * The credential plane's hash primitives, built only on what its runtime
 * provides. The plane runs under Bun, whose `createHmac` rejects 'sha3-256'
 * ("Invalid digest") while `createHash('sha3-256')` works, so a
 * `createHmac('sha3-256', …)` write digest threw on every first put in
 * production while passing every test (tests run under Node). HMAC-SHA3-256 is
 * therefore built here from the hash, per RFC 2104, byte-identical to Node's.
 *
 * `planeCryptoSelfCheck` runs each primitive against a known answer at boot,
 * so a runtime missing one refuses to start instead of failing every write.
 */
import { createHash } from 'node:crypto';

/** SHA3-256's rate in bytes: the HMAC block size (FIPS 202, NIST SP 800-224 §5). */
const SHA3_256_BLOCK_BYTES = 136;

const sha3 = (...parts: readonly Uint8Array[]): Buffer => {
  const hash = createHash('sha3-256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

/** HMAC-SHA3-256 (RFC 2104 over SHA3-256), lowercase hex. */
export function hmacSha3_256(key: Uint8Array, bytes: Uint8Array): string {
  const blockKey = new Uint8Array(SHA3_256_BLOCK_BYTES);
  blockKey.set(key.length > SHA3_256_BLOCK_BYTES ? sha3(key) : key);
  const inner = new Uint8Array(SHA3_256_BLOCK_BYTES);
  const outer = new Uint8Array(SHA3_256_BLOCK_BYTES);
  for (let index = 0; index < SHA3_256_BLOCK_BYTES; index += 1) {
    inner[index] = blockKey[index]! ^ 0x36;
    outer[index] = blockKey[index]! ^ 0x5c;
  }
  return sha3(outer, sha3(inner, bytes)).toString('hex');
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/** Known answers, computed with Node's createHash/createHmac (see plane-crypto.test.ts). */
const KNOWN_ANSWERS = {
  sha3: { input: 'abc', expected: '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532' },
  hmacSha3: { key: 'plane-crypto-self-check-key', message: 'plane-crypto-self-check-message', expected: '22ccd8559fdaff37c0b6938d76e3ed77f14b7b4a1d9b9721d5a3358d79bb92a3' },
} as const;

/** Names of the primitives that do not give their known answer on this runtime; empty when all do. */
export function planeCryptoSelfCheck(): readonly string[] {
  const failures: string[] = [];
  const check = (name: string, run: () => string, expected: string) => {
    try {
      if (run() !== expected) failures.push(name);
    } catch {
      failures.push(name);
    }
  };
  check('sha3-256', () => sha3(utf8(KNOWN_ANSWERS.sha3.input)).toString('hex'), KNOWN_ANSWERS.sha3.expected);
  check('hmac-sha3-256', () => hmacSha3_256(utf8(KNOWN_ANSWERS.hmacSha3.key), utf8(KNOWN_ANSWERS.hmacSha3.message)), KNOWN_ANSWERS.hmacSha3.expected);
  return failures;
}
