/**
 * OS keychain adapter (macOS Keychain / libsecret / Windows Credential Manager)
 * via `@napi-rs/keyring` — actively maintained, prebuilt per-platform binaries
 * (no node-gyp compile step for consumers), thin wrapper over `keyring-rs`.
 * Injected behind `KeychainAdapter` so the composite store (store.ts) and its
 * tests never touch the native binding directly.
 */
import { AsyncEntry, findCredentialsAsync } from '@napi-rs/keyring';

const SERVICE = 'pagespace-cli';

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

export function createNativeKeychainAdapter(): KeychainAdapter {
  return {
    async getSecret(account: string): Promise<string | null> {
      const entry = new AsyncEntry(SERVICE, account);
      const value = await entry.getPassword();
      return value ?? null;
    },

    async setSecret(account: string, secret: string): Promise<void> {
      const entry = new AsyncEntry(SERVICE, account);
      await entry.setPassword(secret);
    },

    async deleteSecret(account: string): Promise<void> {
      const entry = new AsyncEntry(SERVICE, account);
      await entry.deletePassword();
    },

    async listSecrets(): Promise<readonly KeychainCredential[]> {
      const credentials = await findCredentialsAsync(SERVICE);
      return credentials.map((credential) => ({ account: credential.account, secret: credential.password }));
    },
  };
}
