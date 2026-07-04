import { describe, expect, it, vi } from 'vitest';
import { AuthenticationError, NetworkError, ValidationError } from '../../errors.js';
import { OAuthTokenProvider, type OAuthTokens } from '../oauth.js';

function makeTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: 'ps_at_initial',
    accessExpiresAt: 1_000_000,
    refreshToken: 'ps_rt_initial',
    refreshExpiresAt: 5_000_000,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('OAuthTokenProvider', () => {
  it('returns the cached access token when inside the skew window (no network call)', async () => {
    const refreshAccessToken = vi.fn();
    const provider = new OAuthTokenProvider({
      initialTokens: makeTokens({ accessExpiresAt: 1_000_000 }),
      refreshAccessToken,
      now: () => 0,
      skewMs: 60_000,
    });

    await expect(provider.getAccessToken()).resolves.toBe('ps_at_initial');
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes proactively at the skew boundary rather than waiting for a 401', async () => {
    const refreshed = makeTokens({ accessToken: 'ps_at_new', accessExpiresAt: 2_000_000 });
    const refreshAccessToken = vi.fn().mockResolvedValue(refreshed);
    const provider = new OAuthTokenProvider({
      initialTokens: makeTokens({ accessExpiresAt: 60_000, refreshToken: 'ps_rt_initial' }),
      refreshAccessToken,
      now: () => 0,
      skewMs: 60_000,
    });

    await expect(provider.getAccessToken()).resolves.toBe('ps_at_new');
    expect(refreshAccessToken).toHaveBeenCalledWith('ps_rt_initial');
  });

  it('performs exactly one network refresh for N concurrent callers (single-flight)', async () => {
    const { promise, resolve } = deferred<OAuthTokens>();
    const refreshAccessToken = vi.fn().mockReturnValue(promise);
    const provider = new OAuthTokenProvider({
      initialTokens: makeTokens({ accessExpiresAt: 0 }),
      refreshAccessToken,
      now: () => 0,
      skewMs: 60_000,
    });

    const calls = [provider.getAccessToken(), provider.getAccessToken(), provider.getAccessToken()];
    resolve(makeTokens({ accessToken: 'ps_at_shared', accessExpiresAt: 2_000_000 }));

    const results = await Promise.all(calls);
    expect(results).toEqual(['ps_at_shared', 'ps_at_shared', 'ps_at_shared']);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('clears a failed flight so the next call performs a fresh network refresh', async () => {
    const first = deferred<OAuthTokens>();
    const refreshAccessToken = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(makeTokens({ accessToken: 'ps_at_second_try', accessExpiresAt: 2_000_000 }));
    const provider = new OAuthTokenProvider({
      initialTokens: makeTokens({ accessExpiresAt: 0 }),
      refreshAccessToken,
      now: () => 0,
      skewMs: 60_000,
    });

    const failingCall = provider.getAccessToken();
    first.reject(new NetworkError('offline'));
    await expect(failingCall).rejects.toBeInstanceOf(NetworkError);

    await expect(provider.getAccessToken()).resolves.toBe('ps_at_second_try');
    expect(refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it('invokes onTokensUpdated with the full rotated token payload on every successful refresh', async () => {
    const refreshed = makeTokens({
      accessToken: 'ps_at_new',
      accessExpiresAt: 2_000_000,
      refreshToken: 'ps_rt_new',
      refreshExpiresAt: 6_000_000,
    });
    const refreshAccessToken = vi.fn().mockResolvedValue(refreshed);
    const onTokensUpdated = vi.fn();
    const provider = new OAuthTokenProvider({
      initialTokens: makeTokens({ accessExpiresAt: 0 }),
      refreshAccessToken,
      onTokensUpdated,
      now: () => 0,
      skewMs: 60_000,
    });

    await provider.getAccessToken();
    expect(onTokensUpdated).toHaveBeenCalledTimes(1);
    expect(onTokensUpdated).toHaveBeenCalledWith(refreshed);
  });

  it('transitions to unauthenticated on a definitive invalid_grant rejection and does not retry-loop', async () => {
    const refreshAccessToken = vi.fn().mockRejectedValue(new ValidationError('invalid_grant', []));
    const provider = new OAuthTokenProvider({
      initialTokens: makeTokens({ accessExpiresAt: 0 }),
      refreshAccessToken,
      now: () => 0,
      skewMs: 60_000,
    });

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(AuthenticationError);
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(AuthenticationError);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('retries a transient refresh failure instead of going terminal', async () => {
    const refreshAccessToken = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError('offline'))
      .mockResolvedValueOnce(makeTokens({ accessToken: 'ps_at_recovered', accessExpiresAt: 2_000_000 }));
    const provider = new OAuthTokenProvider({
      initialTokens: makeTokens({ accessExpiresAt: 0 }),
      refreshAccessToken,
      now: () => 0,
      skewMs: 60_000,
    });

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(NetworkError);
    await expect(provider.getAccessToken()).resolves.toBe('ps_at_recovered');
  });

  it('invalidate() forces the next call through refresh instead of replaying the rejected token', async () => {
    const refreshAccessToken = vi
      .fn()
      .mockResolvedValue(makeTokens({ accessToken: 'ps_at_fresh', accessExpiresAt: 2_000_000 }));
    const provider = new OAuthTokenProvider({
      initialTokens: makeTokens({ accessToken: 'ps_at_stale', accessExpiresAt: 1_000_000 }),
      refreshAccessToken,
      now: () => 0,
      skewMs: 60_000,
    });

    provider.invalidate();
    await expect(provider.getAccessToken()).resolves.toBe('ps_at_fresh');
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('is a no-op to invalidate() twice in a row', async () => {
    const refreshAccessToken = vi
      .fn()
      .mockResolvedValue(makeTokens({ accessToken: 'ps_at_fresh', accessExpiresAt: 2_000_000 }));
    const provider = new OAuthTokenProvider({
      initialTokens: makeTokens({ accessExpiresAt: 1_000_000 }),
      refreshAccessToken,
      now: () => 0,
      skewMs: 60_000,
    });

    provider.invalidate();
    provider.invalidate();
    await expect(provider.getAccessToken()).resolves.toBe('ps_at_fresh');
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('never includes a token value in a thrown error message or the provider\'s own serialization', async () => {
    const secretRefreshToken = 'ps_rt_topsecret';
    const secretAccessToken = 'ps_at_topsecret';
    const refreshAccessToken = vi.fn().mockRejectedValue(new ValidationError('invalid_grant', []));
    const provider = new OAuthTokenProvider({
      initialTokens: makeTokens({
        accessToken: secretAccessToken,
        accessExpiresAt: 0,
        refreshToken: secretRefreshToken,
      }),
      refreshAccessToken,
      now: () => 0,
      skewMs: 60_000,
    });

    let caught: unknown;
    try {
      await provider.getAccessToken();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuthenticationError);
    expect((caught as Error).message).not.toContain(secretRefreshToken);
    expect((caught as Error).message).not.toContain(secretAccessToken);
    expect(JSON.stringify(provider)).not.toContain(secretRefreshToken);
    expect(JSON.stringify(provider)).not.toContain(secretAccessToken);
  });

  it('fails closed without a network call once the refresh token itself has expired', async () => {
    const refreshAccessToken = vi.fn();
    const provider = new OAuthTokenProvider({
      initialTokens: makeTokens({ accessExpiresAt: 0, refreshExpiresAt: 500 }),
      refreshAccessToken,
      now: () => 1_000,
      skewMs: 60_000,
    });

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(AuthenticationError);
    expect(refreshAccessToken).not.toHaveBeenCalled();

    // Stays terminal on a subsequent call too.
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(AuthenticationError);
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('propagates the refresh HTTP call errors from the injected transport (no bespoke fetch inside the provider)', async () => {
    const transportError = new NetworkError('DNS resolution failed');
    const refreshAccessToken = vi.fn().mockRejectedValue(transportError);
    const provider = new OAuthTokenProvider({
      initialTokens: makeTokens({ accessExpiresAt: 0 }),
      refreshAccessToken,
      now: () => 0,
      skewMs: 60_000,
    });

    await expect(provider.getAccessToken()).rejects.toBe(transportError);
  });
});
