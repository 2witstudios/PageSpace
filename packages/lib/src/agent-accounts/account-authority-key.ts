/**
 * The ACCOUNT AUTHORITY's signing key — separate from the env-bridge's, by
 * design (ADR 0004 §2.2).
 *
 * Why a second key rather than a second audience on the first: the env-bridge
 * signs work for a user's OWN machine, under a key that machine pinned at
 * enrollment; the account authority signs access to OTHER PEOPLE'S
 * credentials. If one key signed both, a compromise of either signer would
 * mint both kinds, and the `iss`/`aud` separation would be a convention
 * rather than a boundary. So: its own variable, its own key, its own issuer
 * constant — and `Nothing imports one into the other` (ADR 0004 §9), which is
 * why this parser is a sibling of `env-bridge/server-signing-key.ts` rather
 * than a call into it.
 *
 * The discipline IS inherited, because it earned it: Ed25519 only with no
 * `alg` field to confuse, key ids derived from the public half so they are
 * stable across restarts, a rotation list with the current key first, and —
 * the rule that matters — an UNSET key is a REFUSAL, never an ephemeral
 * fallback. A server that signed with a key nothing pinned would issue grants
 * no executor can verify; one that generated its own at boot would be
 * trusting itself.
 *
 * One bad entry refuses the WHOLE ring: a partially loaded ring silently
 * strands every grant pinned to the missing key, which looks like a
 * verification bug months later rather than a configuration error now.
 *
 * Pure: the Ed25519 import and the hash are injected. The Node adapter that
 * reads `process.env` is `auth/account-authority-signing-key.ts`.
 */
import { decodeBase64 } from './decode-base64';
import type { HashBytes } from './grant';

export const ACCOUNT_AUTHORITY_SIGNING_KEY_VAR = 'ACCOUNT_AUTHORITY_SIGNING_KEY';
/** Rotation form: comma-separated base64 PKCS#8 keys, CURRENT FIRST. Wins over the single form. */
export const ACCOUNT_AUTHORITY_SIGNING_KEYS_VAR = 'ACCOUNT_AUTHORITY_SIGNING_KEYS';

export type AuthorityKey = {
  /** Stable id derived from the public key; carried on issued grants so a rotated key is identifiable. */
  readonly keyId: string;
  /** SPKI DER — what a verifier is handed as `issuerPublicKey`. */
  readonly publicKey: Uint8Array;
  readonly sign: (message: Uint8Array) => Uint8Array;
};

export type AuthorityKeyPrimitives = {
  /** PKCS#8 DER → the key's public half and a signer; `null` if it is not a usable Ed25519 key. */
  readonly importPrivateKey: (pkcs8Der: Uint8Array) => { readonly publicKey: Uint8Array; readonly sign: (message: Uint8Array) => Uint8Array } | null;
  readonly hash: HashBytes;
};

export type AuthorityKeyring = {
  /** The key new grants are signed with. */
  readonly current: AuthorityKey;
  /** Current first, in configured order. */
  readonly keyIds: readonly string[];
  /** A key still loaded, or `null` — never a different key. */
  readonly get: (keyId: string) => AuthorityKey | null;
};

export type AuthorityKeyringVerdict =
  | { readonly ok: true; readonly keyring: AuthorityKeyring }
  | { readonly ok: false; readonly reason: 'unset' }
  /** `index` is the offending entry's position in the list. */
  | { readonly ok: false; readonly reason: 'malformed' | 'duplicate_key'; readonly index: number };

const KEY_ID_LENGTH = 16;

function parseOne(raw: string | undefined, primitives: AuthorityKeyPrimitives): AuthorityKey | null | 'unset' {
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0) return 'unset';
  const der = decodeBase64(trimmed);
  if (der === null) return null;
  const imported = primitives.importPrivateKey(der);
  if (imported === null) return null;
  return { keyId: primitives.hash(imported.publicKey).slice(0, KEY_ID_LENGTH), publicKey: imported.publicKey, sign: imported.sign };
}

function ringOf(keys: readonly AuthorityKey[]): AuthorityKeyring {
  const byId = new Map(keys.map((key) => [key.keyId, key] as const));
  return {
    current: keys[0]!,
    keyIds: keys.map((key) => key.keyId),
    get: (keyId) => byId.get(keyId) ?? null,
  };
}

export function parseAccountAuthorityKeyring(
  { single, multi }: { readonly single: string | undefined; readonly multi: string | undefined },
  primitives: AuthorityKeyPrimitives,
): AuthorityKeyringVerdict {
  const entries = (multi ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    const one = parseOne(single, primitives);
    if (one === 'unset') return { ok: false, reason: 'unset' };
    if (one === null) return { ok: false, reason: 'malformed', index: 0 };
    return { ok: true, keyring: ringOf([one]) };
  }

  const keys: AuthorityKey[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const parsed = parseOne(entries[index], primitives);
    if (parsed === 'unset' || parsed === null) return { ok: false, reason: 'malformed', index };
    if (keys.some((key) => key.keyId === parsed.keyId)) return { ok: false, reason: 'duplicate_key', index };
    keys.push(parsed);
  }
  return { ok: true, keyring: ringOf(keys) };
}
