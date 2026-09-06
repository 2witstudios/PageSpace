/**
 * The server signing key — the key whose signature every grant carries and
 * every daemon pins at enrollment (Local Environments epic, invariant 3).
 *
 * It is configured as an environment variable holding a base64 PKCS#8 Ed25519
 * private key, the same way `REALTIME_BROADCAST_SECRET` is (the Zero Trust
 * Assessment's "secrets are env vars" qualifier applies; a KMS-backed signer
 * can replace the primitives later without touching callers). What must never
 * change: an UNSET key is a refusal, not an ephemeral fallback — a server that
 * signed with a key no daemon had pinned would be issuing grants nothing can
 * verify, and one that pinned a random key would be trusting itself.
 *
 * This parser is pure; the Ed25519 import and the hash are injected. The node
 * adapter that reads `process.env` lives in `auth/env-bridge-signing-key.ts`.
 */
import { decodeBase64, type HashBytes } from './grant';

export const ENV_BRIDGE_SIGNING_KEY_VAR = 'ENV_BRIDGE_SIGNING_KEY';

export interface ServerSigningKey {
  /** Stable id derived from the public key; stored per enrollment so a rotated key can be told apart. */
  readonly keyId: string;
  /** SPKI DER — what the daemon pins. */
  readonly publicKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

export interface SigningKeyPrimitives {
  /** PKCS#8 DER → the key's public half and a signer; `null` if it is not a usable Ed25519 key. */
  importPrivateKey(pkcs8Der: Uint8Array): { publicKey: Uint8Array; sign(message: Uint8Array): Uint8Array } | null;
  readonly hash: HashBytes;
}

export type ServerSigningKeyVerdict = { readonly ok: true; readonly key: ServerSigningKey } | { readonly ok: false; readonly reason: 'unset' | 'malformed' };

const KEY_ID_LENGTH = 16;

export function parseServerSigningKey(raw: string | undefined, primitives: SigningKeyPrimitives): ServerSigningKeyVerdict {
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0) return { ok: false, reason: 'unset' };
  const der = decodeBase64(trimmed);
  if (der === null) return { ok: false, reason: 'malformed' };
  const imported = primitives.importPrivateKey(der);
  if (imported === null) return { ok: false, reason: 'malformed' };
  return {
    ok: true,
    key: { keyId: primitives.hash(imported.publicKey).slice(0, KEY_ID_LENGTH), publicKey: imported.publicKey, sign: imported.sign },
  };
}
