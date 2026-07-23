import { describe, expect, it } from 'vitest';
import { createLoginDeviceHandler, credentialSecret, EXIT_RUNTIME_ERROR, EXIT_SUCCESS, parseArgv } from '@pagespace/cli';
import type { DeviceAuthorization, DeviceTokenResult, HostCredential, CredentialStore } from '@pagespace/cli';
import { createFakeContext, createRecordingSink } from '../../__tests__/fake-context.js';

const FIXED_TOKENS = {
  kind: 'oauth' as const,
  accessToken: 'ps_at_test',
  refreshToken: 'ps_rt_test',
  expiresIn: 900,
  scope: 'account offline_access',
};

const AUTHORIZATION: DeviceAuthorization = {
  deviceCode: 'ps_dc_test',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://pagespace.ai/activate',
  verificationUriComplete: 'https://pagespace.ai/activate?user_code=ABCD-EFGH',
  expiresInSeconds: 1800,
  intervalSeconds: 5,
};

/** Seeds every entry as that host's "default" profile -- named profiles are added independently via set(). */
function fakeStore(initial: Map<string, HostCredential> = new Map()): CredentialStore {
  const hosts = new Map<string, Map<string, HostCredential>>();
  for (const [host, credential] of initial) {
    hosts.set(host, new Map([['default', credential]]));
  }

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
    list: async () =>
      [...hosts.entries()]
        .filter(([, profiles]) => profiles.has('default'))
        .map(([host, profiles]) => ({ host, tokenPrefix: credentialSecret(profiles.get('default')!).slice(0, 12) })),
  };
}

function baseHandlerDeps(store: CredentialStore) {
  return {
    createCredentialStore: () => store,
    discoverMetadata: async () => ({
      authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
      tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
      deviceAuthorizationEndpoint: 'https://pagespace.ai/api/oauth/device_authorization',
    }),
    requestDeviceAuthorization: async () => AUTHORIZATION,
    pollDeviceToken: async (): Promise<DeviceTokenResult> => ({ kind: 'success', tokens: FIXED_TOKENS }),
    waitMs: async () => {},
    confirmIdentity: async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' }),
    now: () => Date.parse('2026-07-03T00:00:00.000Z'),
    createIsInterrupted: () => () => false,
  };
}

function commandIntent(argv: string[]) {
  const intent = parseArgv(argv);
  if (intent.kind !== 'command') throw new Error('expected command');
  return intent;
}

describe('createLoginDeviceHandler', () => {
  it('prints the verification URL and user code, then logs in and prints identity but never the tokens', async () => {
    const store = fakeStore();
    const handler = createLoginDeviceHandler(baseHandlerDeps(store));

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });

    const code = await handler(ctx, commandIntent(['login', '--device']));

    expect(code).toBe(EXIT_SUCCESS);
    const allOutput = [...stdout.lines, ...stderr.lines].join('');
    expect(allOutput).toContain(AUTHORIZATION.verificationUri);
    expect(allOutput).toContain(AUTHORIZATION.userCode);
    expect(allOutput).toContain(AUTHORIZATION.verificationUriComplete);
    expect(allOutput).toContain('ada@example.com');
    expect(allOutput).toContain(FIXED_TOKENS.scope);
    expect(allOutput).toMatch(/key-management access only/i);
    expect(allOutput).toMatch(/zero content access/i);
    expect(allOutput).not.toMatch(/personal account access/i);
    expect(allOutput).not.toContain(FIXED_TOKENS.accessToken);
    expect(allOutput).not.toContain(FIXED_TOKENS.refreshToken);
  });

  it('prints the scope the server actually granted, not just the requested scope, when the server narrows it', async () => {
    const store = fakeStore();
    const handler = createLoginDeviceHandler({
      ...baseHandlerDeps(store),
      pollDeviceToken: async (): Promise<DeviceTokenResult> => ({
        kind: 'success',
        tokens: { ...FIXED_TOKENS, scope: 'account' },
      }),
    });

    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });

    const code = await handler(ctx, commandIntent(['login', '--device']));

    expect(code).toBe(EXIT_SUCCESS);
    const output = stdout.lines.join('');
    expect(output).toContain('Scope: account —');
    expect(output).not.toContain('offline_access');
  });

  it('never writes the access or refresh token to stdout/stderr even on a poll failure', async () => {
    const store = fakeStore();
    const handler = createLoginDeviceHandler({
      ...baseHandlerDeps(store),
      pollDeviceToken: async () => ({ kind: 'request_failed', message: `rejected: ${FIXED_TOKENS.refreshToken}` }),
    });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });

    const code = await handler(ctx, commandIntent(['login', '--device']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    const allOutput = [...stdout.lines, ...stderr.lines].join('');
    expect(allOutput).not.toContain(FIXED_TOKENS.accessToken);
  });

  it('refuses to overwrite an existing stored credential without --yes', async () => {
    const store = fakeStore(
      new Map([['https://pagespace.ai', { kind: 'oauth', refreshToken: 'ps_rt_existing', clientId: 'pagespace-cli', scopes: ['account'], createdAt: '2026-01-01T00:00:00.000Z' }]]),
    );
    const handler = createLoginDeviceHandler(baseHandlerDeps(store));

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });

    const code = await handler(ctx, commandIntent(['login', '--device']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/--yes/);
    expect(stderr.lines.join('')).not.toContain('ps_rt_existing');
  });

  it('overwrites an existing stored credential when --yes is passed', async () => {
    const store = fakeStore(
      new Map([['https://pagespace.ai', { kind: 'oauth', refreshToken: 'ps_rt_existing', clientId: 'pagespace-cli', scopes: ['account'], createdAt: '2026-01-01T00:00:00.000Z' }]]),
    );
    const handler = createLoginDeviceHandler(baseHandlerDeps(store));

    const ctx = createFakeContext({ env: {} });
    const code = await handler(ctx, commandIntent(['login', '--device', '--yes']));

    expect(code).toBe(EXIT_SUCCESS);
    const stored = await store.get('https://pagespace.ai');
    expect((stored && credentialSecret(stored))).toBe(FIXED_TOKENS.refreshToken);
  });

  it('resolves the host from --host, falling back to PAGESPACE_API_URL, then the default', async () => {
    const store = fakeStore();
    const hostsSeen: string[] = [];
    const handler = createLoginDeviceHandler({
      ...baseHandlerDeps(store),
      discoverMetadata: async (host: string) => {
        hostsSeen.push(host);
        return {
          authorizationEndpoint: `${host}/api/oauth/authorize`,
          tokenEndpoint: `${host}/api/oauth/token`,
          deviceAuthorizationEndpoint: `${host}/api/oauth/device_authorization`,
        };
      },
    });

    const ctx = createFakeContext({ env: { PAGESPACE_API_URL: 'https://self-hosted.example' } });
    await handler(ctx, commandIntent(['login', '--device', '--host', 'https://explicit.example']));

    expect(hostsSeen).toEqual(['https://explicit.example']);
  });

  it('maps each failure branch to exit 1 with a distinct, actionable message', async () => {
    const store = fakeStore();

    const cases: Array<[string, Partial<ReturnType<typeof baseHandlerDeps>>, RegExp]> = [
      ['discovery', { discoverMetadata: async () => { throw new Error('offline'); } }, /offline/],
      [
        'device authorization',
        { requestDeviceAuthorization: async () => { throw new Error('invalid_client'); } },
        /invalid_client/,
      ],
      ['access_denied', { pollDeviceToken: async () => ({ kind: 'access_denied' }) }, /denied/i],
      ['expired_token', { pollDeviceToken: async () => ({ kind: 'expired_token' }) }, /expired|again/i],
      ['poll_failed', { pollDeviceToken: async () => ({ kind: 'request_failed', message: 'boom' }) }, /boom/],
      ['interrupted', { createIsInterrupted: () => () => true }, /cancel/i],
    ];

    for (const [, overrides, message] of cases) {
      const handler = createLoginDeviceHandler({ ...baseHandlerDeps(store), ...overrides });
      const stderr = createRecordingSink();
      const ctx = createFakeContext({ stderr, env: {} });

      const code = await handler(ctx, commandIntent(['login', '--device']));

      expect(code).toBe(EXIT_RUNTIME_ERROR);
      expect(stderr.lines.join('')).toMatch(message);
    }
  });
});

