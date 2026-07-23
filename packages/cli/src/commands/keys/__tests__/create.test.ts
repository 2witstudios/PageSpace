import { describe, expect, it } from 'vitest';
import { parseScopeList, formatScopeSet } from '@pagespace/lib/auth/oauth/scopes';
import type { CredentialStore, HostCredential, LoopbackCallback, LoopbackServer } from '@pagespace/cli';
import { parseArgv } from '../../../argv/parse.js';
import type { CommandIntent } from '../../../argv/parse.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../../exit-codes.js';
import { credentialSecret } from '../../../credentials/serialize.js';
import { createFakeContext, createRecordingSink } from '../../../__tests__/fake-context.js';
import type { DriveScopeArg } from '../args.js';
import { buildKeyActivateScope, buildKeyUpdateScope, buildTokenScope, createTokensCreateHandler, resolveNewKeyName } from '../create.js';

function commandIntent(argv: string[]): CommandIntent {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error('expected command');
  return { ...parsed, args: parsed.args.slice(2) };
}

describe('buildTokenScope', () => {
  it('rejects zero drives', () => {
    expect(buildTokenScope([], { name: 'ci' })).toEqual({
      ok: false,
      message: 'At least one --drive is required to create a scoped token.',
    });
  });

  it('builds drive:<id> name:<name> offline_access for an inherited role', () => {
    expect(buildTokenScope([{ id: 'drv1', role: null }], { name: 'ci' })).toEqual({
      ok: true,
      scope: 'drive:drv1 name:ci offline_access',
      driveScope: 'drive:drv1',
    });
  });

  it('builds drive:<id>:member name:<name> offline_access', () => {
    expect(buildTokenScope([{ id: 'drv1', role: 'MEMBER' }], { name: 'ci' })).toEqual({
      ok: true,
      scope: 'drive:drv1:member name:ci offline_access',
      driveScope: 'drive:drv1:member',
    });
  });

  it('builds drive:<id>:admin name:<name> offline_access', () => {
    expect(buildTokenScope([{ id: 'drv1', role: 'ADMIN' }], { name: 'ci' })).toEqual({
      ok: true,
      scope: 'drive:drv1:admin name:ci offline_access',
      driveScope: 'drive:drv1:admin',
    });
  });

  it('builds drive:<id>:role:<customRoleId> name:<name> offline_access', () => {
    expect(buildTokenScope([{ id: 'drv1', role: null, customRoleId: 'rolexyz' }], { name: 'ci' })).toEqual({
      ok: true,
      scope: 'drive:drv1:role:rolexyz name:ci offline_access',
      driveScope: 'drive:drv1:role:rolexyz',
    });
  });

  it('sorts multiple drives by id and joins with a single offline_access', () => {
    expect(
      buildTokenScope(
        [
          { id: 'zzz', role: 'MEMBER' },
          { id: 'aaa', role: 'ADMIN' },
        ],
        { name: 'ci' },
      ),
    ).toEqual({
      ok: true,
      scope: 'drive:aaa:admin drive:zzz:member name:ci offline_access',
      driveScope: 'drive:aaa:admin drive:zzz:member',
    });
  });

  it('percent-encodes the name in the wire token', () => {
    expect(buildTokenScope([{ id: 'drv1', role: null }], { name: 'My Laptop' })).toEqual({
      ok: true,
      scope: 'drive:drv1 name:My%20Laptop offline_access',
      driveScope: 'drive:drv1',
    });
  });

  it('omits the name: token entirely when no name is given (the buildKeyUpdateScope reuse path)', () => {
    expect(buildTokenScope([{ id: 'drv1', role: null }])).toEqual({
      ok: true,
      scope: 'drive:drv1 offline_access',
      driveScope: 'drive:drv1',
    });
  });

  it('rejects a drive id outside the resource-id grammar', () => {
    const result = buildTokenScope([{ id: 'Not Valid!', role: null }], { name: 'ci' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('Not Valid!');
  });

  it('rejects a customRoleId outside the resource-id grammar', () => {
    const result = buildTokenScope([{ id: 'drv1', role: null, customRoleId: 'Not Valid!' }], { name: 'ci' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('Not Valid!');
  });

  it('rejects a duplicate drive id', () => {
    const result = buildTokenScope(
      [
        { id: 'drv1', role: 'MEMBER' },
        { id: 'drv1', role: 'ADMIN' },
      ],
      { name: 'ci' },
    );
    expect(result).toEqual({ ok: false, message: 'Duplicate --drive "drv1": each drive may only be scoped once.' });
  });

  it('is a pure function: identical input produces a deep-equal result', () => {
    const drives: DriveScopeArg[] = [{ id: 'drv1', role: 'MEMBER' }];
    expect(buildTokenScope(drives, { name: 'ci' })).toEqual(buildTokenScope(drives, { name: 'ci' }));
  });
});

describe('buildTokenScope — --all-drives', () => {
  it('builds "all_drives name:<name> offline_access" when allDrives is true and no drives are given', () => {
    expect(buildTokenScope([], { allDrives: true, name: 'god-key' })).toEqual({
      ok: true,
      scope: 'all_drives name:god-key offline_access',
      driveScope: 'all drives',
    });
  });

  it('rejects --all-drives combined with --drive', () => {
    expect(buildTokenScope([{ id: 'drv1', role: null }], { allDrives: true, name: 'god-key' })).toEqual({
      ok: false,
      message: '--all-drives cannot be combined with --drive.',
    });
  });

  it('never infers all_drives from an empty drives array without the explicit option — the zero-drive usage error stays a usage error', () => {
    expect(buildTokenScope([], { name: 'ci' })).toEqual({
      ok: false,
      message: 'At least one --drive is required to create a scoped token.',
    });
  });

  it('drift guard: the canonical parser accepts "all_drives name:<name> offline_access" as an all_drives grant', () => {
    const result = buildTokenScope([], { allDrives: true, name: 'god-key' });
    if (!result.ok) throw new Error('expected buildTokenScope to succeed');

    const parsed = parseScopeList(result.scope);
    if (!parsed.ok) throw new Error(`expected the canonical parser to accept: ${result.scope}`);

    expect(parsed.scopes.allDrives).toBe(true);
    expect(parsed.scopes.offlineAccess).toBe(true);
    expect(parsed.scopes.drives.size).toBe(0);
    expect(parsed.scopes.newKeyName).toBe('god-key');
    expect(parseScopeList(formatScopeSet(parsed.scopes))).toEqual(parsed);
  });
});

describe('buildTokenScope — drift guard vs @pagespace/lib canonical grammar', () => {
  it('produces a scope string the canonical parser accepts as the intended drive/role/offline_access set', () => {
    const result = buildTokenScope(
      [
        { id: 'drv1', role: 'MEMBER' },
        { id: 'drv2', role: 'ADMIN' },
        { id: 'drv3', role: null, customRoleId: 'rolexyz' },
        { id: 'drv4', role: null },
      ],
      { name: 'ci' },
    );
    if (!result.ok) throw new Error('expected buildTokenScope to succeed');

    const parsed = parseScopeList(result.scope);
    if (!parsed.ok) throw new Error(`expected the canonical parser to accept: ${result.scope}`);

    expect(parsed.scopes.account).toBe(false);
    expect(parsed.scopes.offlineAccess).toBe(true);
    expect(parsed.scopes.newKeyName).toBe('ci');
    expect([...parsed.scopes.drives.values()]).toEqual([
      { kind: 'drive', driveId: 'drv1', role: { kind: 'member' } },
      { kind: 'drive', driveId: 'drv2', role: { kind: 'admin' } },
      { kind: 'drive', driveId: 'drv3', role: { kind: 'custom', customRoleId: 'rolexyz' } },
      { kind: 'drive', driveId: 'drv4', role: { kind: 'inherit' } },
    ]);

    // Round-tripping through the canonical formatter must reparse to the same set —
    // token order in the wire string is not semantically significant.
    const reparsed = parseScopeList(formatScopeSet(parsed.scopes));
    expect(reparsed).toEqual(parsed);
  });
});

describe('buildKeyUpdateScope', () => {
  it('builds update_key:<id> + sorted drive tokens WITHOUT offline_access, surfacing the drive tokens separately for display', () => {
    expect(
      buildKeyUpdateScope('tok123', [
        { id: 'zzz', role: 'MEMBER' },
        { id: 'aaa', role: 'ADMIN' },
      ]),
    ).toEqual({
      ok: true,
      scope: 'update_key:tok123 drive:aaa:admin drive:zzz:member',
      driveScope: 'drive:aaa:admin drive:zzz:member',
    });
  });

  it('rejects a key id outside the resource-id grammar', () => {
    const result = buildKeyUpdateScope('Not Valid!', [{ id: 'drv1', role: null }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('Not Valid!');
  });

  it('rejects zero drives via buildTokenScope — re-scoping to nothing is revocation, not an update', () => {
    expect(buildKeyUpdateScope('tok123', []).ok).toBe(false);
  });

  it('drift guard: the canonical parser accepts the update scope as an update_key grant of exactly those drives', () => {
    const result = buildKeyUpdateScope('tok123', [
      { id: 'drv1', role: 'MEMBER' },
      { id: 'drv2', role: null, customRoleId: 'rolexyz' },
    ]);
    if (!result.ok) throw new Error('expected buildKeyUpdateScope to succeed');

    const parsed = parseScopeList(result.scope);
    if (!parsed.ok) throw new Error(`expected the canonical parser to accept: ${result.scope}`);

    expect(parsed.scopes.updateKeyId).toBe('tok123');
    expect(parsed.scopes.offlineAccess).toBe(false);
    expect([...parsed.scopes.drives.keys()]).toEqual(['drv1', 'drv2']);
    expect(parseScopeList(formatScopeSet(parsed.scopes))).toEqual(parsed);
  });
});

describe('resolveNewKeyName', () => {
  it('uses the explicit --name when given', () => {
    expect(resolveNewKeyName({ name: 'ci', drives: [{ id: 'drv1', role: null }] })).toEqual({
      ok: true,
      name: 'ci',
    });
  });

  it('defaults to the single drive id when --name is omitted', () => {
    expect(resolveNewKeyName({ name: undefined, drives: [{ id: 'drv1', role: null }] })).toEqual({
      ok: true,
      name: 'drv1',
    });
  });

  it('rejects zero drives (not the ambiguous "more than one drive" message) when --all-drives is not given', () => {
    expect(resolveNewKeyName({ name: undefined, drives: [] })).toEqual({
      ok: false,
      message: 'At least one --drive is required to create a scoped token.',
    });
  });

  it('requires an explicit name when scoping more than one drive', () => {
    expect(
      resolveNewKeyName({
        name: undefined,
        drives: [
          { id: 'drv1', role: null },
          { id: 'drv2', role: null },
        ],
      }),
    ).toEqual({
      ok: false,
      message: '--name <name> is required when scoping a key to more than one drive.',
    });
  });

  it('rejects "default" as an explicit --name — that slot is reserved for "pagespace login", and says so in key vocabulary', () => {
    const result = resolveNewKeyName({ name: 'default', drives: [{ id: 'drv1', role: null }] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe(
      '--name "default" is reserved for the personal credential stored by "pagespace login". Choose another key name.',
    );
  });

  it('rejects the single-drive auto-derived name when it equals "default" (e.g. --drive default, no --name)', () => {
    const result = resolveNewKeyName({ name: undefined, drives: [{ id: 'default', role: null }] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('"default"');
    expect(result.ok === false && result.message).toContain('pagespace login');
  });

  it('is a pure function: identical input produces a deep-equal result', () => {
    const input = { name: undefined, drives: [{ id: 'drv1', role: null }] as DriveScopeArg[] };
    expect(resolveNewKeyName(input)).toEqual(resolveNewKeyName(input));
  });

  it('requires an explicit --name when using --all-drives (no drive id to default to)', () => {
    expect(resolveNewKeyName({ name: undefined, drives: [], allDrives: true })).toEqual({
      ok: false,
      message: '--name <name> is required when using --all-drives.',
    });
  });

  it('accepts an explicit --name with --all-drives', () => {
    expect(resolveNewKeyName({ name: 'god-key', drives: [], allDrives: true })).toEqual({
      ok: true,
      name: 'god-key',
    });
  });

  it('rejects "default" as the --all-drives key name too', () => {
    const result = resolveNewKeyName({ name: 'default', drives: [], allDrives: true });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('pagespace login');
  });
});

describe('buildKeyActivateScope', () => {
  it('builds activate_key:<id> as the SOLE scope token', () => {
    expect(buildKeyActivateScope('tok123')).toEqual({ ok: true, scope: 'activate_key:tok123' });
  });

  it('rejects a key id outside the resource-id grammar', () => {
    const result = buildKeyActivateScope('Not Valid!');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('Not Valid!');
  });

  it('rejects an empty id', () => {
    expect(buildKeyActivateScope('').ok).toBe(false);
  });
});

const FIXED_TOKENS = {
  kind: 'oauth' as const,
  accessToken: 'ps_at_test',
  refreshToken: 'ps_rt_test',
  expiresIn: 900,
  scope: 'drive:drv1:member offline_access',
};

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
      [...hosts.entries()]
        .filter(([, profiles]) => profiles.has(profile))
        .map(([host, profiles]) => ({ host, tokenPrefix: credentialSecret(profiles.get(profile)!).slice(0, 12) })),
  };
}

function fakeServer(port = 55555) {
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

function baseHandlerDeps(store: CredentialStore) {
  return {
    createCredentialStore: () => store,
    randomBytes: (n: number) => new Uint8Array(n).fill(7),
    discoverMetadata: async () => ({
      authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
      tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
      deviceAuthorizationEndpoint: 'https://pagespace.ai/api/oauth/device_authorization',
    }),
    startServer: async () => fakeServer().server,
    openBrowser: async () => true,
    waitMs: () => new Promise<void>(() => {}),
    exchangeCode: async () => FIXED_TOKENS,
    confirmIdentity: async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' }),
    requestDeviceAuthorization: async () => DEVICE_AUTHORIZATION,
    pollDeviceToken: async () => ({ kind: 'success' as const, tokens: FIXED_MCP_TOKENS }),
    isInterrupted: () => false,
    now: () => Date.parse('2026-07-03T00:00:00.000Z'),
  };
}

const DEVICE_AUTHORIZATION = {
  deviceCode: 'ps_dc_test',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://pagespace.ai/activate',
  verificationUriComplete: 'https://pagespace.ai/activate?user_code=ABCD-EFGH',
  expiresInSeconds: 900,
  intervalSeconds: 5,
};

const FIXED_MCP_TOKENS = {
  kind: 'mcp' as const,
  token: 'mcp_device_minted',
  scope: 'drive:drv1:member name:remote-key offline_access',
};

function autoApprove(fake: ReturnType<typeof fakeServer>) {
  return async (url: string) => {
    const state = new URL(url).searchParams.get('state')!;
    queueMicrotask(() => fake.deliver({ code: 'auth-code', state }));
    return true;
  };
}

describe('createTokensCreateHandler', () => {
  it('rejects a missing --drive as a usage error without opening a browser', async () => {
    const store = fakeStore();
    const openBrowser = async () => true;
    const handler = createTokensCreateHandler({ ...baseHandlerDeps(store), openBrowser });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });

    const code = await handler(ctx, commandIntent(['keys', 'create']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('--drive');
  });

  it('rejects more than one drive with no --name as a usage error', async () => {
    const store = fakeStore();
    const handler = createTokensCreateHandler(baseHandlerDeps(store));
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });

    const code = await handler(
      ctx,
      commandIntent(['keys', 'create', '--drive', 'drv1', '--drive', 'drv2']),
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('--name');
  });

  it('rejects --name default as a usage error without opening a browser', async () => {
    const store = fakeStore();
    let browserOpened = false;
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      openBrowser: async () => {
        browserOpened = true;
        return true;
      },
    });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });

    const code = await handler(
      ctx,
      commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member', '--name', 'default']),
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('"default"');
    expect(browserOpened).toBe(false);
  });

  it('rejects a single --drive default with no --name as a usage error without opening a browser', async () => {
    const store = fakeStore();
    let browserOpened = false;
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      openBrowser: async () => {
        browserOpened = true;
        return true;
      },
    });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });

    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'default', '--role', 'member']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('"default"');
    expect(browserOpened).toBe(false);
  });

  it('opens the browser with a correctly built scope and stores the refresh token under the key name', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    let requestedScope: string | undefined;
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        requestedScope = new URL(url).searchParams.get('scope') ?? undefined;
        return autoApprove(fake)(url);
      },
    });

    const code = await handler(
      createFakeContext({ env: {} }),
      commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member']),
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(requestedScope).toBe('drive:drv1:member name:drv1 offline_access');
    const stored = await store.get('https://pagespace.ai', 'drv1');
    expect((stored && credentialSecret(stored))).toBe(FIXED_TOKENS.refreshToken);
    expect(await store.get('https://pagespace.ai', 'default')).toBeNull();
  });

  it('never writes the access or refresh token to stdout/stderr', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
    });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });

    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'admin']));

    expect(code).toBe(EXIT_SUCCESS);
    const allOutput = [...stdout.lines, ...stderr.lines].join('');
    expect(allOutput).not.toContain(FIXED_TOKENS.accessToken);
    expect(allOutput).not.toContain(FIXED_TOKENS.refreshToken);
    expect(allOutput).toContain('drv1');
  });

  it('always prints the agent-wiring guidance (MCP config with PAGESPACE_KEY) on success', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
    });

    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });

    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member']));

    expect(code).toBe(EXIT_SUCCESS);
    const output = stdout.lines.join('');
    expect(output).toContain('"PAGESPACE_KEY": "drv1"');
    expect(output).toContain('"args": [');
    expect(output).toMatch(/keychain/i);
  });

  it('--show-token prints the raw minted mcp_* token exactly once on stdout with a shown-once warning on stderr', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
      exchangeCode: async () => ({ kind: 'mcp' as const, token: 'mcp_raw_secret_1', scope: 'drive:drv1:member offline_access' }),
    });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });

    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member', '--show-token']));

    expect(code).toBe(EXIT_SUCCESS);
    const stdoutText = stdout.lines.join('');
    expect(stdoutText.match(/mcp_raw_secret_1/g)).toHaveLength(1);
    expect(stdoutText).toContain('PAGESPACE_TOKEN=mcp_raw_secret_1');
    expect(stderr.lines.join('')).toMatch(/shown once/i);
    expect(stderr.lines.join('')).not.toContain('mcp_raw_secret_1');
  });

  it('without --show-token the raw mcp_* token appears nowhere in the output', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
      exchangeCode: async () => ({ kind: 'mcp' as const, token: 'mcp_raw_secret_1', scope: 'drive:drv1:member offline_access' }),
    });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });

    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member']));

    expect(code).toBe(EXIT_SUCCESS);
    expect([...stdout.lines, ...stderr.lines].join('')).not.toContain('mcp_raw_secret_1');
  });

  it('--show-token with an oauth-kind exchange explains there is no raw token to show, leaking nothing', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
    });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });

    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member', '--show-token']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(stderr.lines.join('')).toMatch(/no raw token to show/i);
    const allOutput = [...stdout.lines, ...stderr.lines].join('');
    expect(allOutput).not.toContain(FIXED_TOKENS.refreshToken);
    expect(allOutput).not.toContain(FIXED_TOKENS.accessToken);
  });

  it('uses --name as the storage name when given', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
    });

    const code = await handler(
      createFakeContext({ env: {} }),
      commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member', '--name', 'ci-bot']),
    );

    expect(code).toBe(EXIT_SUCCESS);
    const stored = await store.get('https://pagespace.ai', 'ci-bot');
    expect((stored && credentialSecret(stored))).toBe(FIXED_TOKENS.refreshToken);
  });

  it('refuses to overwrite an existing stored key without --yes', async () => {
    const store = fakeStore();
    await store.set(
      'https://pagespace.ai',
      { kind: 'oauth', refreshToken: 'ps_rt_existing', clientId: 'pagespace-cli', scopes: ['drive:drv1:member'], createdAt: '2026-01-01T00:00:00.000Z' },
      'drv1',
    );
    const handler = createTokensCreateHandler(baseHandlerDeps(store));

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });

    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/--yes/);
    expect(stderr.lines.join('')).not.toContain('ps_rt_existing');
  });

  it('overwrites an existing stored key when --yes is passed', async () => {
    const store = fakeStore();
    await store.set(
      'https://pagespace.ai',
      { kind: 'oauth', refreshToken: 'ps_rt_existing', clientId: 'pagespace-cli', scopes: ['drive:drv1:member'], createdAt: '2026-01-01T00:00:00.000Z' },
      'drv1',
    );
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
    });

    const code = await handler(
      createFakeContext({ env: {} }),
      commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member', '--yes']),
    );

    expect(code).toBe(EXIT_SUCCESS);
    const stored = await store.get('https://pagespace.ai', 'drv1');
    expect((stored && credentialSecret(stored))).toBe(FIXED_TOKENS.refreshToken);
  });

  it('maps a discovery failure to exit 1 with a distinct message', async () => {
    const store = fakeStore();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      discoverMetadata: async () => {
        throw new Error('offline');
      },
    });

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('offline');
  });

  it('maps an access_denied callback to exit 1 without storing a credential', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get('state')!;
        queueMicrotask(() => fake.deliver({ error: 'access_denied', state }));
        return true;
      },
    });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });
    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/access was denied/i);
    expect(await store.get('https://pagespace.ai', 'drv1')).toBeNull();
    const allOutput = [...stdout.lines, ...stderr.lines].join('');
    expect(allOutput).not.toContain(FIXED_TOKENS.accessToken);
    expect(allOutput).not.toContain(FIXED_TOKENS.refreshToken);
  });

  it('maps a timeout waiting for the browser redirect to exit 1 without storing a credential', async () => {
    const store = fakeStore();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      // Default startServer's fakeServer() never delivers a callback; make the
      // timeout side of the race resolve immediately instead of waiting for
      // the real (5-minute) DEFAULT_LOGIN_TIMEOUT_MS.
      waitMs: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/timed out waiting for approval/i);
    expect(await store.get('https://pagespace.ai', 'drv1')).toBeNull();
  });

  it('maps a state mismatch on the callback to exit 1 without storing a credential', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: async () => {
        queueMicrotask(() => fake.deliver({ code: 'auth-code', state: 'deliberately-wrong-state' }));
        return true;
      },
    });

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/did not match this request/i);
    expect(await store.get('https://pagespace.ai', 'drv1')).toBeNull();
  });

  it('maps a non-access_denied authorize error to exit 1, surfacing the error code', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get('state')!;
        queueMicrotask(() => fake.deliver({ error: 'server_error', state }));
        return true;
      },
    });

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/consent failed: server_error/i);
    expect(await store.get('https://pagespace.ai', 'drv1')).toBeNull();
  });

  it('never writes the access or refresh token to stdout/stderr even on a token-exchange failure', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      exchangeCode: async () => {
        throw new Error('exchange rejected by server');
      },
      openBrowser: autoApprove(fake),
    });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });
    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/exchanging the authorization code/i);
    expect(stderr.lines.join('')).toContain('exchange rejected by server');
    const allOutput = [...stdout.lines, ...stderr.lines].join('');
    expect(allOutput).not.toContain(FIXED_TOKENS.accessToken);
    expect(allOutput).not.toContain(FIXED_TOKENS.refreshToken);
    expect(await store.get('https://pagespace.ai', 'drv1')).toBeNull();
  });

  it('--all-drives --yes mints a key scoped to "all drives" and stores it under the given name', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    let requestedScope: string | undefined;
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        requestedScope = new URL(url).searchParams.get('scope') ?? undefined;
        return autoApprove(fake)(url);
      },
    });

    const code = await handler(
      createFakeContext({ env: {} }),
      commandIntent(['keys', 'create', '--all-drives', '--name', 'god-key', '--yes']),
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(requestedScope).toBe('all_drives name:god-key offline_access');
    const stored = await store.get('https://pagespace.ai', 'god-key');
    expect((stored && credentialSecret(stored))).toBe(FIXED_TOKENS.refreshToken);
  });

  it('--all-drives prints "scoped to: all drives" rather than the raw scope string', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
    });

    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });

    const code = await handler(ctx, commandIntent(['keys', 'create', '--all-drives', '--name', 'god-key', '--yes']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain('scoped to: all drives.');
    expect(stdout.lines.join('')).not.toContain('all_drives offline_access');
  });

  it('--all-drives requires --name (no drive id to default to) as a usage error without opening a browser', async () => {
    const store = fakeStore();
    let browserOpened = false;
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      openBrowser: async () => {
        browserOpened = true;
        return true;
      },
    });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });

    const code = await handler(ctx, commandIntent(['keys', 'create', '--all-drives', '--yes']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('--all-drives');
    expect(browserOpened).toBe(false);
  });

  it('--all-drives combined with --drive is a usage error without opening a browser', async () => {
    const store = fakeStore();
    let browserOpened = false;
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      openBrowser: async () => {
        browserOpened = true;
        return true;
      },
    });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });

    const code = await handler(
      ctx,
      commandIntent(['keys', 'create', '--all-drives', '--drive', 'drv1', '--name', 'god-key', '--yes']),
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('--all-drives cannot be combined with --drive.');
    expect(browserOpened).toBe(false);
  });

  it('--all-drives without --yes in a non-TTY session fails closed without opening a browser', async () => {
    const store = fakeStore();
    let browserOpened = false;
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      openBrowser: async () => {
        browserOpened = true;
        return true;
      },
    });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {}, isTTY: false });

    const code = await handler(ctx, commandIntent(['keys', 'create', '--all-drives', '--name', 'god-key']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/--yes/);
    expect(browserOpened).toBe(false);
  });

  it('--all-drives without --yes in a TTY session prompts and proceeds on an affirmative answer', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
    });
    let promptedMessage: string | undefined;
    const ctx = createFakeContext({
      env: {},
      isTTY: true,
      prompt: async (message) => {
        promptedMessage = message;
        return 'y';
      },
    });

    const code = await handler(ctx, commandIntent(['keys', 'create', '--all-drives', '--name', 'god-key']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(promptedMessage).toMatch(/ALL your drives/);
    const stored = await store.get('https://pagespace.ai', 'god-key');
    expect((stored && credentialSecret(stored))).toBe(FIXED_TOKENS.refreshToken);
  });

  it('--all-drives without --yes in a TTY session aborts without opening a browser on a declined answer', async () => {
    const store = fakeStore();
    let browserOpened = false;
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      openBrowser: async () => {
        browserOpened = true;
        return true;
      },
    });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {}, isTTY: true, prompt: async () => 'n' });

    const code = await handler(ctx, commandIntent(['keys', 'create', '--all-drives', '--name', 'god-key']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(browserOpened).toBe(false);
    expect(await store.get('https://pagespace.ai', 'god-key')).toBeNull();
  });

  it('maps exhausting all loopback port-bind attempts to exit 1 without storing a credential', async () => {
    const store = fakeStore();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => {
        throw new Error('EADDRINUSE');
      },
      maxPortAttempts: 2,
    });

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const code = await handler(ctx, commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/could not bind a local loopback port/i);
    expect(await store.get('https://pagespace.ai', 'drv1')).toBeNull();
  });
});

