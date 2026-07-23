import { describe, expect, it } from 'vitest';
import { credentialSecret, decideNextPoll, runDeviceLogin } from '@pagespace/cli';
import type {
  DeviceAuthorization,
  DeviceLoginDeps,
  DevicePollState,
  DeviceTokenResult,
  ExchangedTokens,
  HostCredential,
  Identity,
} from '@pagespace/cli';

const NOW = Date.parse('2026-07-03T00:00:00.000Z');

const AUTHORIZATION: DeviceAuthorization = {
  deviceCode: 'ps_dc_test',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://pagespace.ai/activate',
  verificationUriComplete: 'https://pagespace.ai/activate?user_code=ABCD-EFGH',
  expiresInSeconds: 1800,
  intervalSeconds: 5,
};

const TOKENS: ExchangedTokens = {
  kind: 'oauth',
  accessToken: 'ps_at_test-access-token',
  refreshToken: 'ps_rt_test-refresh-token',
  expiresIn: 900,
  scope: 'account offline_access',
};

const IDENTITY: Identity = { name: 'Ada Lovelace', email: 'ada@example.com' };

describe('decideNextPoll', () => {
  const baseState: DevicePollState = { intervalMs: 5000, deadline: NOW + 60_000 };

  it('keeps waiting at the same interval on authorization_pending', () => {
    const decision = decideNextPoll(baseState, { kind: 'authorization_pending' }, NOW);
    expect(decision).toEqual({ action: 'continue', waitMs: 5000, nextState: baseState });
  });

  it('adds 5s to the interval on slow_down (RFC 8628 §3.5) and carries the wider interval forward', () => {
    const first = decideNextPoll(baseState, { kind: 'slow_down' }, NOW);
    expect(first).toEqual({
      action: 'continue',
      waitMs: 10_000,
      nextState: { intervalMs: 10_000, deadline: baseState.deadline },
    });

    const nextState = (first as { nextState: DevicePollState }).nextState;
    const second = decideNextPoll(nextState, { kind: 'slow_down' }, NOW);
    expect(second).toEqual({
      action: 'continue',
      waitMs: 15_000,
      nextState: { intervalMs: 15_000, deadline: baseState.deadline },
    });
  });

  it('stops with success and passes the tokens through untouched', () => {
    const decision = decideNextPoll(baseState, { kind: 'success', tokens: TOKENS }, NOW);
    expect(decision).toEqual({ action: 'stop', outcome: { kind: 'success', tokens: TOKENS } });
  });

  it('stops with access_denied', () => {
    const decision = decideNextPoll(baseState, { kind: 'access_denied' }, NOW);
    expect(decision).toEqual({ action: 'stop', outcome: { kind: 'access_denied' } });
  });

  it('stops with expired_token', () => {
    const decision = decideNextPoll(baseState, { kind: 'expired_token' }, NOW);
    expect(decision).toEqual({ action: 'stop', outcome: { kind: 'expired_token' } });
  });

  it('stops with poll_failed, carrying the transport error message', () => {
    const decision = decideNextPoll(baseState, { kind: 'request_failed', message: 'network_error: ECONNRESET' }, NOW);
    expect(decision).toEqual({ action: 'stop', outcome: { kind: 'poll_failed', message: 'network_error: ECONNRESET' } });
  });

  it('stops with timeout once now reaches the local deadline, even given a pending response', () => {
    const decision = decideNextPoll(baseState, { kind: 'authorization_pending' }, baseState.deadline);
    expect(decision).toEqual({ action: 'stop', outcome: { kind: 'timeout' } });
  });

  it('local timeout takes precedence over a success response received at/after the deadline', () => {
    const decision = decideNextPoll(baseState, { kind: 'success', tokens: TOKENS }, baseState.deadline + 1);
    expect(decision).toEqual({ action: 'stop', outcome: { kind: 'timeout' } });
  });

  it('is a pure function: identical input produces a deep-equal result', () => {
    const response: DeviceTokenResult = { kind: 'slow_down' };
    expect(decideNextPoll(baseState, response, NOW)).toEqual(decideNextPoll(baseState, response, NOW));
  });
});

