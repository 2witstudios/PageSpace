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
 *
 * Signing with the machine key lives in `keypair.ts`.
 */
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import type { Ed25519Verify, HashBytes } from '@pagespace/lib/env-bridge/grant';

export const ENV_BRIDGE_HASH_ALGORITHM = 'sha256';

export const envBridgeHash: HashBytes = (bytes) => createHash(ENV_BRIDGE_HASH_ALGORITHM).update(bytes).digest('hex');

export const ed25519Verify: Ed25519Verify = (message, signature, publicKey) => {
  try {
    return nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);
  } catch {
    return false;
  }
};
