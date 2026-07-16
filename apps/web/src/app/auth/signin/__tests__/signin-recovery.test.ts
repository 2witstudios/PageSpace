import { describe, it, expect } from 'vitest';
import { decideSigninRecovery, type SigninRecoveryInput } from '../signin-recovery';

// The signin page attempts a silent session recovery before it ever shows the form:
// a live session cookie should redirect the user onward, and an expired cookie backed
// by a valid device token should refresh silently. decideSigninRecovery is the pure
// core of that flow — the shell feeds it observations one at a time (undefined = "not
// observed yet") and performs whatever action it returns until a terminal action.
//
// Regression context: middleware began redirecting cookieless navigations to /auth/signin
// on 2026-07-07, which killed the app's own JS-level device-token recovery. This restores
// it at the one page every bounced user now lands on.

const base: SigninRecoveryInput = {
  isNativeShell: false,
  authFailedPermanently: false,
  meAuthenticated: undefined,
  hasDeviceToken: false,
  refreshSucceeded: undefined,
};

describe('decideSigninRecovery', () => {
  it('skips recovery entirely inside a native shell (desktop/Capacitor own their session)', () => {
    // Native shells manage sessions via bearer tokens / keychain, not cookies — the store's
    // loadSession already handles them, so the web recovery must stay out of the way.
    expect(decideSigninRecovery({ ...base, isNativeShell: true })).toEqual({ type: 'skip' });
    // Native wins even when other signals would otherwise drive recovery.
    expect(
      decideSigninRecovery({ ...base, isNativeShell: true, meAuthenticated: true }),
    ).toEqual({ type: 'skip' });
  });

  it('shows the form immediately when auth has permanently failed (never retry — that is the loop)', () => {
    expect(
      decideSigninRecovery({ ...base, authFailedPermanently: true }),
    ).toEqual({ type: 'show-form' });
    // A dead-permanent flag must short-circuit even if a device token is present.
    expect(
      decideSigninRecovery({ ...base, authFailedPermanently: true, hasDeviceToken: true }),
    ).toEqual({ type: 'show-form' });
  });

  it('checks the current session first, before any other observation exists', () => {
    expect(decideSigninRecovery(base)).toEqual({ type: 'check-me' });
  });

  it('redirects when the session is already live', () => {
    expect(
      decideSigninRecovery({ ...base, meAuthenticated: true }),
    ).toEqual({ type: 'redirect' });
  });

  it('shows the form when the session is dead and there is no device token to recover from', () => {
    expect(
      decideSigninRecovery({ ...base, meAuthenticated: false, hasDeviceToken: false }),
    ).toEqual({ type: 'show-form' });
  });

  it('attempts a device-token refresh when the session is dead but a device token exists', () => {
    expect(
      decideSigninRecovery({ ...base, meAuthenticated: false, hasDeviceToken: true }),
    ).toEqual({ type: 'refresh' });
  });

  it('redirects after a device-token refresh succeeds', () => {
    expect(
      decideSigninRecovery({
        ...base,
        meAuthenticated: false,
        hasDeviceToken: true,
        refreshSucceeded: true,
      }),
    ).toEqual({ type: 'redirect' });
  });

  it('shows the form after a device-token refresh fails (revoked/expired token — no loop)', () => {
    expect(
      decideSigninRecovery({
        ...base,
        meAuthenticated: false,
        hasDeviceToken: true,
        refreshSucceeded: false,
      }),
    ).toEqual({ type: 'show-form' });
  });
});