function baseDeps(
  overrides: Partial<DeviceLoginDeps> = {},
): { deps: DeviceLoginDeps; store: Map<string, HostCredential>; printed: DeviceAuthorization[] } {
  const store = new Map<string, HostCredential>();
  const printed: DeviceAuthorization[] = [];

  const deps: DeviceLoginDeps = {
    host: 'https://pagespace.ai',
    clientId: 'pagespace-cli',
    scope: 'account offline_access',
    discoverMetadata: async () => ({
      authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
      tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
      deviceAuthorizationEndpoint: 'https://pagespace.ai/api/oauth/device_authorization',
    }),
    requestDeviceAuthorization: async () => AUTHORIZATION,
    pollDeviceToken: async () => ({ kind: 'success', tokens: TOKENS }),
    waitMs: async () => {},
    now: () => NOW,
    onDeviceCode: (authorization) => {
      printed.push(authorization);
    },
    credentialStore: {
      set: async (host, credential) => {
        store.set(host, credential);
      },
    },
    confirmIdentity: async () => IDENTITY,
    isInterrupted: () => false,
    ...overrides,
  };

  return { deps, store, printed };
}

describe('runDeviceLogin — happy path', () => {
  it('discovers, requests device authorization, prints the code, polls to success, persists, and confirms identity', async () => {
    const { deps, store, printed } = baseDeps();

    const result = await runDeviceLogin(deps);

    expect(result).toEqual({ outcome: 'success', identity: IDENTITY, scope: TOKENS.scope });
    expect(printed).toEqual([AUTHORIZATION]);
    expect(store.get('https://pagespace.ai')).toEqual({
      kind: 'oauth',
      refreshToken: TOKENS.refreshToken,
      clientId: 'pagespace-cli',
      scopes: ['account', 'offline_access'],
      createdAt: new Date(NOW).toISOString(),
    });
  });

  it('persists the credential under deps.profile when given, defaulting to "default" when omitted', async () => {
    const setCalls: Array<{ host: string; profile: string | undefined }> = [];
    const { deps } = baseDeps({
      profile: 'work',
      credentialStore: {
        set: async (host, _credential, profile) => {
          setCalls.push({ host, profile });
        },
      },
    });

    await runDeviceLogin(deps);

    expect(setCalls).toEqual([{ host: 'https://pagespace.ai', profile: 'work' }]);
  });

  it('persists the credential under the "default" profile when no profile is given', async () => {
    const setCalls: Array<{ host: string; profile: string | undefined }> = [];
    const { deps } = baseDeps({
      credentialStore: {
        set: async (host, _credential, profile) => {
          setCalls.push({ host, profile });
        },
      },
    });

    await runDeviceLogin(deps);

    expect(setCalls).toEqual([{ host: 'https://pagespace.ai', profile: 'default' }]);
  });

  it('keeps polling through authorization_pending and slow_down before succeeding, honoring the accumulated backoff', async () => {
    const waited: number[] = [];
    const responses: DeviceTokenResult[] = [
      { kind: 'authorization_pending' },
      { kind: 'slow_down' },
      { kind: 'authorization_pending' },
      { kind: 'success', tokens: TOKENS },
    ];
    let call = 0;
    const { deps } = baseDeps({
      waitMs: async (ms) => {
        waited.push(ms);
      },
      pollDeviceToken: async () => responses[call++]!,
    });

    const result = await runDeviceLogin(deps);

    expect(result.outcome).toBe('success');
    expect(waited).toEqual([5000, 5000, 10_000, 10_000]);
  });

  it('never exposes the access or refresh token anywhere in the returned result', async () => {
    const { deps } = baseDeps();

    const result = await runDeviceLogin(deps);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TOKENS.accessToken);
    expect(serialized).not.toContain(TOKENS.refreshToken);
  });

  it('still succeeds with a null identity when identity confirmation fails after tokens are already persisted', async () => {
    const { deps, store } = baseDeps({
      confirmIdentity: async () => {
        throw new Error('whoami unreachable');
      },
    });

    const result = await runDeviceLogin(deps);

    expect(result).toEqual({ outcome: 'success', identity: null, scope: TOKENS.scope });
    expect(credentialSecret(store.get('https://pagespace.ai')!)).toBe(TOKENS.refreshToken);
  });

  // The device flow legitimately mints keys now (`keys create --device`), but
  // ONLY when this flow asked for one — a mint is always requested with a
  // `name:` scope token.
  it('treats a surprise mint as poll_failed when the requested scope never asked for one (login --device)', async () => {
    let setCalls = 0;
    const { deps } = baseDeps({
      scope: 'manage_keys offline_access',
      pollDeviceToken: async () => ({ kind: 'success', tokens: { kind: 'mcp', token: 'mcp_unexpected', scope: 'drive:d1:member' } }),
      credentialStore: {
        set: async () => {
          setCalls += 1;
        },
      },
    });

    const result = await runDeviceLogin(deps);

    expect(result.outcome).toBe('poll_failed');
    expect(setCalls).toBe(0);
  });

  it('persists a minted mcp_* key as a static credential when the request DID ask for a mint (keys create --device)', async () => {
    const { deps, store } = baseDeps({
      scope: 'drive:d1:member name:remote-key offline_access',
      profile: 'remote-key',
      pollDeviceToken: async () => ({
        kind: 'success',
        tokens: { kind: 'mcp', token: 'mcp_minted', scope: 'drive:d1:member name:remote-key offline_access' },
      }),
    });

    const result = await runDeviceLogin(deps);

    expect(result.outcome).toBe('success');
    const stored = store.get('https://pagespace.ai');
    expect(stored).toEqual({
      kind: 'static',
      token: 'mcp_minted',
      scopes: ['drive:d1:member', 'name:remote-key', 'offline_access'],
      createdAt: new Date(NOW).toISOString(),
    });
  });

  it('surfaces a minted token through onMintedStaticToken for --show-token, and never for an oauth grant', async () => {
    const surfaced: string[] = [];
    const { deps } = baseDeps({
      scope: 'drive:d1:member name:k offline_access',
      pollDeviceToken: async () => ({
        kind: 'success',
        tokens: { kind: 'mcp', token: 'mcp_minted', scope: 'drive:d1:member name:k' },
      }),
      onMintedStaticToken: (token) => surfaced.push(token),
    });
    await runDeviceLogin(deps);
    expect(surfaced).toEqual(['mcp_minted']);

    const oauth = baseDeps({ onMintedStaticToken: (token) => surfaced.push(token) });
    await runDeviceLogin(oauth.deps);
    expect(surfaced).toEqual(['mcp_minted']);
  });

  it('persists NOTHING and reports the re-scoped key id for an mcp_update redemption', async () => {
    let setCalls = 0;
    const { deps } = baseDeps({
      scope: 'update_key:tok123 drive:d1:member',
      pollDeviceToken: async () => ({
        kind: 'success',
        tokens: { kind: 'mcp_update', tokenId: 'tok123', scope: 'update_key:tok123 drive:d1:member' },
      }),
      credentialStore: {
        set: async () => {
          setCalls += 1;
        },
      },
    });

    const result = await runDeviceLogin(deps);

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') throw new Error('unreachable');
    expect(result.updatedTokenId).toBe('tok123');
    expect(setCalls).toBe(0);
  });

  it('persists NOTHING and reports the approved key id for an mcp_activate redemption', async () => {
    let setCalls = 0;
    const { deps } = baseDeps({
      scope: 'activate_key:tok123',
      pollDeviceToken: async () => ({
        kind: 'success',
        tokens: { kind: 'mcp_activate', tokenId: 'tok123', scope: 'activate_key:tok123' },
      }),
      credentialStore: {
        set: async () => {
          setCalls += 1;
        },
      },
    });

    const result = await runDeviceLogin(deps);

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') throw new Error('unreachable');
    expect(result.activatedTokenId).toBe('tok123');
    expect(setCalls).toBe(0);
  });

  it('fails closed when an update/activate request is answered with a real mint — nothing is stored', async () => {
    let setCalls = 0;
    const { deps } = baseDeps({
      scope: 'activate_key:tok123',
      pollDeviceToken: async () => ({
        kind: 'success',
        tokens: { kind: 'mcp', token: 'mcp_surprise', scope: 'drive:d1:member name:sneaky' },
      }),
      credentialStore: {
        set: async () => {
          setCalls += 1;
        },
      },
    });

    const result = await runDeviceLogin(deps);

    expect(result.outcome).toBe('poll_failed');
    expect(setCalls).toBe(0);
  });
});

