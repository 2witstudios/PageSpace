import { describe, expect, it } from 'vitest';
import { parseScopeList, formatScopeSet } from '@pagespace/lib/auth/oauth/scopes';
import type { CredentialStore, HostCredential, LoopbackCallback, LoopbackServer } from '@pagespace/cli';
import { parseArgv } from '../../../argv/parse.js';
import type { CommandIntent } from '../../../argv/parse.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../../exit-codes.js';
import { credentialSecret } from '../../../credentials/serialize.js';
import { createFakeContext, createRecordingSink } from '../../../__tests__/fake-context.js';
import type { DriveScopeArg } from '../args.js';
import { buildTokenScope, createTokensCreateHandler, resolveTokenProfileName } from '../create.js';

function commandIntent(argv: string[]): CommandIntent {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error('expected command');
  return { ...parsed, args: parsed.args.slice(2) };
}

describe('buildTokenScope', () => {
  it('rejects zero drives', () => {
    expect(buildTokenScope([])).toEqual({
      ok: false,
      message: 'At least one --drive is required to create a scoped token.',
    });
  });

  it('builds drive:<id> offline_access for an inherited role', () => {
    expect(buildTokenScope([{ id: 'drv1', role: null }])).toEqual({
      ok: true,
      scope: 'drive:drv1 offline_access',
    });
  });

  it('builds drive:<id>:member offline_access', () => {
    expect(buildTokenScope([{ id: 'drv1', role: 'MEMBER' }])).toEqual({
      ok: true,
      scope: 'drive:drv1:member offline_access',
    });
  });

  it('builds drive:<id>:admin offline_access', () => {
    expect(buildTokenScope([{ id: 'drv1', role: 'ADMIN' }])).toEqual({
      ok: true,
      scope: 'drive:drv1:admin offline_access',
    });
  });

  it('builds drive:<id>:role:<customRoleId> offline_access', () => {
    expect(buildTokenScope([{ id: 'drv1', role: null, customRoleId: 'rolexyz' }])).toEqual({
      ok: true,
      scope: 'drive:drv1:role:rolexyz offline_access',
    });
  });

  it('sorts multiple drives by id and joins with a single offline_access', () => {
    expect(
      buildTokenScope([
        { id: 'zzz', role: 'MEMBER' },
        { id: 'aaa', role: 'ADMIN' },
      ]),
    ).toEqual({ ok: true, scope: 'drive:aaa:admin drive:zzz:member offline_access' });
  });

  it('rejects a drive id outside the resource-id grammar', () => {
    const result = buildTokenScope([{ id: 'Not Valid!', role: null }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('Not Valid!');
  });

  it('rejects a customRoleId outside the resource-id grammar', () => {
    const result = buildTokenScope([{ id: 'drv1', role: null, customRoleId: 'Not Valid!' }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('Not Valid!');
  });

  it('rejects a duplicate drive id', () => {
    const result = buildTokenScope([
      { id: 'drv1', role: 'MEMBER' },
      { id: 'drv1', role: 'ADMIN' },
    ]);
    expect(result).toEqual({ ok: false, message: 'Duplicate --drive "drv1": each drive may only be scoped once.' });
  });

  it('is a pure function: identical input produces a deep-equal result', () => {
    const drives: DriveScopeArg[] = [{ id: 'drv1', role: 'MEMBER' }];
    expect(buildTokenScope(drives)).toEqual(buildTokenScope(drives));
  });
});

describe('buildTokenScope — drift guard vs @pagespace/lib canonical grammar', () => {
  it('produces a scope string the canonical parser accepts as the intended drive/role/offline_access set', () => {
    const result = buildTokenScope([
      { id: 'drv1', role: 'MEMBER' },
      { id: 'drv2', role: 'ADMIN' },
      { id: 'drv3', role: null, customRoleId: 'rolexyz' },
      { id: 'drv4', role: null },
    ]);
    if (!result.ok) throw new Error('expected buildTokenScope to succeed');

    const parsed = parseScopeList(result.scope);
    if (!parsed.ok) throw new Error(`expected the canonical parser to accept: ${result.scope}`);

    expect(parsed.scopes.account).toBe(false);
    expect(parsed.scopes.offlineAccess).toBe(true);
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

describe('resolveTokenProfileName', () => {
  it('uses the explicit --save-as-profile name when given', () => {
    expect(resolveTokenProfileName({ saveAsProfile: 'ci', drives: [{ id: 'drv1', role: null }] })).toEqual({
      ok: true,
      name: 'ci',
    });
  });

  it('defaults to the single drive id when --save-as-profile is omitted', () => {
    expect(resolveTokenProfileName({ saveAsProfile: undefined, drives: [{ id: 'drv1', role: null }] })).toEqual({
      ok: true,
      name: 'drv1',
    });
  });

  it('requires an explicit name when scoping more than one drive', () => {
    expect(
      resolveTokenProfileName({
        saveAsProfile: undefined,
        drives: [
          { id: 'drv1', role: null },
          { id: 'drv2', role: null },
        ],
      }),
    ).toEqual({
      ok: false,
      message: '--save-as-profile <name> is required when scoping a token to more than one drive.',
    });
  });

  it('rejects "default" as an explicit --save-as-profile name — that slot is reserved for "pagespace login"', () => {
    const result = resolveTokenProfileName({ saveAsProfile: 'default', drives: [{ id: 'drv1', role: null }] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('"default"');
    expect(result.ok === false && result.message).toContain('pagespace login');
  });

  it('rejects the single-drive auto-derived name when it equals "default" (e.g. --drive default, no --save-as-profile)', () => {
    const result = resolveTokenProfileName({ saveAsProfile: undefined, drives: [{ id: 'default', role: null }] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('"default"');
    expect(result.ok === false && result.message).toContain('pagespace login');
  });

  it('is a pure function: identical input produces a deep-equal result', () => {
    const input = { saveAsProfile: undefined, drives: [{ id: 'drv1', role: null }] as DriveScopeArg[] };
    expect(resolveTokenProfileName(input)).toEqual(resolveTokenProfileName(input));
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
    }),
    startServer: async () => fakeServer().server,
    openBrowser: async () => true,
    waitMs: () => new Promise<void>(() => {}),
    exchangeCode: async () => FIXED_TOKENS,
    confirmIdentity: async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' }),
    now: () => Date.parse('2026-07-03T00:00:00.000Z'),
  };
}

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

  it('rejects more than one drive with no --save-as-profile as a usage error', async () => {
    const store = fakeStore();
    const handler = createTokensCreateHandler(baseHandlerDeps(store));
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });

    const code = await handler(
      ctx,
      commandIntent(['keys', 'create', '--drive', 'drv1', '--drive', 'drv2']),
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('--save-as-profile');
  });

  it('rejects --save-as-profile default as a usage error without opening a browser', async () => {
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
      commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member', '--save-as-profile', 'default']),
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('"default"');
    expect(browserOpened).toBe(false);
  });

  it('rejects a single --drive default with no --save-as-profile as a usage error without opening a browser', async () => {
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

  it('opens the browser with a correctly built scope and stores the refresh token under the named profile', async () => {
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
    expect(requestedScope).toBe('drive:drv1:member offline_access');
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

  it('uses --save-as-profile as the storage profile when given', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createTokensCreateHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
    });

    const code = await handler(
      createFakeContext({ env: {} }),
      commandIntent(['keys', 'create', '--drive', 'drv1', '--role', 'member', '--save-as-profile', 'ci-bot']),
    );

    expect(code).toBe(EXIT_SUCCESS);
    const stored = await store.get('https://pagespace.ai', 'ci-bot');
    expect((stored && credentialSecret(stored))).toBe(FIXED_TOKENS.refreshToken);
  });

  it('refuses to overwrite an existing stored profile without --yes', async () => {
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

  it('overwrites an existing stored profile when --yes is passed', async () => {
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
    expect(stderr.lines.join('')).toMatch(/consent was denied/i);
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
    expect(stderr.lines.join('')).toMatch(/consent timed out/i);
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
