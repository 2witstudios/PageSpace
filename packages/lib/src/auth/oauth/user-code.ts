/**
 * RFC 8628 §6.1 user-code generation + normalization for the device
 * authorization grant (Phase 1 task 9, mwexjazwha2uhw5bmvc9a7kw). Pure:
 * randomness is injected via `randomBytesFn`, no I/O, no clock — the
 * `/api/oauth/device_authorization` route is the impure edge that supplies
 * Node's `crypto.randomBytes`.
 *
 * @module @pagespace/lib/auth/oauth/user-code
 */

/**
 * Unambiguous 32-character alphabet: excludes 0/O and 1/I (RFC 8628 §6.1
 * recommends avoiding characters a human can misread over the phone or a
 * blurry terminal). 32 = 2^5, so one byte's low 5 bits (`byte % 32`) map to a
 * character with zero modulo bias — 256 is evenly divisible by 32.
 */
export const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Characters before the canonical `XXXX-XXXX` hyphen is inserted. */
const USER_CODE_LENGTH = 8;

export type RandomBytesFn = (size: number) => Uint8Array;

/**
 * Generate an `XXXX-XXXX` user code from injected randomness. One byte per
 * character, drawn from `USER_CODE_ALPHABET` via `byte % 32`.
 */
export function generateUserCode(randomBytesFn: RandomBytesFn): string {
  const bytes = randomBytesFn(USER_CODE_LENGTH);
  const chars: string[] = [];
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    chars.push(USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length]);
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/**
 * Normalize user input before hashing/lookup: uppercase, strip hyphens and
 * whitespace. Generation-time storage and verification-time lookup both run
 * input through this exact function, so the two hashes only ever match when
 * the underlying 8 characters do.
 */
export function normalizeUserCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
