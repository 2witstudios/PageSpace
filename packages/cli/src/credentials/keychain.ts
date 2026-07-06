/**
 * OS keychain adapter (macOS Keychain / libsecret / Windows Credential Manager)
 * via `@napi-rs/keyring` — actively maintained, prebuilt per-platform binaries
 * (no node-gyp compile step for consumers), thin wrapper over `keyring-rs`.
 * Injected behind `KeychainAdapter` so the composite store (store.ts) and its
 * tests never touch the native binding directly.
 *
 * The native module is loaded lazily (`import(...)`, not a static top-level
 * import) and only on the first adapter method call, cached per adapter
 * instance thereafter. A static top-level import would throw at module-load
 * time on a platform with no prebuilt `@napi-rs/keyring` binding — before
 * `CompositeCredentialStore`'s try/catch (`store.ts`) ever runs, crashing
 * the CLI at startup instead of degrading to the file store. A lazy,
 * per-method-call load surfaces that same failure as a normal rejected
 * promise from `getSecret`/`setSecret`/etc., which `CompositeCredentialStore`
 * already catches and degrades on.
 */
import { DEFAULT_PROFILE_NAME } from './serialize.js';

export type KeyringModule = typeof import('@napi-rs/keyring');
export type LoadKeyring = () => Promise<KeyringModule>;

const SERVICE = 'pagespace-cli';

const defaultLoadKeyring: LoadKeyring = () => import('@napi-rs/keyring');

/**
 * Every existing keychain entry was written with the account key set to the
 * plain host string (one credential per host). A NUL byte can never appear
 * in a URL/hostname, so using it as a separator lets a "default"-profile
 * account key stay byte-for-byte identical to what's already on disk in
 * users' OS keychains (zero behavior change on upgrade) while any
 * additionally-named profile gets a distinct, unambiguous account key —
 * unlike a printable delimiter such as ":", which collides with hosts that
 * already contain one (e.g. "https://..." or "localhost:3000").
 */
const PROFILE_KEY_SEPARATOR = '\u0000';

/**
 * `keychainAccountKey`/`parseKeychainAccountKey` are re-exported as public
 * library API (see `index.ts`), so a caller other than this package's own
 * CLI argv parsing (which can never carry a NUL byte) could otherwise pass a
 * `host`/`profile` containing the separator itself and collide two distinct
 * pairs onto the same account key — e.g. `("A\0B", "C")` and `("A", "B\0C")`
 * both encode to `"A\0B\0C"`, so one pair's `set()` would silently overwrite
 * the other's keychain entry. Reject the separator at this boundary so no
 * caller can construct that collision.
 */
export function keychainAccountKey(host: string, profile: string = DEFAULT_PROFILE_NAME): string {
  if (host.includes(PROFILE_KEY_SEPARATOR) || profile.includes(PROFILE_KEY_SEPARATOR)) {
    throw new Error('Host and profile names must not contain a NUL byte.');
  }
  return profile === DEFAULT_PROFILE_NAME ? host : `${host}${PROFILE_KEY_SEPARATOR}${profile}`;
}

export interface KeychainAccount {
  readonly host: string;
  readonly profile: string;
}

export function parseKeychainAccountKey(account: string): KeychainAccount {
  const separatorIndex = account.indexOf(PROFILE_KEY_SEPARATOR);
  if (separatorIndex === -1) {
    return { host: account, profile: DEFAULT_PROFILE_NAME };
  }
  return { host: account.slice(0, separatorIndex), profile: account.slice(separatorIndex + 1) };
}

export interface KeychainCredential {
  readonly account: string;
  readonly secret: string;
}

export interface KeychainAdapter {
  getSecret(account: string): Promise<string | null>;
  setSecret(account: string, secret: string): Promise<void>;
  deleteSecret(account: string): Promise<void>;
  listSecrets(): Promise<readonly KeychainCredential[]>;
}

export function createNativeKeychainAdapter(loadKeyring: LoadKeyring = defaultLoadKeyring): KeychainAdapter {
  let modulePromise: Promise<KeyringModule> | null = null;
  function load(): Promise<KeyringModule> {
    if (modulePromise === null) {
      modulePromise = loadKeyring();
    }
    return modulePromise;
  }

  return {
    async getSecret(account: string): Promise<string | null> {
      const { AsyncEntry } = await load();
      const entry = new AsyncEntry(SERVICE, account);
      const value = await entry.getPassword();
      return value ?? null;
    },

    async setSecret(account: string, secret: string): Promise<void> {
      const { AsyncEntry } = await load();
      const entry = new AsyncEntry(SERVICE, account);
      await entry.setPassword(secret);
    },

    async deleteSecret(account: string): Promise<void> {
      const { AsyncEntry } = await load();
      const entry = new AsyncEntry(SERVICE, account);
      await entry.deletePassword();
    },

    async listSecrets(): Promise<readonly KeychainCredential[]> {
      const { findCredentialsAsync } = await load();
      const credentials = await findCredentialsAsync(SERVICE);
      return credentials.map((credential) => ({ account: credential.account, secret: credential.password }));
    },
  };
}
