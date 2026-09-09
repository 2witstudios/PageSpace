/**
 * The node primitives the daemon injects into the pure core — the machine
 * end of `apps/web/src/lib/env-bridge/crypto.ts`, kept byte-compatible:
 *
 * - `envBridgeHash`: SHA-256, lowercase hex — the `hash` behind `argsHash`
 *   (grant binding, invariant 3) and `resultHash` (invariant 7). The server
 *   hashes with exactly this; anything else makes every grant `args_mismatch`
 *   and every result unverifiable.
 * - `ed25519Verify`: Ed25519 over SPKI DER public keys; never throws. Used to
 *   verify grants and revokes under the server key pinned at enrollment.
 * - `envBridgeSha256` / `es256Verify`: the two primitives the owner-approval
 *   gate injects (hardening B) — SHA-256 as bytes for the derived WebAuthn
 *   challenge, and ECDSA-P256 over the assertion's DER signature.
 *
 * Signing with the machine key lives in `keypair.ts`.
 */
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import type { Ed25519Verify, Es256Verify, HashBytes, Sha256Bytes } from './lib-core.js';

export const ENV_BRIDGE_HASH_ALGORITHM = 'sha256';

export const envBridgeHash: HashBytes = (bytes) => createHash(ENV_BRIDGE_HASH_ALGORITHM).update(bytes).digest('hex');

/**
 * SHA-256 as BYTES — the twin of the server's `envBridgeSha256`. A WebAuthn
 * challenge is compared as base64url of the raw digest, so the owner-approval
 * derivation (hardening B) takes this rather than the hex `envBridgeHash`.
 */
export const envBridgeSha256: Sha256Bytes = (bytes) => new Uint8Array(createHash(ENV_BRIDGE_HASH_ALGORITHM).update(bytes).digest());

/**
 * ECDSA P-256 / SHA-256 over the ASN.1 DER signature a WebAuthn ES256
 * assertion carries — which is exactly what `crypto.verify` expects by
 * default (`dsaEncoding: 'der'`), so no new dependency is needed to check the
 * owner's click. The COSE → JWK step is pure and lives in the core
 * (`coseEc2ToJwk`); this is only the primitive. Never throws: a key node
 * refuses to import, or a malformed signature, is a failed verification, and
 * the gate turns that into `bad_signature`.
 */
export const es256Verify: Es256Verify = (message, signature, publicKey) => {
  try {
    return nodeVerify('sha256', message, createPublicKey({ key: { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y }, format: 'jwk' }), signature);
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
