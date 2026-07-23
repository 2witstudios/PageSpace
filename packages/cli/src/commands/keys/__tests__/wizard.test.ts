import { describe, expect, it, vi } from 'vitest';
import type { PageSpaceClient } from '@pagespace/sdk';
import type { CredentialStore, DeviceTokenResult, HostCredential, LoopbackCallback, LoopbackServer } from '@pagespace/cli';
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
    requestDeviceAuthorization: async () => {
      throw new Error('device flow not exercised by this test — loopback transport expected');
    },
    pollDeviceToken: async () => {
      throw new Error('device flow not exercised by this test — loopback transport expected');
    },
    createIsInterrupted: () => () => false,
    deviceWaitMs: async () => {},
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
  it('wires drive multiselect -> role select -> key name -> mint, storing the credential under the chosen name', async () => {
    selectMock
      .mockReset()
      .mockResolvedValueOnce('create')
      .mockResolvedValueOnce('specific')
      .mockResolvedValueOnce({ kind: 'member' })
      .mockResolvedValueOnce('exit');
    multiselectMock.mockReset().mockResolvedValueOnce(['drv1']);
    textMock.mockReset().mockResolvedValueOnce('my-key');
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
    const stored = await store.get('https://pagespace.ai', 'my-key');
    expect(stored && credentialSecret(stored)).toBe(FIXED_TOKENS.refreshToken);
    expect(introMock).toHaveBeenCalled();
    expect(outroMock).toHaveBeenCalledWith('Bye.');
    // The overwrite-check and the mint itself must share ONE CompositeCredentialStore
    // instance per flow — two independently constructed stores would each probe
    // (and potentially degrade) the OS keychain separately for one logical operation.
    expect(createCredentialStore).toHaveBeenCalledTimes(1);
  });
});

describe('createKeysHandler — Create flow, --all-drives', () => {
  it('up-front "all drives" choice skips the drive multiselect entirely, requires a name, and mints all_drives offline_access', async () => {
    selectMock.mockReset().mockResolvedValueOnce('create').mockResolvedValueOnce('all').mockResolvedValueOnce('exit');
    multiselectMock.mockReset();
    textMock.mockReset().mockResolvedValueOnce('god-key');
    confirmMock.mockReset().mockResolvedValueOnce(true);

    const { createKeysHandler } = await import('../wizard.js');
    const store = fakeStore();
    const fake = fakeLoopbackServer();
    let requestedScope: string | undefined;
    const deps = {
      ...baseMintDeps(store),
      startServer: async () => fake.server,
      openBrowser: async (url: string) => {
        requestedScope = new URL(url).searchParams.get('scope') ?? undefined;
        return autoApprove(fake)(url);
      },
    };
    const handler = createKeysHandler(deps);

    const drivesList = vi.fn(async () => [{ id: 'drv1', name: 'Engineering', slug: 'eng', ownerId: 'u1', kind: 'STANDARD', isTrashed: false, trashedAt: null, drivePrompt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: true, role: 'OWNER', lastAccessedAt: null, homePageId: null }]);
    const sdk = fakeSdk({ drivesList, tokensList: vi.fn(async () => []) });
    const ctx = createFakeContext({ sdk, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(multiselectMock).not.toHaveBeenCalled();
    expect(requestedScope).toBe('all_drives name:god-key offline_access');
    // The pre-mint confirm gets the maximum-privilege wording, not the raw scope string.
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/maximum-privilege/i) }),
    );
    const stored = await store.get('https://pagespace.ai', 'god-key');
    expect(stored && credentialSecret(stored)).toBe(FIXED_TOKENS.refreshToken);
    const stopMessages = spinnerHandle.stop.mock.calls.flat().map(String).join('\n');
    expect(stopMessages).toContain('scoped to: all drives.');
  });

  it('the name prompt\'s validate callback rejects an empty name for --all-drives (no drive id to default to)', async () => {
    selectMock.mockReset().mockResolvedValueOnce('create').mockResolvedValueOnce('all').mockResolvedValueOnce('exit');
    multiselectMock.mockReset();
    let capturedValidate: ((value: string) => string | undefined) | undefined;
    textMock.mockReset().mockImplementationOnce(async (opts: { validate?: (value: string) => string | undefined }) => {
      capturedValidate = opts.validate;
      return 'god-key';
    });
    confirmMock.mockReset().mockResolvedValueOnce(false);

    const { createKeysHandler } = await import('../wizard.js');
    const store = fakeStore();
    const handler = createKeysHandler(baseMintDeps(store));
    const drivesList = vi.fn(async () => [{ id: 'drv1', name: 'Engineering', slug: 'eng', ownerId: 'u1', kind: 'STANDARD', isTrashed: false, trashedAt: null, drivePrompt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: true, role: 'OWNER', lastAccessedAt: null, homePageId: null }]);
    const sdk = fakeSdk({ drivesList, tokensList: vi.fn(async () => []) });
    const ctx = createFakeContext({ sdk, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(capturedValidate?.('')).toMatch(/--all-drives/);
  });
});