// The shared fixture's `waitMs` never resolves — the loopback tests use it to
// hold the flow open at the redirect wait. The device flow genuinely sleeps
// between polls, so these tests need a real (instant) one.
function deviceHandlerDeps(store: CredentialStore) {
  return { ...baseHandlerDeps(store), waitMs: async () => {} };
}

describe('createTokensCreateHandler — --device', () => {
  it('mints through the device flow without opening a browser, printing the verification code', async () => {
    const store = fakeStore();
    let browserOpened = false;
    let deviceScope: string | undefined;
    const handler = createTokensCreateHandler({
      ...deviceHandlerDeps(store),
      openBrowser: async () => {
        browserOpened = true;
        return true;
      },
      requestDeviceAuthorization: async ({ scope }) => {
        deviceScope = scope;
        return DEVICE_AUTHORIZATION;
      },
    });
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });

    const code = await handler(
      ctx,
      commandIntent(['keys', 'create', '--device', '--drive', 'drv1', '--role', 'member', '--name', 'remote-key']),
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(browserOpened).toBe(false);
    const output = stdout.lines.join('');
    expect(output).toContain('ABCD-EFGH');
    expect(output).toContain('https://pagespace.ai/activate');
    expect(output).not.toContain('Opening your browser');
    // The mint request must carry the name the server now requires.
    expect(deviceScope).toContain('name:remote-key');
    // Persisted under the key's own name, as a static credential.
    const stored = await store.get('https://pagespace.ai', 'remote-key');
    expect(stored?.kind).toBe('static');
    expect(credentialSecret(stored!)).toBe('mcp_device_minted');
  });

  it('rejects --device with --all-drives as a usage error, naming the browser workaround', async () => {
    const store = fakeStore();
    let deviceRequested = false;
    const handler = createTokensCreateHandler({
      ...deviceHandlerDeps(store),
      requestDeviceAuthorization: async () => {
        deviceRequested = true;
        return DEVICE_AUTHORIZATION;
      },
    });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });

    const code = await handler(
      ctx,
      commandIntent(['keys', 'create', '--device', '--all-drives', '--name', 'everything', '--yes']),
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(deviceRequested).toBe(false);
    const err = stderr.lines.join('');
    expect(err).toContain('--all-drives cannot be combined with --device');
    expect(err).toContain('browser');
  });

  it('keeps the --show-token stdout contract (exactly one line) in device mode', async () => {
    const store = fakeStore();
    const handler = createTokensCreateHandler(deviceHandlerDeps(store));
    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });

    const code = await handler(
      ctx,
      commandIntent([
        'keys', 'create', '--device', '--drive', 'drv1', '--role', 'member', '--name', 'remote-key', '--show-token',
      ]),
    );

    expect(code).toBe(EXIT_SUCCESS);
    // The verification code goes to stderr in --show-token mode, keeping
    // stdout to the single machine-readable assignment.
    expect(stdout.lines.join('').trim().split('\n')).toHaveLength(1);
    expect(stdout.lines.join('')).toContain('mcp_device_minted');
    expect(stderr.lines.join('')).toContain('ABCD-EFGH');
  });
});
