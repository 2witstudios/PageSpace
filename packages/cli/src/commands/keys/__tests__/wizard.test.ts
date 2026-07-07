import { describe, expect, it, vi } from 'vitest';
import type { PageSpaceClient } from '@pagespace/sdk';
import type { CredentialStore, HostCredential, LoopbackCallback, LoopbackServer } from '@pagespace/cli';
import { parseArgv } from '../../../argv/parse.js';
import type { CommandIntent } from '../../../argv/parse.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../../exit-codes.js';
import { credentialSecret } from '../../../credentials/serialize.js';
import { createFakeContext, createRecordingSink } from '../../../__tests__/fake-context.js';

// `vi.mock` factories are hoisted above every top-level `const` in this file,
// so anything the factory closes over must itself be created via
// `vi.hoisted` — a plain `const` declared below would still be in its
// temporal dead zone when the (hoisted) factory runs.
const { selectMock, multiselectMock, textMock, confirmMock, introMock, outroMock, cancelMock, noteMock, logMock, spinnerHandle, CANCEL_SENTINEL } = vi.hoisted(
  () => ({
    selectMock: vi.fn(),
    multiselectMock: vi.fn(),
    textMock: vi.fn(),
    confirmMock: vi.fn(),
    introMock: vi.fn(),
    outroMock: vi.fn(),
    cancelMock: vi.fn(),
    noteMock: vi.fn(),
    logMock: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), message: vi.fn() },
    spinnerHandle: { start: vi.fn(), stop: vi.fn(), error: vi.fn(), message: vi.fn(), clear: vi.fn(), isCancelled: false },
    CANCEL_SENTINEL: Symbol('cancel'),
  }),
);

vi.mock('@clack/prompts', () => ({
  intro: (...args: unknown[]) => introMock(...args),
  outro: (...args: unknown[]) => outroMock(...args),
  cancel: (...args: unknown[]) => cancelMock(...args),
  note: (...args: unknown[]) => noteMock(...args),
  log: logMock,
  select: (...args: unknown[]) => selectMock(...args),
  multiselect: (...args: unknown[]) => multiselectMock(...args),
  text: (...args: unknown[]) => textMock(...args),
  confirm: (...args: unknown[]) => confirmMock(...args),
  spinner: () => spinnerHandle,
  // No mocked prompt in these tests ever resolves to this sentinel — every
  // prompt below resolves a real scripted answer, never a cancellation.
  isCancel: (value: unknown) => value === CANCEL_SENTINEL,
}));

function commandIntent(argv: string[]): CommandIntent {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error('expected command');
  return { ...parsed, args: parsed.args.slice(2) };
}

function fakeStore(): CredentialStore {
  const hosts = new Map<string, Map<string, HostCredential>>();
  return {
    get: async (host, profile = 'default') => hosts.get(host)?.get(profile) ?? null,
    set: async (host, credential, profile = 'default') => {
      const profiles = hosts.get(host) ?? new Map<string, HostCredential>();
      profiles.set(profile, credential);
      hosts.set(host, profiles);
    },
    delete: async (host, profile = 'default') => {
      hosts.get(host)?.delete(profile);
    },
    list: async (profile = 'default') =>
      [...hosts.entries()].filter(([, profiles]) => profiles.has(profile)).map(([host, profiles]) => ({ host, tokenPrefix: credentialSecret(profiles.get(profile)!).slice(0, 12) })),
  };
}

function fakeLoopbackServer(port = 55555) {
  let pendingResolve: ((cb: LoopbackCallback) => void) | null = null;
  let buffered: LoopbackCallback | null = null;
  const server: LoopbackServer = {
    port,
    nextCallback: () => {
      if (buffered) {
        const callback = buffered;
        buffered = null;
        return Promise.resolve(callback);
      }
      return new Promise((resolve) => {
        pendingResolve = resolve;
      });
    },
    finish: async () => {},
    close: async () => {},
  };
  return {
    server,
    deliver: (query: Record<string, string>) => {
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve({ query });
      } else {
        buffered = { query };
      }
    },
  };
}

const FIXED_TOKENS = { kind: 'oauth' as const, accessToken: 'ps_at_test', refreshToken: 'ps_rt_test', expiresIn: 900, scope: 'drive:drv1:member offline_access' };

function baseMintDeps(store: CredentialStore) {
  return {
    createCredentialStore: () => store,
    randomBytes: (n: number) => new Uint8Array(n).fill(7),
    discoverMetadata: async () => ({
      authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
      tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
    }),
    startServer: async () => fakeLoopbackServer().server,
    openBrowser: async () => true,
    waitMs: () => new Promise<void>(() => {}),
    exchangeCode: async () => FIXED_TOKENS,
    confirmIdentity: async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' }),
    now: () => Date.parse('2026-07-06T00:00:00.000Z'),
  };
}

function autoApprove(fake: ReturnType<typeof fakeLoopbackServer>) {
  return async (url: string) => {
    const state = new URL(url).searchParams.get('state')!;
    queueMicrotask(() => fake.deliver({ code: 'auth-code', state }));
    return true;
  };
}