describe('createKeysHandler — Create flow, mcp-kind mint (the production shape for drive-scoped keys)', () => {
  const MCP_TOKENS = { kind: 'mcp' as const, token: 'mcp_wizard_tok', scope: 'drive:drv1:member offline_access' };
  const DRIVE_ROW = { id: 'drv1', name: 'Engineering', slug: 'eng', ownerId: 'u1', kind: 'STANDARD', isTrashed: false, trashedAt: null, drivePrompt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: true, role: 'OWNER', lastAccessedAt: null, homePageId: null };

  function mcpCreateHandlerSetup() {
    const store = fakeStore();
    const fake = fakeLoopbackServer();
    const deps = {
      ...baseMintDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
      exchangeCode: async () => MCP_TOKENS,
    };
    const sdk = fakeSdk({ drivesList: vi.fn(async () => [DRIVE_ROW]), tokensList: vi.fn(async () => []) });
    return { deps, sdk, store };
  }

  it('offers the show-once token note when accepted, then always prints the agent-wiring guidance', async () => {
    selectMock
      .mockReset()
      .mockResolvedValueOnce('create')
      .mockResolvedValueOnce('specific')
      .mockResolvedValueOnce({ kind: 'member' })
      .mockResolvedValueOnce('exit');
    multiselectMock.mockReset().mockResolvedValueOnce(['drv1']);
    textMock.mockReset().mockResolvedValueOnce('my-key');
    // 1st confirm: proceed with the mint; 2nd confirm: show the token.
    confirmMock.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    noteMock.mockReset();

    const { createKeysHandler } = await import('../wizard.js');
    const { deps, sdk } = mcpCreateHandlerSetup();
    const handler = createKeysHandler(deps);
    const ctx = createFakeContext({ sdk, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    const notes = noteMock.mock.calls.map((call) => `${String(call[0])}\n${String(call[1] ?? '')}`);
    expect(notes.some((note) => note.includes('PAGESPACE_TOKEN=mcp_wizard_tok'))).toBe(true);
    expect(notes.some((note) => note.includes('PAGESPACE_KEY') && note.includes('"pagespace"'))).toBe(true);
  });

  it('never surfaces the raw token anywhere when the show-once confirm is declined, but still prints guidance', async () => {
    selectMock
      .mockReset()
      .mockResolvedValueOnce('create')
      .mockResolvedValueOnce('specific')
      .mockResolvedValueOnce({ kind: 'member' })
      .mockResolvedValueOnce('exit');
    multiselectMock.mockReset().mockResolvedValueOnce(['drv1']);
    textMock.mockReset().mockResolvedValueOnce('my-key');
    confirmMock.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    noteMock.mockReset();

    const { createKeysHandler } = await import('../wizard.js');
    const { deps, sdk } = mcpCreateHandlerSetup();
    const handler = createKeysHandler(deps);
    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ sdk, stdout, stderr, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    const everything = [
      ...stdout.lines,
      ...stderr.lines,
      ...noteMock.mock.calls.flat().map(String),
      ...spinnerHandle.stop.mock.calls.flat().map(String),
    ].join('\n');
    expect(everything).not.toContain('mcp_wizard_tok');
    const notes = noteMock.mock.calls.map((call) => `${String(call[0])}`);
    expect(notes.some((note) => note.includes('PAGESPACE_KEY'))).toBe(true);
  });
});

describe('createKeysHandler — Edit flow re-scopes the key IN PLACE (update_key grant, same secret)', () => {
  it('key select -> pre-selected drive multiselect -> role -> confirm -> update_key consent; no profile prompt, no revoke, nothing stored locally', async () => {
    selectMock
      .mockReset()
      .mockResolvedValueOnce('edit')
      .mockResolvedValueOnce('tok1')
      .mockResolvedValueOnce({ kind: 'member' })
      .mockResolvedValueOnce('exit');
    multiselectMock.mockReset().mockResolvedValueOnce(['drv1']);
    textMock.mockReset();
    confirmMock.mockReset().mockResolvedValueOnce(true);
    spinnerHandle.stop.mockReset();
    logMock.info.mockReset();

    const { createKeysHandler } = await import('../wizard.js');
    const store = fakeStore();
    const fake = fakeLoopbackServer();
    let requestedScope: string | undefined;
    const deps = {
      ...baseMintDeps(store),
      startServer: async () => fake.server,
      openBrowser: async (url: string) => {
        requestedScope = new URL(url).searchParams.get('scope') ?? undefined;
        return autoApprove(fake)(url);
      },
      exchangeCode: async () => ({ kind: 'mcp_update' as const, tokenId: 'tok1', scope: 'update_key:tok1 drive:drv1:member' }),
    };
    const handler = createKeysHandler(deps);

    const tokensRevoke = vi.fn(async () => ({ message: 'Token revoked successfully' }));
    const tokensList = vi.fn(async () => [
      {
        id: 'tok1',
        name: 'CI bot',
        tokenPrefix: 'mcp_abcdefghijk',
        lastUsed: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        isScoped: true,
        driveScopes: [{ id: 'drv1', name: 'Engineering', role: 'MEMBER', customRoleId: null, customRoleName: null }],
      },
    ]);
    const drivesList = vi.fn(async () => [
      { id: 'drv1', name: 'Engineering', slug: 'eng', ownerId: 'u1', kind: 'STANDARD', isTrashed: false, trashedAt: null, drivePrompt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: true, role: 'OWNER', lastAccessedAt: null, homePageId: null },
    ]);
    const sdk = fakeSdk({ drivesList, tokensList, tokensRevoke });
    const ctx = createFakeContext({ sdk, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    // The consent request carries the update_key grant, never offline_access.
    expect(requestedScope).toBe('update_key:tok1 drive:drv1:member');
    // The drive multiselect starts pre-selected on the key's current scopes.
    expect(multiselectMock).toHaveBeenCalledWith(expect.objectContaining({ initialValues: ['drv1'] }));
    // In-place semantics: no replacement key is named, nothing is stored
    // locally, and the old key is never revoked.
    expect(textMock).not.toHaveBeenCalled();
    expect(tokensRevoke).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
    const stopMessages = spinnerHandle.stop.mock.calls.flat().map(String).join('\n');
    expect(stopMessages).toMatch(/secret is unchanged/i);
    expect(stopMessages).toContain('CI bot');
    // Edit can only narrow/change specific drives, never widen to all-drives —
    // the escape hatch to `keys create --all-drives` is surfaced up front.
    expect(logMock.info).toHaveBeenCalledWith(expect.stringContaining('keys create --all-drives'));
  });

  it('narrowing an all-drives key (isScoped: false) to specific drives shows a downgrade confirm before the update consent', async () => {
    selectMock
      .mockReset()
      .mockResolvedValueOnce('edit')
      .mockResolvedValueOnce('tok1')
      .mockResolvedValueOnce({ kind: 'member' })
      .mockResolvedValueOnce('exit');
    multiselectMock.mockReset().mockResolvedValueOnce(['drv1']);
    // 1st confirm: the downgrade guard; 2nd confirm: the ordinary update confirm.
    confirmMock.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    spinnerHandle.stop.mockReset();

    const { createKeysHandler } = await import('../wizard.js');
    const store = fakeStore();
    const fake = fakeLoopbackServer();
    const deps = {
      ...baseMintDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
      exchangeCode: async () => ({ kind: 'mcp_update' as const, tokenId: 'tok1', scope: 'update_key:tok1 drive:drv1:member' }),
    };
    const handler = createKeysHandler(deps);

    const tokensList = vi.fn(async () => [
      {
        id: 'tok1',
        name: 'God key',
        tokenPrefix: 'mcp_abcdefghijk',
        lastUsed: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        isScoped: false,
        driveScopes: [],
      },
    ]);
    const drivesList = vi.fn(async () => [
      { id: 'drv1', name: 'Engineering', slug: 'eng', ownerId: 'u1', kind: 'STANDARD', isTrashed: false, trashedAt: null, drivePrompt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: true, role: 'OWNER', lastAccessedAt: null, homePageId: null },
    ]);
    const sdk = fakeSdk({ drivesList, tokensList });
    const ctx = createFakeContext({ sdk, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/currently has access to ALL your drives/i) }),
    );
    expect(confirmMock).toHaveBeenCalledTimes(2);
    const stopMessages = spinnerHandle.stop.mock.calls.flat().map(String).join('\n');
    expect(stopMessages).toMatch(/secret is unchanged/i);
  });

  it('declining the downgrade guard aborts before the update consent is ever requested', async () => {
    selectMock
      .mockReset()
      .mockResolvedValueOnce('edit')
      .mockResolvedValueOnce('tok1')
      .mockResolvedValueOnce({ kind: 'member' })
      .mockResolvedValueOnce('exit');
    multiselectMock.mockReset().mockResolvedValueOnce(['drv1']);
    confirmMock.mockReset().mockResolvedValueOnce(false);

    const { createKeysHandler } = await import('../wizard.js');
    const store = fakeStore();
    let browserOpened = false;
    const deps = {
      ...baseMintDeps(store),
      openBrowser: async () => {
        browserOpened = true;
        return true;
      },
    };
    const handler = createKeysHandler(deps);

    const tokensList = vi.fn(async () => [
      {
        id: 'tok1',
        name: 'God key',
        tokenPrefix: 'mcp_abcdefghijk',
        lastUsed: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        isScoped: false,
        driveScopes: [],
      },
    ]);
    const drivesList = vi.fn(async () => [
      { id: 'drv1', name: 'Engineering', slug: 'eng', ownerId: 'u1', kind: 'STANDARD', isTrashed: false, trashedAt: null, drivePrompt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: true, role: 'OWNER', lastAccessedAt: null, homePageId: null },
    ]);
    const sdk = fakeSdk({ drivesList, tokensList });
    const ctx = createFakeContext({ sdk, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(browserOpened).toBe(false);
  });

  it('a failed update consent surfaces the failure and revokes nothing', async () => {
    selectMock
      .mockReset()
      .mockResolvedValueOnce('edit')
      .mockResolvedValueOnce('tok1')
      .mockResolvedValueOnce({ kind: 'member' })
      .mockResolvedValueOnce('exit');
    multiselectMock.mockReset().mockResolvedValueOnce(['drv1']);
    confirmMock.mockReset().mockResolvedValueOnce(true);
    spinnerHandle.error.mockReset();

    const { createKeysHandler } = await import('../wizard.js');
    const store = fakeStore();
    const fake = fakeLoopbackServer();
    const deps = {
      ...baseMintDeps(store),
      startServer: async () => fake.server,
      openBrowser: async (url: string) => {
        const state = new URL(url).searchParams.get('state')!;
        queueMicrotask(() => fake.deliver({ error: 'access_denied', state }));
        return true;
      },
    };
    const handler = createKeysHandler(deps);

    const tokensRevoke = vi.fn(async () => ({ message: 'Token revoked successfully' }));
    const tokensList = vi.fn(async () => [
      {
        id: 'tok1',
        name: 'CI bot',
        tokenPrefix: 'mcp_abcdefghijk',
        lastUsed: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        isScoped: true,
        driveScopes: [{ id: 'drv1', name: 'Engineering', role: 'MEMBER', customRoleId: null, customRoleName: null }],
      },
    ]);
    const drivesList = vi.fn(async () => [
      { id: 'drv1', name: 'Engineering', slug: 'eng', ownerId: 'u1', kind: 'STANDARD', isTrashed: false, trashedAt: null, drivePrompt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: true, role: 'OWNER', lastAccessedAt: null, homePageId: null },
    ]);
    const sdk = fakeSdk({ drivesList, tokensList, tokensRevoke });
    const ctx = createFakeContext({ sdk, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(spinnerHandle.error).toHaveBeenCalledWith(expect.stringMatching(/denied/i));
    expect(tokensRevoke).not.toHaveBeenCalled();
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

describe('createKeysHandler — Set active key flow (menu choice "use")', () => {
  const SERVER_KEY = {
    id: 'tok1',
    name: 'CI bot',
    tokenPrefix: 'mcp_abcdefghijk',
    lastUsed: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    isScoped: true,
    driveScopes: [{ id: 'drv1', name: 'Engineering', role: 'MEMBER', customRoleId: null, customRoleName: null }],
  };

  /** The wizard's fakeStore plus the listCredentialNames enumeration the Set-active flow needs for its reverse lookup. */
  function enumerableStore(): CredentialStore {
    const base = fakeStore();
    const names = new Set<string>();
    return {
      ...base,
      set: async (host, credential, profile = 'default') => {
        names.add(profile);
        return base.set(host, credential, profile);
      },
      listCredentialNames: async () => [...names].sort(),
    };
  }

  it('key select -> activate_key consent -> records the LOCAL credential name as active, storing nothing', async () => {
    selectMock.mockReset().mockResolvedValueOnce('use').mockResolvedValueOnce('tok1').mockResolvedValueOnce('exit');
    spinnerHandle.stop.mockReset();
    logMock.info.mockReset();

    const { createKeysHandler } = await import('../wizard.js');
    const { createFakeActiveKeyStore } = await import('../../../__tests__/fake-context.js');
    const store = enumerableStore();
    await store.set(
      'https://pagespace.ai',
      { kind: 'static', token: 'mcp_abcdefghijk_full_secret', scopes: ['drive:drv1:member'], createdAt: '2026-07-01T00:00:00.000Z' },
      'my-agent',
    );

    const fake = fakeLoopbackServer();
    let requestedScope: string | undefined;
    const setSpy = vi.fn(store.set);
    const deps = {
      ...baseMintDeps({ ...store, set: setSpy }),
      startServer: async () => fake.server,
      openBrowser: async (url: string) => {
        requestedScope = new URL(url).searchParams.get('scope') ?? undefined;
        return autoApprove(fake)(url);
      },
      exchangeCode: async () => ({ kind: 'mcp_activate' as const, tokenId: 'tok1', scope: 'activate_key:tok1' }),
    };
    const handler = createKeysHandler(deps);

    const activeKeyStore = createFakeActiveKeyStore();
    const sdk = fakeSdk({ tokensList: vi.fn(async () => [SERVER_KEY]) });
    const ctx = createFakeContext({ sdk, activeKeyStore, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(requestedScope).toBe('activate_key:tok1');
    expect(activeKeyStore.entries.get('https://pagespace.ai')).toBe('my-agent');
    // Nothing was written to the credential store by the ceremony itself.
    expect(setSpy).not.toHaveBeenCalled();
    const stopMessages = spinnerHandle.stop.mock.calls.flat().map(String).join('\n');
    expect(stopMessages).toContain('"my-agent" is now the active key');
  });

  it('activates by exact name match even when listCredentialNames is broken (regression: real OS keychains have been observed truncating enumerated account names, making the reverse-lookup fallback unable to find anything)', async () => {
    selectMock.mockReset().mockResolvedValueOnce('use').mockResolvedValueOnce('tok1').mockResolvedValueOnce('exit');
    spinnerHandle.stop.mockReset();

    const { createKeysHandler } = await import('../wizard.js');
    const { createFakeActiveKeyStore } = await import('../../../__tests__/fake-context.js');
    const base = fakeStore();
    // The local profile name is IDENTICAL to the server key's name ("CI bot")
    // — exactly the case create.ts always produces (resolveNewKeyName writes
    // the name verbatim as the profile, and the same string is embedded as
    // the mint's name:<...> token). listCredentialNames simulates a real
    // truncated-keychain enumeration: it can see something is stored, but
    // never returns "CI bot" as a distinguishable name.
    const store: CredentialStore = {
      ...base,
      listCredentialNames: async () => ['default'],
    };
    await store.set(
      'https://pagespace.ai',
      { kind: 'static', token: 'mcp_abcdefghijk_full_secret', scopes: ['drive:drv1:member'], createdAt: '2026-07-01T00:00:00.000Z' },
      'CI bot',
    );

    const fake = fakeLoopbackServer();
    const deps = {
      ...baseMintDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
      exchangeCode: async () => ({ kind: 'mcp_activate' as const, tokenId: 'tok1', scope: 'activate_key:tok1' }),
    };
    const handler = createKeysHandler(deps);

    const activeKeyStore = createFakeActiveKeyStore();
    const sdk = fakeSdk({ tokensList: vi.fn(async () => [SERVER_KEY]) });
    const ctx = createFakeContext({ sdk, activeKeyStore, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(activeKeyStore.entries.get('https://pagespace.ai')).toBe('CI bot');
    const stopMessages = spinnerHandle.stop.mock.calls.flat().map(String).join('\n');
    expect(stopMessages).toContain('"CI bot" is now the active key');
  });

  it('a key with no locally stored credential cannot be activated from the wizard', async () => {
    selectMock.mockReset().mockResolvedValueOnce('use').mockResolvedValueOnce('tok1').mockResolvedValueOnce('exit');
    logMock.error.mockReset();

    const { createKeysHandler } = await import('../wizard.js');
    const { createFakeActiveKeyStore } = await import('../../../__tests__/fake-context.js');
    const store = enumerableStore();
    let browserOpened = false;
    const deps = {
      ...baseMintDeps(store),
      openBrowser: async () => {
        browserOpened = true;
        return true;
      },
    };
    const handler = createKeysHandler(deps);

    const activeKeyStore = createFakeActiveKeyStore();
    const sdk = fakeSdk({ tokensList: vi.fn(async () => [SERVER_KEY]) });
    const ctx = createFakeContext({ sdk, activeKeyStore, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(browserOpened).toBe(false);
    expect(activeKeyStore.entries.size).toBe(0);
    expect(logMock.error).toHaveBeenCalledWith(expect.stringContaining('No locally stored credential'));
  });

  it('hints the currently active key in the picker options', async () => {
    selectMock.mockReset().mockResolvedValueOnce('use').mockResolvedValueOnce(CANCEL_SENTINEL).mockResolvedValueOnce('exit');

    const { createKeysHandler } = await import('../wizard.js');
    const { createFakeActiveKeyStore } = await import('../../../__tests__/fake-context.js');
    const store = enumerableStore();
    await store.set(
      'https://pagespace.ai',
      { kind: 'static', token: 'mcp_abcdefghijk_full_secret', scopes: ['drive:drv1:member'], createdAt: '2026-07-01T00:00:00.000Z' },
      'my-agent',
    );
    const handler = createKeysHandler(baseMintDeps(store));

    const activeKeyStore = createFakeActiveKeyStore({ 'https://pagespace.ai': 'my-agent' });
    const sdk = fakeSdk({ tokensList: vi.fn(async () => [SERVER_KEY]) });
    const ctx = createFakeContext({ sdk, activeKeyStore, isTTY: true, env: {} });

    const code = await handler(ctx, commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    const pickerCall = selectMock.mock.calls.find((call) =>
      String((call[0] as { message?: unknown }).message).includes('active on this machine'),
    );
    expect(pickerCall).toBeDefined();
    const options = (pickerCall![0] as { options: Array<{ value: string; hint?: string }> }).options;
    expect(options.find((option) => option.value === 'tok1')?.hint).toContain('active');
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

/**
 * Regression guard: the wizard used to wire the device adapters into its deps
 * but never read `intent.flags.device`, so `pagespace keys --device` still
 * opened a local browser for every ceremony — and Edit, which exists ONLY in
 * the wizard, had no headless path at all.
 */
describe('createKeysHandler — --device', () => {
  const DRIVE_ROW = { id: 'drv1', name: 'Engineering', slug: 'eng', ownerId: 'u1', kind: 'STANDARD', isTrashed: false, trashedAt: null, drivePrompt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: true, role: 'OWNER', lastAccessedAt: null, homePageId: null };
  const MCP_TOKENS = { kind: 'mcp' as const, token: 'mcp_device_tok', scope: 'drive:drv1:member name:my-key offline_access' };

  function deviceSetup(pollResult: DeviceTokenResult) {
    const store = fakeStore();
    let browserOpened = false;
    let deviceScope: string | undefined;
    const deps = {
      ...baseMintDeps(store),
      openBrowser: async () => {
        browserOpened = true;
        return true;
      },
      startServer: async () => {
        throw new Error('loopback server must not start in device mode');
      },
      requestDeviceAuthorization: async ({ scope }: { scope: string }) => {
        deviceScope = scope;
        return {
          deviceCode: 'ps_dc_test',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://pagespace.ai/activate',
          verificationUriComplete: 'https://pagespace.ai/activate?user_code=ABCD-EFGH',
          expiresInSeconds: 900,
          intervalSeconds: 5,
        };
      },
      pollDeviceToken: async () => pollResult,
      createIsInterrupted: () => () => false,
      deviceWaitMs: async () => {},
      discoverMetadata: async () => ({
        authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
        tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
        deviceAuthorizationEndpoint: 'https://pagespace.ai/api/oauth/device_authorization',
      }),
    };
    return { deps, store, browserOpened: () => browserOpened, deviceScope: () => deviceScope };
  }

  it('Create mints over the device transport and never opens a browser', async () => {
    selectMock
      .mockReset()
      .mockResolvedValueOnce('create')
      .mockResolvedValueOnce('specific')
      .mockResolvedValueOnce({ kind: 'member' })
      .mockResolvedValueOnce('exit');
    multiselectMock.mockReset().mockResolvedValueOnce(['drv1']);
    textMock.mockReset().mockResolvedValueOnce('my-key');
    confirmMock.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    spinnerHandle.message.mockReset();

    const { createKeysHandler } = await import('../wizard.js');
    const setup = deviceSetup({ kind: 'success', tokens: MCP_TOKENS });
    const sdk = fakeSdk({ drivesList: vi.fn(async () => [DRIVE_ROW]), tokensList: vi.fn(async () => []) });
    const handler = createKeysHandler(setup.deps);

    const code = await handler(createFakeContext({ sdk, isTTY: true, env: {} }), commandIntent(['keys', '--device']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(setup.browserOpened()).toBe(false);
    expect(setup.deviceScope()).toContain('name:my-key');
    // The verification code reaches the user through the spinner, since clack
    // owns the terminal while a ceremony is pending.
    const messages = spinnerHandle.message.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes('ABCD-EFGH'))).toBe(true);
    expect(credentialSecret((await setup.store.get('https://pagespace.ai', 'my-key'))!)).toBe('mcp_device_tok');
  });

  it('Edit — the wizard-only ceremony — re-scopes over the device transport', async () => {
    const KEY = { id: 'tok1', name: 'my-key', tokenPrefix: 'mcp_abc', driveScopes: [{ id: 'drv1', name: 'Engineering' }], createdAt: '2026-01-01T00:00:00.000Z', lastUsed: null, isScoped: true };
    selectMock
      .mockReset()
      .mockResolvedValueOnce('edit')
      .mockResolvedValueOnce('tok1')
      .mockResolvedValueOnce({ kind: 'member' })
      .mockResolvedValueOnce('exit');
    multiselectMock.mockReset().mockResolvedValueOnce(['drv1']);
    confirmMock.mockReset().mockResolvedValue(true);
    spinnerHandle.message.mockReset();
    spinnerHandle.error.mockReset();

    const { createKeysHandler } = await import('../wizard.js');
    const setup = deviceSetup({
      kind: 'success',
      tokens: { kind: 'mcp_update', tokenId: 'tok1', scope: 'update_key:tok1 drive:drv1:member' },
    });
    const sdk = fakeSdk({ drivesList: vi.fn(async () => [DRIVE_ROW]), tokensList: vi.fn(async () => [KEY]) });
    const handler = createKeysHandler(setup.deps);

    const code = await handler(createFakeContext({ sdk, isTTY: true, env: {} }), commandIntent(['keys', '--device']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(setup.browserOpened()).toBe(false);
    expect(setup.deviceScope()).toContain('update_key:tok1');
    expect(spinnerHandle.error).not.toHaveBeenCalled();
  });

  it('without --device the wizard still uses the browser transport', async () => {
    selectMock
      .mockReset()
      .mockResolvedValueOnce('create')
      .mockResolvedValueOnce('specific')
      .mockResolvedValueOnce({ kind: 'member' })
      .mockResolvedValueOnce('exit');
    multiselectMock.mockReset().mockResolvedValueOnce(['drv1']);
    textMock.mockReset().mockResolvedValueOnce('my-key');
    confirmMock.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const { createKeysHandler } = await import('../wizard.js');
    const store = fakeStore();
    const fake = fakeLoopbackServer();
    let deviceRequested = false;
    const deps = {
      ...baseMintDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
      exchangeCode: async () => MCP_TOKENS,
      requestDeviceAuthorization: async () => {
        deviceRequested = true;
        throw new Error('device transport must not be used without --device');
      },
    };
    const sdk = fakeSdk({ drivesList: vi.fn(async () => [DRIVE_ROW]), tokensList: vi.fn(async () => []) });

    const code = await createKeysHandler(deps)(createFakeContext({ sdk, isTTY: true, env: {} }), commandIntent(['keys']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(deviceRequested).toBe(false);
  });
});
