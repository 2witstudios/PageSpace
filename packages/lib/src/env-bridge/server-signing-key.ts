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
/**
 * Rotation form (Codex C10): a comma-separated list of base64 PKCS#8 keys,
 * CURRENT FIRST, then previous keys still pinned by live enrollments. Each
 * key's id is derived from its public half, so ids are stable across
 * restarts and the list needs no explicit labels. When set, it takes
 * precedence over the single-key variable.
 */
export const ENV_BRIDGE_SIGNING_KEYS_VAR = 'ENV_BRIDGE_SIGNING_KEYS';

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

/**
 * The loaded ring: `current` signs new enrollments; `get(keyId)` serves an
 * enrollment pinned to any loaded key — and answers `null`, never a different
 * key, for one that is no longer loaded (the signer surfaces that as
 * `signing_key_unavailable`).
 */
export interface ServerSigningKeyring {
  readonly current: ServerSigningKey;
  /** Current first, in configured order. */
  readonly keyIds: readonly string[];
  get(keyId: string): ServerSigningKey | null;
}

export type ServerSigningKeyringVerdict =
  | { readonly ok: true; readonly keyring: ServerSigningKeyring }
  | { readonly ok: false; readonly reason: 'unset' }
  /** `index` is the offending entry's position in the list. */
  | { readonly ok: false; readonly reason: 'malformed' | 'duplicate_key'; readonly index: number };

/**
 * Parse the ring from the two variables: `multi` (`ENV_BRIDGE_SIGNING_KEYS`)
 * wins when set; otherwise `single` (`ENV_BRIDGE_SIGNING_KEY`) is a ring of
 * one. One bad entry refuses the WHOLE ring — a partially loaded ring would
 * silently strand the enrollments pinned to the missing key.
 */
export function parseServerSigningKeyring(
  { single, multi }: { single: string | undefined; multi: string | undefined },
  primitives: SigningKeyPrimitives,
): ServerSigningKeyringVerdict {
  const entries = (multi ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    const one = parseServerSigningKey(single, primitives);
    if (!one.ok) return one.reason === 'unset' ? { ok: false, reason: 'unset' } : { ok: false, reason: 'malformed', index: 0 };
    return { ok: true, keyring: ringOf([one.key]) };
  }
  const keys: ServerSigningKey[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const parsed = parseServerSigningKey(entries[index], primitives);
    if (!parsed.ok) return { ok: false, reason: 'malformed', index };
    if (keys.some((key) => key.keyId === parsed.key.keyId)) return { ok: false, reason: 'duplicate_key', index };
    keys.push(parsed.key);
  }
  return { ok: true, keyring: ringOf(keys) };
}

function ringOf(keys: readonly ServerSigningKey[]): ServerSigningKeyring {
  const byId = new Map(keys.map((key) => [key.keyId, key] as const));
  return {
    current: keys[0]!,
    keyIds: keys.map((key) => key.keyId),
    get: (keyId) => byId.get(keyId) ?? null,
  };
}