function fakeSdk(overrides: {
  drivesList?: ReturnType<typeof vi.fn>;
  rolesList?: ReturnType<typeof vi.fn>;
  tokensList?: ReturnType<typeof vi.fn>;
  tokensRevoke?: ReturnType<typeof vi.fn>;
}): PageSpaceClient {
  return {
    drives: { list: overrides.drivesList ?? vi.fn(async () => []) },
    roles: { list: overrides.rolesList ?? vi.fn(async () => ({ roles: [] })) },
    tokens: {
      list: overrides.tokensList ?? vi.fn(async () => []),
      revoke: overrides.tokensRevoke ?? vi.fn(async () => ({ message: 'Token revoked successfully' })),
    },
  } as unknown as PageSpaceClient;
}

describe('createKeysHandler — non-interactive', () => {
  it('fails closed with no clack.intro/interaction at all', async () => {
    const { createKeysHandler } = await import('../wizard.js');
    const handler = createKeysHandler(baseMintDeps(fakeStore()));
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, isTTY: false });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('keys create');
    expect(introMock).not.toHaveBeenCalled();
  });
});

describe('createKeysHandler — Create flow', () => {
  it('wires drive multiselect -> role select -> profile name -> mint, storing the credential under the chosen profile', async () => {
    selectMock.mockReset().mockResolvedValueOnce('create').mockResolvedValueOnce({ kind: 'member' }).mockResolvedValueOnce('exit');
    multiselectMock.mockReset().mockResolvedValueOnce(['drv1']);
    textMock.mockReset().mockResolvedValueOnce('my-profile');
    confirmMock.mockReset().mockResolvedValueOnce(true);

    const { createKeysHandler } = await import('../wizard.js');
    const store = fakeStore();
    const fake = fakeLoopbackServer();
    const createCredentialStore = vi.fn(() => store);
    const deps = { ...baseMintDeps(store), createCredentialStore, startServer: async () => fake.server, openBrowser: autoApprove(fake) };
    const handler = createKeysHandler(deps);

    const drivesList = vi.fn(async () => [{ id: 'drv1', name: 'Engineering', slug: 'eng', ownerId: 'u1', kind: 'STANDARD', isTrashed: false, trashedAt: null, drivePrompt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: true, role: 'OWNER', lastAccessedAt: null, homePageId: null }]);
    const sdk = fakeSdk({ drivesList, tokensList: vi.fn(async () => []) });
    const ctx = createFakeContext({ sdk, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(drivesList).toHaveBeenCalledWith({ tokenScopable: true });
    const stored = await store.get('https://pagespace.ai', 'my-profile');
    expect(stored && credentialSecret(stored)).toBe(FIXED_TOKENS.refreshToken);
    expect(introMock).toHaveBeenCalled();
    expect(outroMock).toHaveBeenCalledWith('Bye.');
    // The overwrite-check and the mint itself must share ONE CompositeCredentialStore
    // instance per flow — two independently constructed stores would each probe
    // (and potentially degrade) the OS keychain separately for one logical operation.
    expect(createCredentialStore).toHaveBeenCalledTimes(1);
  });
});

describe('createKeysHandler — unknown "keys" subcommand', () => {
  it('reports a usage error instead of silently falling through to the bare wizard on a typo', async () => {
    const { createKeysHandler } = await import('../wizard.js');
    const handler = createKeysHandler(baseMintDeps(fakeStore()));
    introMock.mockReset();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, isTTY: true });

    // The bare `keys` route is only ONE path segment (unlike ['keys','list']'s
    // two), so only that one token is stripped before the handler sees `intent.args`.
    const parsed = parseArgv(['keys', 'lsit']);
    if (parsed.kind !== 'command') throw new Error('expected command');
    const code = await handler(ctx, { ...parsed, args: parsed.args.slice(1) });

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('lsit');
    expect(introMock).not.toHaveBeenCalled();
  });
});

describe('createKeysHandler — Revoke flow', () => {
  it('wires key select -> confirm -> ctx.sdk.tokens.revoke', async () => {
    selectMock.mockReset().mockResolvedValueOnce('revoke').mockResolvedValueOnce('tok1').mockResolvedValueOnce('exit');
    confirmMock.mockReset().mockResolvedValueOnce(true);

    const { createKeysHandler } = await import('../wizard.js');
    const handler = createKeysHandler(baseMintDeps(fakeStore()));

    const tokensRevoke = vi.fn(async () => ({ message: 'Token revoked successfully' }));
    const tokensList = vi.fn(async () => [
      { id: 'tok1', name: 'CI bot', tokenPrefix: 'mcp_abcdefghijk', lastUsed: null, createdAt: '2026-07-01T00:00:00.000Z', isScoped: false, driveScopes: [] },
    ]);
    const sdk = fakeSdk({ tokensList, tokensRevoke });
    const ctx = createFakeContext({ sdk, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(tokensRevoke).toHaveBeenCalledWith({ tokenId: 'tok1' });
  });
});
