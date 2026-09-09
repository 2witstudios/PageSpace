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
 * - `envBridgeSha256` / `webauthnVerify`: the two primitives the owner-approval
 *   gate injects (hardening B) — SHA-256 as bytes for the derived WebAuthn
 *   challenge, and signature verification for every algorithm a passkey can be
 *   registered with (ES256, EdDSA, RS256).
 *
 * Signing with the machine key lives in `keypair.ts`.
 */
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import type { Ed25519Verify, HashBytes, Sha256Bytes, VerifyWebauthnSignature } from './lib-core.js';

export const ENV_BRIDGE_HASH_ALGORITHM = 'sha256';

export const envBridgeHash: HashBytes = (bytes) => createHash(ENV_BRIDGE_HASH_ALGORITHM).update(bytes).digest('hex');

/**
 * SHA-256 as BYTES — the twin of the server's `envBridgeSha256`. A WebAuthn
 * challenge is compared as base64url of the raw digest, so the owner-approval
 * derivation (hardening B) takes this rather than the hex `envBridgeHash`.
 */
export const envBridgeSha256: Sha256Bytes = (bytes) => new Uint8Array(createHash(ENV_BRIDGE_HASH_ALGORITHM).update(bytes).digest());

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
