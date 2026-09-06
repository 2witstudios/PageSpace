/**
 * Node adapter over the pure `parseServerSigningKeyring`: reads
 * `ENV_BRIDGE_SIGNING_KEYS` (rotation form, current first — Codex C10) or
 * `ENV_BRIDGE_SIGNING_KEY` (single-key form) and supplies the Ed25519
 * primitives. Throws — never falls back — when no key is set or any entry is
 * unusable (invariant 3; see the pure module's docblock).
 */
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from 'crypto';
import {
  parseServerSigningKeyring,
  ENV_BRIDGE_SIGNING_KEY_VAR,
  ENV_BRIDGE_SIGNING_KEYS_VAR,
  type ServerSigningKey,
  type ServerSigningKeyring,
  type SigningKeyPrimitives,
} from '../env-bridge/server-signing-key';

const primitives: SigningKeyPrimitives = {
  importPrivateKey: (pkcs8) => {
    try {
      const privateKey = createPrivateKey({ key: Buffer.from(pkcs8), type: 'pkcs8', format: 'der' });
      if (privateKey.asymmetricKeyType !== 'ed25519') return null;
      const publicKey = new Uint8Array(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }));
      return { publicKey, sign: (message) => new Uint8Array(nodeSign(null, message, privateKey)) };
    } catch {
      return null;
    }
  },
  hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
};

/** The whole ring: current key for new enrollments, previous keys for the enrollments that pinned them. */
export function loadServerSigningKeyring(env: Record<string, string | undefined> = process.env): ServerSigningKeyring {
  const verdict = parseServerSigningKeyring({ single: env[ENV_BRIDGE_SIGNING_KEY_VAR], multi: env[ENV_BRIDGE_SIGNING_KEYS_VAR] }, primitives);
  if (verdict.ok) return verdict.keyring;
  if (verdict.reason === 'unset') {
    throw new Error(`${ENV_BRIDGE_SIGNING_KEY_VAR} (or ${ENV_BRIDGE_SIGNING_KEYS_VAR}) is required: the env bridge signs every grant with it and never falls back to an ephemeral key`);
  }
  if (verdict.reason === 'duplicate_key') {
    throw new Error(`${ENV_BRIDGE_SIGNING_KEYS_VAR} lists the same key twice (entry ${verdict.index})`);
  }
  throw new Error(`${ENV_BRIDGE_SIGNING_KEY_VAR} / ${ENV_BRIDGE_SIGNING_KEYS_VAR} entries must be base64-encoded PKCS#8 Ed25519 private keys (entry ${verdict.index} is not)`);
}

/** The CURRENT key — what new enrollments pin. */
export function loadServerSigningKey(env: Record<string, string | undefined> = process.env): ServerSigningKey {
  return loadServerSigningKeyring(env).current;
}
