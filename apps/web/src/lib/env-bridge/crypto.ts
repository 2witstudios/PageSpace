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
import type { Sha256Bytes, VerifyWebauthnSignature } from '@pagespace/lib/env-bridge/owner-approval';

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

/**
 * Signature verification for every algorithm a passkey can be registered with
 * (hardening B; Codex P2 on #2599). Each is what `crypto.verify` does natively
 * for that key type: ES256 = ECDSA/SHA-256 over an ASN.1 DER signature, EdDSA =
 * Ed25519 over the raw message (digest `null`), RS256 =
 * RSASSA-PKCS1-v1_5/SHA-256. The COSE → JWK step is pure and lives in the core
 * (`coseToJwk`); this is only the primitive. Never throws: a key node refuses
 * to import, or a malformed signature, is a failed verification, and the gate
 * turns that into `bad_signature`.
 */
export const webauthnVerify: VerifyWebauthnSignature = (message, signature, publicKey) => {
  try {
    if (publicKey.alg === 'EdDSA') {
      return nodeVerify(null, message, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey.x }, format: 'jwk' }), signature);
    }
    if (publicKey.alg === 'RS256') {
      return nodeVerify('sha256', message, createPublicKey({ key: { kty: 'RSA', n: publicKey.n, e: publicKey.e }, format: 'jwk' }), signature);
    }
    return nodeVerify('sha256', message, createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: publicKey.x, y: publicKey.y }, format: 'jwk' }), signature);
  } catch {
    return false;
  }
};

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
