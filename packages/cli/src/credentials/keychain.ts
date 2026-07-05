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

export type KeyringModule = typeof import('@napi-rs/keyring');
export type LoadKeyring = () => Promise<KeyringModule>;

const SERVICE = 'pagespace-cli';

const defaultLoadKeyring: LoadKeyring = () => import('@napi-rs/keyring');

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