describe('runDeviceLogin — failure branches', () => {
  it('fails closed on discovery errors without ever requesting device authorization', async () => {
    let requested = false;
    const { deps } = baseDeps({
      discoverMetadata: async () => {
        throw new Error('offline');
      },
      requestDeviceAuthorization: async () => {
        requested = true;
        return AUTHORIZATION;
      },
    });

    const result = await runDeviceLogin(deps);

    expect(result).toEqual({ outcome: 'discovery_failed', message: 'offline' });
    expect(requested).toBe(false);
  });

  it('fails closed when the discovered metadata has no device_authorization_endpoint', async () => {
    const { deps } = baseDeps({
      discoverMetadata: async () => ({
        authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
        tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
      }),
    });

    const result = await runDeviceLogin(deps);

    expect(result.outcome).toBe('discovery_failed');
  });

  it('fails closed when the device authorization request itself fails', async () => {
    const { deps } = baseDeps({
      requestDeviceAuthorization: async () => {
        throw new Error('invalid_client');
      },
    });

    const result = await runDeviceLogin(deps);

    expect(result).toEqual({ outcome: 'device_authorization_failed', message: 'invalid_client' });
  });

  it('maps a denied poll to access_denied without persisting anything', async () => {
    let setCalls = 0;
    const { deps } = baseDeps({
      pollDeviceToken: async () => ({ kind: 'access_denied' }),
      credentialStore: {
        set: async () => {
          setCalls += 1;
        },
      },
    });

    const result = await runDeviceLogin(deps);

    expect(result).toEqual({ outcome: 'access_denied' });
    expect(setCalls).toBe(0);
  });

  it('maps an expired device code to expired_token', async () => {
    const { deps } = baseDeps({ pollDeviceToken: async () => ({ kind: 'expired_token' }) });

    const result = await runDeviceLogin(deps);

    expect(result).toEqual({ outcome: 'expired_token' });
  });

  it('surfaces a poll transport failure as poll_failed with its message', async () => {
    const { deps } = baseDeps({
      pollDeviceToken: async () => ({ kind: 'request_failed', message: 'network_error: ECONNRESET' }),
    });

    const result = await runDeviceLogin(deps);

    expect(result).toEqual({ outcome: 'poll_failed', message: 'network_error: ECONNRESET' });
  });

  it('times out locally once the deadline passes, independent of any server response', async () => {
    let clock = NOW;
    const { deps } = baseDeps({
      timeoutMs: 5,
      now: () => clock,
      waitMs: async () => {
        clock += 100;
      },
      pollDeviceToken: async () => ({ kind: 'authorization_pending' }),
    });

    const result = await runDeviceLogin(deps);

    expect(result).toEqual({ outcome: 'timeout' });
  });

  it('exits cleanly on interrupt mid-poll without persisting or confirming identity', async () => {
    let interrupted = false;
    let setCalls = 0;
    let confirmCalls = 0;
    const { deps } = baseDeps({
      waitMs: async () => {
        interrupted = true;
      },
      isInterrupted: () => interrupted,
      pollDeviceToken: async () => {
        throw new Error('pollDeviceToken should not be called after an interrupt');
      },
      credentialStore: {
        set: async () => {
          setCalls += 1;
        },
      },
      confirmIdentity: async () => {
        confirmCalls += 1;
        return IDENTITY;
      },
    });

    const result = await runDeviceLogin(deps);

    expect(result).toEqual({ outcome: 'interrupted' });
    expect(setCalls).toBe(0);
    expect(confirmCalls).toBe(0);
  });

  it('checks for interrupt before the very first wait, never polling at all', async () => {
    let polled = false;
    const { deps } = baseDeps({
      isInterrupted: () => true,
      pollDeviceToken: async () => {
        polled = true;
        return { kind: 'success', tokens: TOKENS };
      },
    });

    const result = await runDeviceLogin(deps);

    expect(result).toEqual({ outcome: 'interrupted' });
    expect(polled).toBe(false);
  });
});
