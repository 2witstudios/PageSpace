/**
 * Node adapter over the pure `parseServerSigningKey`: reads
 * `ENV_BRIDGE_SIGNING_KEY` and supplies the Ed25519 primitives. Throws — never
 * falls back — when the key is unset or unusable (invariant 3; see the pure
 * module's docblock).
 */
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from 'crypto';
import {
  parseServerSigningKey,
  ENV_BRIDGE_SIGNING_KEY_VAR,
  type ServerSigningKey,
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

export function loadServerSigningKey(env: Record<string, string | undefined> = process.env): ServerSigningKey {
  const verdict = parseServerSigningKey(env[ENV_BRIDGE_SIGNING_KEY_VAR], primitives);
  if (verdict.ok) return verdict.key;
  if (verdict.reason === 'unset') {
    throw new Error(`${ENV_BRIDGE_SIGNING_KEY_VAR} is required: the env bridge signs every grant with it and never falls back to an ephemeral key`);
  }
  throw new Error(`${ENV_BRIDGE_SIGNING_KEY_VAR} must be a base64-encoded PKCS#8 Ed25519 private key`);
}
