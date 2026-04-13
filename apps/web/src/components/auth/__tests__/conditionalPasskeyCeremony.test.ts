import { describe, it, expect, vi } from 'vitest';
import { WebAuthnError } from '@simplewebauthn/browser';
import {
  classifyCeremonyError,
  classifyVerifyResponse,
  deriveRefreshIntervalMs,
  driveCeremony,
  handleCeremonyResult,
  isCeremonyAborted,
  isChallengeExpired,
  isRefreshAbort,
  isUnmountAbort,
  nextState,
  runCeremony,
  type CeremonyResult,
} from '../conditionalPasskeyCeremony';

const makeAbortError = () =>
  new WebAuthnError({
    code: 'ERROR_CEREMONY_ABORTED',
    message: 'aborted',
    cause: new Error('aborted'),
  });

describe('deriveRefreshIntervalMs', () => {
  it('given default args, should return (ttl - 1 minute) in ms', () => {
    expect(deriveRefreshIntervalMs()).toBe(4 * 60 * 1000);
  });

  it('given custom ttl and buffer, should subtract buffer from ttl', () => {
    expect(deriveRefreshIntervalMs({ ttlMinutes: 10, bufferMinutes: 2 })).toBe(8 * 60 * 1000);
  });

  it('given buffer ≥ ttl, should clamp to a 1-minute minimum', () => {
    expect(deriveRefreshIntervalMs({ ttlMinutes: 1, bufferMinutes: 5 })).toBe(60 * 1000);
  });
});

describe('isChallengeExpired', () => {
  it('given code CHALLENGE_EXPIRED, should return true', () => {
    expect(isChallengeExpired({ code: 'CHALLENGE_EXPIRED' })).toBe(true);
  });

  it('given a different code, should return false', () => {
    expect(isChallengeExpired({ code: 'CHALLENGE_NOT_FOUND' })).toBe(false);
  });

  it('given no code, should return false', () => {
    expect(isChallengeExpired()).toBe(false);
  });
});

describe('isCeremonyAborted / isUnmountAbort / isRefreshAbort', () => {
  it('given a WebAuthnError with ERROR_CEREMONY_ABORTED, should identify it as aborted', () => {
    expect(isCeremonyAborted({ err: makeAbortError() })).toBe(true);
  });

  it('given any other error, should not identify it as aborted', () => {
    expect(isCeremonyAborted({ err: new Error('boom') })).toBe(false);
  });

  it('given ceremony aborted while unmounted, should classify as unmount abort', () => {
    const err = makeAbortError();
    expect(isUnmountAbort({ err, mounted: false })).toBe(true);
    expect(isRefreshAbort({ err, mounted: false })).toBe(false);
  });

  it('given ceremony aborted while still mounted, should classify as refresh abort', () => {
    const err = makeAbortError();
    expect(isRefreshAbort({ err, mounted: true })).toBe(true);
    expect(isUnmountAbort({ err, mounted: true })).toBe(false);
  });
});

describe('classifyVerifyResponse', () => {
  it('given ok=true with data, should return success', () => {
    const data = { redirectUrl: '/dash' };
    expect(classifyVerifyResponse({ ok: true, data })).toEqual({ status: 'success', data });
  });

  it('given ok=false with code CHALLENGE_EXPIRED, should signal retry with challenge-expired', () => {
    expect(classifyVerifyResponse({ ok: false, code: 'CHALLENGE_EXPIRED' })).toEqual({
      status: 'retry',
      reason: 'challenge-expired',
    });
  });

  it('given ok=false with a different code, should return failure with the message', () => {
    expect(
      classifyVerifyResponse({ ok: false, code: 'USER_NOT_FOUND', message: 'nope' }),
    ).toEqual({ status: 'failure', message: 'nope' });
  });

  it('given ok=false with no message, should fall back to a default failure message', () => {
    expect(classifyVerifyResponse({ ok: false })).toEqual({
      status: 'failure',
      message: 'Authentication failed',
    });
  });
});

describe('classifyCeremonyError', () => {
  it('given an abort error while mounted, should signal retry with refresh-timer', () => {
    expect(classifyCeremonyError({ err: makeAbortError(), mounted: true })).toEqual({
      status: 'retry',
      reason: 'refresh-timer',
    });
  });

  it('given an abort error while unmounted, should return abort unmount', () => {
    expect(classifyCeremonyError({ err: makeAbortError(), mounted: false })).toEqual({
      status: 'abort',
      reason: 'unmount',
    });
  });

  it('given a non-abort error, should return abort ceremony-error', () => {
    expect(classifyCeremonyError({ err: new Error('other'), mounted: true })).toEqual({
      status: 'abort',
      reason: 'ceremony-error',
    });
  });
});

