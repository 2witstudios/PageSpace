/**
 * `runConsent` is the transport switch every consent-driven command goes
 * through, so the invariants worth pinning here are the ones a command author
 * can't see from their own file: which effects each transport is allowed to
 * touch, and — above all — which delay adapter the device branch gets.
 */
import { describe, expect, it } from 'vitest';
import { runConsent } from '@pagespace/cli';
import type { RunConsentParams } from '@pagespace/cli';

const AUTHORIZATION = {
  deviceCode: 'ps_dc_test',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://pagespace.ai/activate',
  verificationUriComplete: 'https://pagespace.ai/activate?user_code=ABCD-EFGH',
  expiresInSeconds: 900,
  intervalSeconds: 5,
};

const OAUTH_TOKENS = {
  kind: 'oauth' as const,
  accessToken: 'ps_at_test',
  refreshToken: 'ps_rt_test',
  expiresIn: 900,
  scope: 'manage_keys offline_access',
};

function params(overrides: Partial<RunConsentParams> = {}): RunConsentParams {
  return {
    device: false,
    host: 'https://pagespace.ai',
    clientId: 'pagespace-cli',
    scope: 'manage_keys offline_access',
    discoverMetadata: async () => ({
      authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
      tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
      deviceAuthorizationEndpoint: 'https://pagespace.ai/api/oauth/device_authorization',
    }),
    exchangeCode: async () => OAUTH_TOKENS,
    confirmIdentity: async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' }),
    credentialStore: { set: async () => {} },
    loopbackWaitMs: async () => {},
    now: () => Date.parse('2026-07-23T00:00:00.000Z'),
    timeoutMs: 60_000,
    loopback: {
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      startServer: async () => {
        throw new Error('loopback transport not expected in this test');
      },
      openBrowser: async () => true,
      maxPortAttempts: 5,
      onBrowserOpenFailed: () => {},
    },
    deviceDeps: {
      requestDeviceAuthorization: async () => AUTHORIZATION,
      pollDeviceToken: async () => ({ kind: 'success' as const, tokens: OAUTH_TOKENS }),
      createIsInterrupted: () => () => false,
      waitMs: async () => {},
      onDeviceCode: () => {},
    },
    ...overrides,
  };
}

describe('runConsent — transport selection', () => {
  /**
   * Regression guard. `keys create`/`keys use` wire `unrefWaitMs` for their
   * loopback timeout race; handing that same adapter to the device poll loop
   * lets Node exit right after printing the verification code, because between
   * polls that timer is often the only live handle. The device branch must
   * take its adapter from `deviceDeps`, never from the top-level `waitMs`.
   */
  it('polls with the device transport OWN waitMs, never the loopback one', async () => {
    const used: string[] = [];

    // One poll returns authorization_pending so the flow is forced to wait at
    // least once — otherwise a success on the first poll would never touch a
    // timer and the assertion would pass vacuously.
    let polls = 0;
    const result = await runConsent(
      params({
        device: true,
        loopbackWaitMs: async () => {
          used.push('loopback');
        },
        deviceDeps: {
          ...params().deviceDeps,
          waitMs: async () => {
            used.push('device');
          },
          pollDeviceToken: async () => {
            polls += 1;
            return polls === 1
              ? { kind: 'authorization_pending' as const }
              : { kind: 'success' as const, tokens: OAUTH_TOKENS };
          },
        },
      }),
      'pagespace login --device',
    );

    expect(result.outcome).toBe('success');
    expect(polls).toBeGreaterThan(1);
    expect(used).toContain('device');
    expect(used).not.toContain('loopback');
  });

  it('never opens a browser or binds a loopback port in device mode', async () => {
    let browserOpened = false;
    let serverStarted = false;

    const result = await runConsent(
      params({
        device: true,
        loopback: {
          ...params().loopback,
          openBrowser: async () => {
            browserOpened = true;
            return true;
          },
          startServer: async () => {
            serverStarted = true;
            throw new Error('should not start');
          },
        },
      }),
      'pagespace login --device',
    );

    expect(result.outcome).toBe('success');
    expect(browserOpened).toBe(false);
    expect(serverStarted).toBe(false);
  });

  it('never requests a device authorization in loopback mode', async () => {
    let deviceRequested = false;

    await runConsent(
      params({
        device: false,
        loopback: {
          ...params().loopback,
          startServer: async () => {
            throw new Error('bind failed');
          },
        },
        deviceDeps: {
          ...params().deviceDeps,
          requestDeviceAuthorization: async () => {
            deviceRequested = true;
            return AUTHORIZATION;
          },
        },
      }),
      'pagespace login',
    );

    expect(deviceRequested).toBe(false);
  });

  it('names the device fallback when a loopback port cannot be bound', async () => {
    const result = await runConsent(
      params({
        loopback: {
          ...params().loopback,
          startServer: async () => {
            throw new Error('EADDRINUSE');
          },
        },
      }),
      'pagespace keys create',
    );

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.message).toContain('--device');
  });

  it('carries the retry command into the timeout message so the hint matches what was typed', async () => {
    const result = await runConsent(
      params({
        device: true,
        deviceDeps: {
          ...params().deviceDeps,
          pollDeviceToken: async () => ({ kind: 'expired_token' as const }),
        },
      }),
      'pagespace keys create --device',
    );

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.message).toContain('pagespace keys create --device');
  });
});
