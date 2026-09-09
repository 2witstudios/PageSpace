/**
 * Enrollment code — the one-time secret a user carries from PageSpace to their
 * own machine to bind it to a local environment (Local Environments epic,
 * invariant 2: machine-held identity).
 *
 * The flow: the server issues a code and stores only its HASH; the user runs
 * `pagespace env enroll <code>` on the machine; the daemon presents the code
 * with its freshly generated public key; the server verifies the code here and
 * pins the key. The code is single-use and short-lived, so a code that leaks
 * after use, or is never used, is worth nothing.
 *
 * Human factors are part of the security design: the alphabet is Crockford
 * base32 (no I, L, O, U), so a code can be read aloud or typed from a screen
 * without ambiguity, and `normalizeEnrollmentCode` folds the look-alikes a
 * human might type back into the issued symbols before hashing.
 *
 * Pure: randomness, the hash, and the clock are injected. The comparison is
 * hash-then-constant-time, the same shape as `secureCompare` in `auth/` (hash
 * first so no prefix structure survives; the adapter injects SHA3-256 to match
 * how tokens are hashed at rest).
 *
 * Deny order is FIXED and tested: malformed → mismatch → used → expired. A
 * wrong code learns nothing about the entry's state; only the holder of the
 * right code is told it was already used or has expired.
 */
import { constantTimeEqual, type HashBytes } from './grant';

/** Injected randomness: `length` cryptographically random bytes. */
export type RandomBytes = (length: number) => Uint8Array;

/** Crockford base32: digits plus letters without I, L, O and U. 32 symbols, so a random byte masked to 5 bits is uniform. */
export const ENROLLMENT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 20 symbols × 5 bits = 100 bits of entropy. */
export const ENROLLMENT_CODE_LENGTH = 20;
/** Long enough to walk to another machine and paste; short enough that a forgotten code dies on its own. */
export const ENROLLMENT_CODE_TTL_MS = 10 * 60 * 1000;

export interface IssueEnrollmentCodeInput {
  readonly random: RandomBytes;
  readonly hash: HashBytes;
  /** Injected clock, ms since epoch. */
  readonly now: number;
  readonly ttlMs?: number;
}

export interface IssuedEnrollmentCode {
  /** Shown to the user ONCE; never stored. */
  readonly code: string;
  /** What the server stores. */
  readonly codeHash: string;
  /** Expiry, ms since epoch. */
  readonly exp: number;
}

export function issueEnrollmentCode({ random, hash, now, ttlMs = ENROLLMENT_CODE_TTL_MS }: IssueEnrollmentCodeInput): IssuedEnrollmentCode {
  const code = Array.from(random(ENROLLMENT_CODE_LENGTH), (byte) => ENROLLMENT_CODE_ALPHABET[byte & 31]).join('');
  return { code, codeHash: hash(new TextEncoder().encode(code)), exp: now + ttlMs };
}

/**
 * What a human typed → the symbols that were issued: uppercase, separators
 * dropped, Crockford look-alikes folded (I/L → 1, O → 0). `null` for a
 * non-string. Validation against the alphabet happens in the verifier.
 */
export function normalizeEnrollmentCode(presented: unknown): string | null {
  if (typeof presented !== 'string') return null;
  return presented.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}

const CODE_RE = new RegExp(`^[${ENROLLMENT_CODE_ALPHABET}]{${ENROLLMENT_CODE_LENGTH}}$`);

export type EnrollmentCodeDenyReason = 'malformed' | 'mismatch' | 'used' | 'expired';
export type EnrollmentCodeVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: EnrollmentCodeDenyReason };

export interface VerifyEnrollmentCodeInput {
  /** Untrusted: whatever the daemon sent. */
  readonly presented: unknown;
  /** The stored hash from issuance. */
  readonly storedHash: string;
  /** The stored expiry, ms since epoch. */
  readonly exp: number;
  /** When the code was consumed, or `null` if never. */
  readonly usedAt: number | null;
  /** Injected clock. */
  readonly now: number;
  /** The same hash primitive issuance used. */
  readonly hash: HashBytes;
}

export function verifyEnrollmentCode(input: VerifyEnrollmentCodeInput): EnrollmentCodeVerdict {
  const code = normalizeEnrollmentCode(input.presented);
  // Shape first, before any hashing: junk never reaches the digest.
  if (code === null || !CODE_RE.test(code)) return { ok: false, reason: 'malformed' };
  if (!constantTimeEqual(input.hash(new TextEncoder().encode(code)), input.storedHash)) return { ok: false, reason: 'mismatch' };
  if (input.usedAt !== null) return { ok: false, reason: 'used' };
  if (input.now > input.exp) return { ok: false, reason: 'expired' };
  return { ok: true };
}