describe('nextState', () => {
  it('given idle state, should transition to running regardless of result', () => {
    expect(nextState({ state: 'idle' })).toBe('running');
  });

  it('given running state with a retry result, should stay running', () => {
    expect(
      nextState({ state: 'running', result: { status: 'retry', reason: 'refresh-timer' } }),
    ).toBe('running');
  });

  it('given running state with a success result, should transition to done', () => {
    expect(
      nextState({ state: 'running', result: { status: 'success', data: {} } }),
    ).toBe('done');
  });

  it('given running state with a failure result, should transition to done', () => {
    expect(
      nextState({ state: 'running', result: { status: 'failure', message: 'x' } }),
    ).toBe('done');
  });

  it('given running state with an abort result, should transition to done', () => {
    expect(
      nextState({ state: 'running', result: { status: 'abort', reason: 'unmount' } }),
    ).toBe('done');
  });
});

describe('driveCeremony', () => {
  it('given two retries then a success, should invoke runOnce three times and return success', async () => {
    const results: CeremonyResult[] = [
      { status: 'retry', reason: 'refresh-timer' },
      { status: 'retry', reason: 'challenge-expired' },
      { status: 'success', data: { redirectUrl: '/dash' } },
    ];
    const runOnce = vi.fn(async () => results.shift()!);
    const out = await driveCeremony({ runOnce, isMounted: () => true });
    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(out).toEqual({ status: 'success', data: { redirectUrl: '/dash' } });
  });

  it('given isMounted flips to false after a retry, should stop looping', async () => {
    let mounted = true;
    const runOnce = vi.fn(async () => {
      mounted = false;
      return { status: 'retry', reason: 'refresh-timer' } as CeremonyResult;
    });
    const out = await driveCeremony({ runOnce, isMounted: () => mounted });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ status: 'retry', reason: 'refresh-timer' });
  });

  it('given a terminal failure on first call, should stop after one invocation', async () => {
    const runOnce = vi.fn(async () => ({ status: 'failure', message: 'nope' }) as CeremonyResult);
    const out = await driveCeremony({ runOnce, isMounted: () => true });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ status: 'failure', message: 'nope' });
  });
});

