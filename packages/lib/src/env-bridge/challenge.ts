/**
 * Challenge / response — how an enrolled machine earns a transport token
 * without ever presenting a stored secret (Local Environments epic, invariant
 * 2: "transport tokens via challenge / proof-of-possession").
 *
 * The server issues a fresh nonce bound to one enrollment; the daemon signs
 * `encodeChallenge(...)` with the private key that never left its keychain;
 * the server verifies the signature against the public key it pinned at
 * enrollment and, only then, mints a short-lived `env:bridge` token. A captured
 * nonce is useless without the key; a captured signature is useless after the
 * nonce is consumed or expires.
 *
 * Pure: randomness, the Ed25519 verify primitive and the clock are injected.
 *
 * Deny order is FIXED and tested: malformed → wrong_enrollment →
 * nonce_mismatch → used → expired → bad_signature. Cheap structural checks run
 * before crypto, and the caller marks the nonce consumed only on `ok` — a
 * response that fails any check has proven nothing and must not burn the nonce.
 */
import { z } from 'zod';
import { constantTimeEqual, decodeBase64, type Ed25519Verify } from './grant';
import type { RandomBytes } from './enrollment';

/** A machine has one round trip to sign; a minute is generous for a daemon and short for an attacker. */
export const CHALLENGE_TTL_MS = 60 * 1000;
const NONCE_BYTES = 32;

export interface Challenge {
  readonly nonce: string;
  readonly enrollmentId: string;
  /** Issued-at, ms since epoch. */
  readonly iat: number;
  /** Expiry, ms since epoch. */
  readonly exp: number;
}

export interface IssueChallengeInput {
  readonly random: RandomBytes;
  readonly now: number;
  readonly enrollmentId: string;
  readonly ttlMs?: number;
}

export function issueChallenge({ random, now, enrollmentId, ttlMs = CHALLENGE_TTL_MS }: IssueChallengeInput): Challenge {
  return { nonce: Buffer.from(random(NONCE_BYTES)).toString('base64url'), enrollmentId, iat: now, exp: now + ttlMs };
}

/**
 * Canonical bytes the machine signs: fixed key order, rebuilt from the typed
 * challenge so insertion order can never change the signed message.
 */
export function encodeChallenge(challenge: Pick<Challenge, 'nonce' | 'enrollmentId' | 'exp'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ nonce: challenge.nonce, enrollmentId: challenge.enrollmentId, exp: challenge.exp }));
}

// `.strict()`: an extra field is not "ignored", it is a malformed response.
const responseSchema = z
  .object({
    enrollmentId: z.string().min(1),
    nonce: z.string().min(1),
    /** Base64 Ed25519 signature over `encodeChallenge(challenge)`. */
    signature: z.string().min(1),
  })
  .strict();

export type ChallengeDenyReason = 'malformed' | 'wrong_enrollment' | 'nonce_mismatch' | 'used' | 'expired' | 'bad_signature';
export type ChallengeVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: ChallengeDenyReason };

export interface VerifyChallengeResponseInput {
  /** The stored challenge, with when it was consumed (`null` if never). */
  readonly challenge: Challenge & { readonly usedAt: number | null };
  /** Untrusted: whatever arrived on the wire. */
  readonly response: unknown;
  /** The machine public key pinned at enrollment (SPKI DER). */
  readonly machinePublicKey: Uint8Array;
  readonly verify: Ed25519Verify;
  /** Injected clock. */
  readonly now: number;
}

function deny(reason: ChallengeDenyReason): ChallengeVerdict {
  return { ok: false, reason };
}

export function verifyChallengeResponse(input: VerifyChallengeResponseInput): ChallengeVerdict {
  const parsed = responseSchema.safeParse(input.response);
  if (!parsed.success) return deny('malformed');
  const signature = decodeBase64(parsed.data.signature);
  if (signature === null) return deny('malformed');

  if (parsed.data.enrollmentId !== input.challenge.enrollmentId) return deny('wrong_enrollment');
  if (!constantTimeEqual(parsed.data.nonce, input.challenge.nonce)) return deny('nonce_mismatch');
  if (input.challenge.usedAt !== null) return deny('used');
  if (input.now > input.challenge.exp) return deny('expired');

  let valid = false;
  try {
    valid = input.verify(encodeChallenge(input.challenge), signature, input.machinePublicKey);
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : deny('bad_signature');
}
