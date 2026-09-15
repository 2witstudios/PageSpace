/**
 * Node adapter over the pure `parseAccountAuthorityKeyring`: reads
 * `ACCOUNT_AUTHORITY_SIGNING_KEYS` (rotation form, current first) or
 * `ACCOUNT_AUTHORITY_SIGNING_KEY` (single-key form) and supplies the Ed25519
 * primitives. Sibling of `auth/env-bridge-signing-key.ts` and deliberately
 * NOT a call into it — the account authority is a separate signing authority
 * (ADR 0004 §2.2, §9).
 *
 * Throws — never falls back — when no key is set or any entry is unusable.
 * The web process does not hold this key: issuance happens in the authority
 * service after the intersection is satisfied (ADR 0005 §3.4), so the only
 * process that loads it is the one allowed to mint grants.
 */
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from 'crypto';
import {
  parseAccountAuthorityKeyring,
  ACCOUNT_AUTHORITY_SIGNING_KEY_VAR,
  ACCOUNT_AUTHORITY_SIGNING_KEYS_VAR,
  type AuthorityKey,
  type AuthorityKeyPrimitives,
  type AuthorityKeyring,
} from '../agent-accounts/account-authority-key';

const primitives: AuthorityKeyPrimitives = {
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

/** The whole ring: the current key signs new grants, previous keys stay identifiable during rotation. */
export function loadAccountAuthorityKeyring(env: Record<string, string | undefined> = process.env): AuthorityKeyring {
  const verdict = parseAccountAuthorityKeyring(
    { single: env[ACCOUNT_AUTHORITY_SIGNING_KEY_VAR], multi: env[ACCOUNT_AUTHORITY_SIGNING_KEYS_VAR] },
    primitives,
  );
  if (verdict.ok) return verdict.keyring;
  if (verdict.reason === 'unset') {
    throw new Error(
      `${ACCOUNT_AUTHORITY_SIGNING_KEY_VAR} (or ${ACCOUNT_AUTHORITY_SIGNING_KEYS_VAR}) is required: the account authority signs every credential grant with it and never falls back to an ephemeral key`,
    );
  }
  if (verdict.reason === 'duplicate_key') {
    throw new Error(`${ACCOUNT_AUTHORITY_SIGNING_KEYS_VAR} lists the same key twice (entry ${verdict.index})`);
  }
  throw new Error(
    `${ACCOUNT_AUTHORITY_SIGNING_KEY_VAR} / ${ACCOUNT_AUTHORITY_SIGNING_KEYS_VAR} entries must be base64-encoded PKCS#8 Ed25519 private keys (entry ${verdict.index} is not)`,
  );
}

/** The CURRENT key — what new grants are signed with. */
export function loadAccountAuthoritySigningKey(env: Record<string, string | undefined> = process.env): AuthorityKey {
  return loadAccountAuthorityKeyring(env).current;
}