describe('handleCeremonyResult', () => {
  it('given a success result on web, should call onAuthenticated then onRedirect', async () => {
    const calls: string[] = [];
    const onAuthenticated = vi.fn(() => { calls.push('auth'); });
    const onRedirect = vi.fn((url: string) => { calls.push(`redirect:${url}`); });
    const onFailure = vi.fn();
    await handleCeremonyResult({
      result: { status: 'success', data: { redirectUrl: '/dashboard' } },
      onAuthenticated,
      onRedirect,
      onFailure,
      handleDesktopAuthResponse: async () => false,
    });
    expect(calls).toEqual(['auth', 'redirect:/dashboard']);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('given a success result on desktop, should run onAuthenticated but skip onRedirect', async () => {
    const onAuthenticated = vi.fn();
    const onRedirect = vi.fn();
    const desktopHandler = vi.fn(async () => true);
    await handleCeremonyResult({
      result: { status: 'success', data: { redirectUrl: '/dashboard' } },
      onAuthenticated,
      onRedirect,
      onFailure: vi.fn(),
      handleDesktopAuthResponse: desktopHandler,
    });
    expect(onAuthenticated).toHaveBeenCalled();
    expect(desktopHandler).toHaveBeenCalled();
    expect(onRedirect).not.toHaveBeenCalled();
  });

  it('given a failure result, should call onFailure with message and skip onAuthenticated', async () => {
    const onAuthenticated = vi.fn();
    const onRedirect = vi.fn();
    const onFailure = vi.fn();
    await handleCeremonyResult({
      result: { status: 'failure', message: 'bad' },
      onAuthenticated,
      onRedirect,
      onFailure,
      handleDesktopAuthResponse: async () => false,
    });
    expect(onFailure).toHaveBeenCalledWith('bad');
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(onRedirect).not.toHaveBeenCalled();
  });

  it('given an abort or retry result, should be silent', async () => {
    const onAuthenticated = vi.fn();
    const onRedirect = vi.fn();
    const onFailure = vi.fn();
    const desktopHandler = vi.fn(async () => false);
    await handleCeremonyResult({
      result: { status: 'abort', reason: 'unmount' },
      onAuthenticated,
      onRedirect,
      onFailure,
      handleDesktopAuthResponse: desktopHandler,
    });
    await handleCeremonyResult({
      result: { status: 'retry', reason: 'refresh-timer' },
      onAuthenticated,
      onRedirect,
      onFailure,
      handleDesktopAuthResponse: desktopHandler,
    });
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(onRedirect).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(desktopHandler).not.toHaveBeenCalled();
  });
});

describe('runCeremony (integrated pipe, injected deps)', () => {
  const makeFetchFn = (
    optionsBody: Record<string, unknown>,
    verifyStatus: number,
    verifyBody: Record<string, unknown>,
  ) => {
    const fn = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/options')) {
        return new Response(JSON.stringify(optionsBody), { status: 200 });
      }
      return new Response(JSON.stringify(verifyBody), { status: verifyStatus });
    });
    return fn as unknown as typeof fetch;
  };

  it('given options+verify succeed, should return a success result', async () => {
    const fetchFn = makeFetchFn(
      { options: { challenge: 'abc' } },
      200,
      { redirectUrl: '/dashboard' },
    );
    const startAuthentication = vi.fn(async () => ({ id: 'cred' }) as never);
    const cancelCeremony = vi.fn();
    const result = await runCeremony({
      csrfToken: 'csrf',
      refreshIntervalMs: 60_000,
      getDevicePlatformFields: async () => ({}),
      isMounted: () => true,
      fetchFn,
      startAuthentication,
      cancelCeremony,
    });
    expect(result).toEqual({ status: 'success', data: { redirectUrl: '/dashboard' } });
    expect(cancelCeremony).not.toHaveBeenCalled();
  });

  it('given refresh timer fires and aborts the ceremony, should return retry refresh-timer', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = makeFetchFn({ options: { challenge: 'abc' } }, 200, {});
      const startAuthentication = vi.fn(
        () =>
          new Promise((_, reject) => {
            // Rejection is triggered by cancelCeremony below.
            cancelRef.reject = reject;
          }),
      );
      const cancelRef: { reject?: (err: unknown) => void } = {};
      const cancelCeremony = vi.fn(() => {
        cancelRef.reject?.(makeAbortError());
      });

      const promise = runCeremony({
        csrfToken: 'csrf',
        refreshIntervalMs: 1000,
        getDevicePlatformFields: async () => ({}),
        isMounted: () => true,
        fetchFn,
        startAuthentication: startAuthentication as never,
        cancelCeremony,
      });

      await vi.runOnlyPendingTimersAsync();
      await vi.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(cancelCeremony).toHaveBeenCalled();
      expect(result).toEqual({ status: 'retry', reason: 'refresh-timer' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('given verify returns CHALLENGE_EXPIRED, should return retry challenge-expired', async () => {
    const fetchFn = makeFetchFn(
      { options: { challenge: 'abc' } },
      400,
      { code: 'CHALLENGE_EXPIRED', error: 'expired' },
    );
    const startAuthentication = vi.fn(async () => ({ id: 'cred' }) as never);
    const result = await runCeremony({
      csrfToken: 'csrf',
      refreshIntervalMs: 60_000,
      getDevicePlatformFields: async () => ({}),
      isMounted: () => true,
      fetchFn,
      startAuthentication,
      cancelCeremony: vi.fn(),
    });
    expect(result).toEqual({ status: 'retry', reason: 'challenge-expired' });
  });

  it('given options fetch fails, should return abort options-failed', async () => {
    const fetchFn = vi.fn(async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    const result = await runCeremony({
      csrfToken: 'csrf',
      refreshIntervalMs: 60_000,
      getDevicePlatformFields: async () => ({}),
      isMounted: () => true,
      fetchFn,
      startAuthentication: vi.fn() as never,
      cancelCeremony: vi.fn(),
    });
    expect(result).toEqual({ status: 'abort', reason: 'options-failed' });
  });

  it('given a step throws, should swallow and return abort ceremony-error', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const result = await runCeremony({
      csrfToken: 'csrf',
      refreshIntervalMs: 60_000,
      getDevicePlatformFields: async () => {
        throw new Error('platform fields failed');
      },
      isMounted: () => true,
      fetchFn,
      startAuthentication: vi.fn() as never,
      cancelCeremony: vi.fn(),
    });
    expect(result).toEqual({ status: 'abort', reason: 'ceremony-error' });
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});
