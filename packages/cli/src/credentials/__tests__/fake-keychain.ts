import type { KeychainAdapter, KeychainCredential } from '@pagespace/cli';

/** In-memory `KeychainAdapter` standing in for a working OS keychain in tests. */
export function createFakeKeychainAdapter(): KeychainAdapter & { readonly calls: string[] } {
  const secrets = new Map<string, string>();
  const calls: string[] = [];
  return {
    calls,
    async getSecret(account: string) {
      calls.push(`getSecret:${account}`);
      return secrets.get(account) ?? null;
    },
    async setSecret(account: string, secret: string) {
      calls.push(`setSecret:${account}`);
      secrets.set(account, secret);
    },
    async deleteSecret(account: string) {
      calls.push(`deleteSecret:${account}`);
      secrets.delete(account);
    },
    async listSecrets(): Promise<readonly KeychainCredential[]> {
      calls.push('listSecrets');
      return [...secrets.entries()].map(([account, secret]) => ({ account, secret }));
    },
  };
}

/** A `KeychainAdapter` that always throws, simulating an unavailable OS keychain. */
export function createUnavailableKeychainAdapter(message = 'no secret service running'): KeychainAdapter & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  const fail = (label: string): never => {
    calls.push(label);
    throw new Error(message);
  };
  return {
    calls,
    async getSecret(account: string) {
      return fail(`getSecret:${account}`);
    },
    async setSecret(account: string) {
      return fail(`setSecret:${account}`);
    },
    async deleteSecret(account: string) {
      return fail(`deleteSecret:${account}`);
    },
    async listSecrets() {
      return fail('listSecrets');
    },
  };
}