describe('createLoginDeviceHandler — named keys', () => {
  it('--key stores the device-login credential under the named slot, leaving "default" for the same host untouched', async () => {
    const store = fakeStore(
      new Map([['https://pagespace.ai', { kind: 'oauth', refreshToken: 'ps_rt_existing_default', clientId: 'pagespace-cli', scopes: ['account'], createdAt: '2026-01-01T00:00:00.000Z' }]]),
    );
    const handler = createLoginDeviceHandler(baseHandlerDeps(store));

    const ctx = createFakeContext({ env: {} });
    const code = await handler(ctx, commandIntent(['login', '--device', '--key', 'work']));

    expect(code).toBe(EXIT_SUCCESS);
    const workCredential = await store.get('https://pagespace.ai', 'work');
    expect((workCredential && credentialSecret(workCredential))).toBe(FIXED_TOKENS.refreshToken);
    const defaultCredential = await store.get('https://pagespace.ai', 'default');
    expect((defaultCredential && credentialSecret(defaultCredential))).toBe('ps_rt_existing_default');
  });

  it('PAGESPACE_KEY env selects the slot when --key is absent', async () => {
    const store = fakeStore();
    const handler = createLoginDeviceHandler(baseHandlerDeps(store));

    const ctx = createFakeContext({ env: { PAGESPACE_KEY: 'work' } });
    const code = await handler(ctx, commandIntent(['login', '--device']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(credentialSecret((await store.get('https://pagespace.ai', 'work'))!)).toBe(FIXED_TOKENS.refreshToken);
    expect(await store.get('https://pagespace.ai', 'default')).toBeNull();
  });

  it('the existing-credential check is scoped to the named slot, not just the host', async () => {
    const store = fakeStore(
      new Map([['https://pagespace.ai', { kind: 'oauth', refreshToken: 'ps_rt_existing_default', clientId: 'pagespace-cli', scopes: ['account'], createdAt: '2026-01-01T00:00:00.000Z' }]]),
    );
    const handler = createLoginDeviceHandler(baseHandlerDeps(store));

    const ctx = createFakeContext({ env: {} });
    const code = await handler(ctx, commandIntent(['login', '--device', '--key', 'work']));

    expect(code).toBe(EXIT_SUCCESS);
  });

  it('refuses to overwrite an existing named credential without --yes, naming the key in the message', async () => {
    const store = fakeStore();
    await store.set(
      'https://pagespace.ai',
      { kind: 'oauth', refreshToken: 'ps_rt_existing_work', clientId: 'pagespace-cli', scopes: ['account'], createdAt: '2026-01-01T00:00:00.000Z' },
      'work',
    );
    const handler = createLoginDeviceHandler(baseHandlerDeps(store));

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const code = await handler(ctx, commandIntent(['login', '--device', '--key', 'work']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('key "work"');
    expect(stderr.lines.join('')).not.toContain('ps_rt_existing_work');
  });
});
