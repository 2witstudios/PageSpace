/**
 * The node primitives the env bridge injects into the pure core. ONE place, so
 * the server hashes and verifies with exactly what the daemon (t08) is
 * documented to use:
 *
 * - `envBridgeHash`: SHA-256, lowercase hex. This is the `hash` behind
 *   `argsHash` (grant binding, invariant 3) and `resultHash` (invariant 7).
 *   The daemon MUST use the same algorithm and encoding or every grant is
 *   `args_mismatch` and every result `unverified_result`.
 * - `ed25519Verify`: Ed25519 over SPKI DER public keys, never throws.
 */
import { createHash, createPublicKey, verify as nodeVerify } from 'crypto';
import type { Ed25519Verify, HashBytes } from '@pagespace/lib/env-bridge/grant';
import { decodeBase64 } from '@pagespace/lib/env-bridge/grant';
import type { Sha256Bytes } from '@pagespace/lib/env-bridge/owner-approval';

export const ENV_BRIDGE_HASH_ALGORITHM = 'sha256';

export const envBridgeHash: HashBytes = (bytes) => createHash(ENV_BRIDGE_HASH_ALGORITHM).update(bytes).digest('hex');

/**
 * SHA-256 as BYTES. Distinct from `envBridgeHash` (hex) on purpose: a WebAuthn
 * challenge is compared as base64url of the raw digest, so the owner-approval
 * derivation takes this one. The daemon's `packages/cli/src/env-bridge/crypto.ts`
 * has the byte-identical twin — the two derivations must agree or every click
 * is `challenge_mismatch`.
 */
export const envBridgeSha256: Sha256Bytes = (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());

export const ed25519Verify: Ed25519Verify = (message, signature, publicKey) => {
  try {
    return nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);
  } catch {
    return false;
  }
};

/** A pinned machine key as stored (base64 SPKI DER) → bytes, or null when the row is unusable. */
export function decodePinnedPublicKey(base64Spki: string | null): Uint8Array | null {
  if (base64Spki === null) return null;
  return decodeBase64(base64Spki);
}
