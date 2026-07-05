import { describe, expect, it, vi } from 'vitest';
import { createNativeKeychainAdapter, keychainAccountKey, parseKeychainAccountKey, type KeyringModule } from '../keychain.js';

function fakeKeyringModule(overrides: Partial<{ passwords: Map<string, string> }> = {}) {
  const passwords = overrides.passwords ?? new Map<string, string>();
  class FakeAsyncEntry {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {}
    async getPassword(): Promise<string | null> {
      return passwords.get(this.account) ?? null;
    }
    async setPassword(secret: string): Promise<void> {
      passwords.set(this.account, secret);
    }
    async deletePassword(): Promise<void> {
      passwords.delete(this.account);
    }
  }
  async function findCredentialsAsync(_service: string) {
    return [...passwords.entries()].map(([account, password]) => ({ account, password }));
  }
  return { AsyncEntry: FakeAsyncEntry, findCredentialsAsync } as unknown as KeyringModule;
}

describe('createNativeKeychainAdapter — lazy load', () => {
  it('does not load the native module at construction time (lazy)', () => {
    const loadKeyring = vi.fn(async () => fakeKeyringModule());
    createNativeKeychainAdapter(loadKeyring);

    expect(loadKeyring).not.toHaveBeenCalled();
  });

  it('loads the native module only once across multiple method calls', async () => {
    const loadKeyring = vi.fn(async () => fakeKeyringModule());
    const adapter = createNativeKeychainAdapter(loadKeyring);

    await adapter.getSecret('a');
    await adapter.setSecret('b', 'secret');
    await adapter.listSecrets();

    expect(loadKeyring).toHaveBeenCalledTimes(1);
  });

  it('delegates to the loaded module on success', async () => {
    const loadKeyring = vi.fn(async () => fakeKeyringModule());
    const adapter = createNativeKeychainAdapter(loadKeyring);

    await adapter.setSecret('pagespace.ai', 'top-secret');
    expect(await adapter.getSecret('pagespace.ai')).toBe('top-secret');

    const listed = await adapter.listSecrets();
    expect(listed).toEqual([{ account: 'pagespace.ai', secret: 'top-secret' }]);

    await adapter.deleteSecret('pagespace.ai');
    expect(await adapter.getSecret('pagespace.ai')).toBeNull();
  });
});

describe('keychainAccountKey / parseKeychainAccountKey — per-profile namespacing', () => {
  it('the "default" profile keeps the plain host as its account key (backward compatible with existing keychain entries)', () => {
    expect(keychainAccountKey('https://pagespace.ai')).toBe('https://pagespace.ai');
    expect(keychainAccountKey('https://pagespace.ai', 'default')).toBe('https://pagespace.ai');
  });

  it('a named, non-default profile gets a distinct account key that still contains the host', () => {
    const account = keychainAccountKey('https://pagespace.ai', 'work');
    expect(account).not.toBe('https://pagespace.ai');
    expect(account).toContain('https://pagespace.ai');
  });

  it('different profiles for the same host never collide', () => {
    const a = keychainAccountKey('https://pagespace.ai', 'work');
    const b = keychainAccountKey('https://pagespace.ai', 'personal');
    expect(a).not.toBe(b);
  });

  it('round-trips host + profile through parseKeychainAccountKey', () => {
    expect(parseKeychainAccountKey(keychainAccountKey('https://pagespace.ai'))).toEqual({
      host: 'https://pagespace.ai',
      profile: 'default',
    });
    expect(parseKeychainAccountKey(keychainAccountKey('https://pagespace.ai', 'work'))).toEqual({
      host: 'https://pagespace.ai',
      profile: 'work',
    });
  });

  it('a host containing a colon (e.g. self-hosted with an explicit port) still round-trips correctly for a named profile', () => {
    const account = keychainAccountKey('https://self-hosted.example:8443', 'work');
    expect(parseKeychainAccountKey(account)).toEqual({ host: 'https://self-hosted.example:8443', profile: 'work' });
  });

  it('a bare host with no encoded profile parses as the "default" profile', () => {
    expect(parseKeychainAccountKey('https://pagespace.ai')).toEqual({ host: 'https://pagespace.ai', profile: 'default' });
  });
});

describe('createNativeKeychainAdapter — missing native binding degrades cleanly', () => {
  it('getSecret rejects with a normal, catchable error instead of crashing the process', async () => {
    const loadKeyring = vi.fn(async () => {
      throw new Error('no prebuilt @napi-rs/keyring binding for this platform');
    });
    const adapter = createNativeKeychainAdapter(loadKeyring);

    await expect(adapter.getSecret('pagespace.ai')).rejects.toThrow('no prebuilt @napi-rs/keyring binding for this platform');
  });

  it('setSecret/deleteSecret/listSecrets all reject the same catchable way', async () => {
    const loadKeyring = vi.fn(async () => {
      throw new Error('load failed');
    });
    const adapter = createNativeKeychainAdapter(loadKeyring);

    await expect(adapter.setSecret('h', 's')).rejects.toThrow('load failed');
    await expect(adapter.deleteSecret('h')).rejects.toThrow('load failed');
    await expect(adapter.listSecrets()).rejects.toThrow('load failed');
  });

  it('a load failure is exactly the kind of error CompositeCredentialStore already degrades on (no crash reaches the caller)', async () => {
    const { CompositeCredentialStore } = await import('../store.js');
    const loadKeyring = vi.fn(async () => {
      throw new Error('keyring service not found');
    });
    const adapter = createNativeKeychainAdapter(loadKeyring);
    const lines: string[] = [];
    const fileCalls: string[] = [];
    const fakeFileStore = {
      async get() {
        return null;
      },
      async set() {
        fileCalls.push('set');
      },
      async delete() {},
      async list() {
        return [];
      },
    };
    const store = new CompositeCredentialStore(adapter, fakeFileStore, { write: (chunk: string) => lines.push(chunk) });

    await expect(
      store.set('pagespace.ai', { refreshToken: 'ps_rt_x', clientId: 'pagespace-cli', scopes: [], createdAt: new Date(0).toISOString() }),
    ).resolves.toBeUndefined();
    expect(fileCalls).toEqual(['set']);
    expect(lines.some((line) => /keychain unavailable/i.test(line))).toBe(true);
  });
});
