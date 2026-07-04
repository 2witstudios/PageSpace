import { describe, expect, it, vi } from 'vitest';
import { NetworkError } from '@pagespace/sdk';
import type { HostCredential } from '../../../credentials/serialize.js';
import type { CredentialStore } from '../../../credentials/store.js';
import { resolveTokensSession } from '../session.js';

function fakeStore(initial: Map<string, HostCredential> = new Map()): CredentialStore {
  return {
    get: vi.fn(async (host: string) => initial.get(host) ?? null),
    set: vi.fn(async (host: string, credential: HostCredential) => {
      initial.set(host, credential);
    }),
    delete: vi.fn(async (host: string) => {
      initial.delete(host);
    }),
    list: vi.fn(async () => []),
  };
}

const STORED: HostCredential = {
  refreshToken: 'ps_rt_old',
  clientId: 'pagespace-cli',
  scopes: ['account', 'offline_access'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

function baseDeps(overrides: Partial<Parameters<typeof resolveTokensSession>[2]> = {}) {
  return {
    createCredentialStore: vi.fn(() => fakeStore()),
    createRefreshAccessToken: vi.fn(() => async () => ({
      accessToken: 'ps_at_new',
      accessExpiresAt: Date.now() + 900_000,
      refreshToken: 'ps_rt_new',
      refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    })),
    now: () => Date.parse('2026-07-03T00:00:00.000Z'),
    ...overrides,
  };
}

describe('resolveTokensSession', () => {
  it('uses --token as-is and never touches the credential store', async () => {
    const createCredentialStore = vi.fn(() => fakeStore());
    const deps = baseDeps({ createCredentialStore });

    const result = await resolveTokensSession(
      { env: {} },
      { flags: { token: 'mcp_explicit', host: undefined, json: false, yes: false, help: false, version: false } },
      deps,
    );

    expect(result.outcome).toBe('ok');
    expect(createCredentialStore).not.toHaveBeenCalled();
  });

  it('uses PAGESPACE_TOKEN env when no --token flag is given', async () => {
    const createCredentialStore = vi.fn(() => fakeStore());
    const deps = baseDeps({ createCredentialStore });

    const result = await resolveTokensSession(
      { env: { PAGESPACE_TOKEN: 'mcp_from_env' } },
      { flags: { token: undefined, host: undefined, json: false, yes: false, help: false, version: false } },
      deps,
    );

    expect(result.outcome).toBe('ok');
    expect(createCredentialStore).not.toHaveBeenCalled();
  });

  it('returns unauthenticated when there is no flag/env token and no stored profile', async () => {
    const store = fakeStore();
    const deps = baseDeps({ createCredentialStore: () => store });

    const result = await resolveTokensSession(
      { env: {} },
      { flags: { token: undefined, host: undefined, json: false, yes: false, help: false, version: false } },
      deps,
    );

    expect(result.outcome).toBe('unauthenticated');
    expect(store.get).toHaveBeenCalledWith('https://pagespace.ai');
  });

  it('refreshes a stored profile and persists the rotated refresh token before returning ok', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', STORED]]));
    const deps = baseDeps({ createCredentialStore: () => store });

    const result = await resolveTokensSession(
      { env: {} },
      { flags: { token: undefined, host: undefined, json: false, yes: false, help: false, version: false } },
      deps,
    );

    expect(result.outcome).toBe('ok');
    expect(store.set).toHaveBeenCalledWith('https://pagespace.ai', {
      refreshToken: 'ps_rt_new',
      clientId: 'pagespace-cli',
      scopes: ['account', 'offline_access'],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('never persists the old refresh token value after a successful rotation', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', STORED]]));
    const deps = baseDeps({ createCredentialStore: () => store });

    await resolveTokensSession(
      { env: {} },
      { flags: { token: undefined, host: undefined, json: false, yes: false, help: false, version: false } },
      deps,
    );

    const setCalls = vi.mocked(store.set).mock.calls;
    expect(setCalls.some(([, credential]) => credential.refreshToken === 'ps_rt_old')).toBe(false);
  });

  it('maps a terminal refresh rejection to unauthenticated without persisting anything', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', STORED]]));
    const deps = baseDeps({
      createCredentialStore: () => store,
      createRefreshAccessToken: () => async () => {
        throw new Error('invalid_grant');
      },
    });

    const result = await resolveTokensSession(
      { env: {} },
      { flags: { token: undefined, host: undefined, json: false, yes: false, help: false, version: false } },
      deps,
    );

    expect(result.outcome).toBe('unauthenticated');
    expect(store.set).not.toHaveBeenCalled();
  });

  it('propagates a retryable (network) refresh failure instead of reporting unauthenticated', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', STORED]]));
    const deps = baseDeps({
      createCredentialStore: () => store,
      createRefreshAccessToken: () => async () => {
        throw new NetworkError('offline');
      },
    });

    await expect(
      resolveTokensSession(
        { env: {} },
        { flags: { token: undefined, host: undefined, json: false, yes: false, help: false, version: false } },
        deps,
      ),
    ).rejects.toThrow('offline');
  });

  it('treats a persistence failure after a successful refresh as unauthenticated (credential lost)', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', STORED]]));
    store.set = vi.fn(async () => {
      throw new Error('disk full');
    });
    const deps = baseDeps({ createCredentialStore: () => store });

    const result = await resolveTokensSession(
      { env: {} },
      { flags: { token: undefined, host: undefined, json: false, yes: false, help: false, version: false } },
      deps,
    );

    expect(result.outcome).toBe('unauthenticated');
  });

  it('resolves the host from --host before falling back to the default', async () => {
    const store = fakeStore();
    const deps = baseDeps({ createCredentialStore: () => store });

    await resolveTokensSession(
      { env: {} },
      { flags: { token: undefined, host: 'https://self-hosted.example', json: false, yes: false, help: false, version: false } },
      deps,
    );

    expect(store.get).toHaveBeenCalledWith('https://self-hosted.example');
  });
});
