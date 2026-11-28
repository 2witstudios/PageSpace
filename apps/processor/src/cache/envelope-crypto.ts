/**
 * The envelope codec lives in `@pagespace/lib` so the web app can read it too
 * (a content takedown checks a preserved copy against its content hash, which
 * is computed over the plaintext). Re-exported here for the processor's callers.
 */
export {
  decryptBuffer,
  encryptBuffer,
  isEnvelope,
  maybeDecryptBuffer,
  maybeEncryptBuffer,
} from '@pagespace/lib/encryption/envelope-crypto';
