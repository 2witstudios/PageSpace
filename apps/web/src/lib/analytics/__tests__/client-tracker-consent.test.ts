// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CONSENT_COOKIE_NAME,
  serializeConsentState,
  defaultConsentState,
  acceptAll,
  rejectNonEssential,
} from '@pagespace/lib/consent';

vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MODE', 'cloud');

// auth-fetch.post is the fallback send path — mock it so we can assert it is never hit either.
const postMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../auth/auth-fetch', () => ({ post: (...args: unknown[]) => postMock(...args) }));

const { isCapacitorApp } = vi.hoisted(() => ({ isCapacitorApp: vi.fn(() => false) }));
vi.mock('@/lib/capacitor-bridge', () => ({ isCapacitorApp }));

import { track } from '../client-tracker';

const NOW = '2026-06-24T00:00:00.000Z';
const beacon = vi.fn().mockReturnValue(true);

function setConsentCookie(value: string | null) {
  if (value === null) {
    document.cookie = `${CONSENT_COOKIE_NAME}=; path=/; max-age=0`;
  } else {
    document.cookie = `${CONSENT_COOKIE_NAME}=${encodeURIComponent(value)}; path=/`;
  }
}

beforeEach(() => {
  beacon.mockClear();
  isCapacitorApp.mockReturnValue(false);
  postMock.mockClear();
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true, writable: true });
  setConsentCookie(null);
});

afterEach(() => {
  setConsentCookie(null);
});

describe('client tracker consent gate', () => {
  it('makes zero sends with no consent decision', () => {
    track('feature_used', { feature: 'x' });
    expect(beacon).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('makes zero sends when analytics is rejected', () => {
    setConsentCookie(serializeConsentState(rejectNonEssential(defaultConsentState(), NOW)));
    track('feature_used', { feature: 'x' });
    expect(beacon).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('sends once analytics consent is granted', () => {
    setConsentCookie(serializeConsentState(acceptAll(defaultConsentState(), NOW)));
    track('feature_used', { feature: 'x' });
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it('never sends on onprem even with consent granted', () => {
    vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MODE', 'onprem');
    setConsentCookie(serializeConsentState(acceptAll(defaultConsentState(), NOW)));
    track('feature_used', { feature: 'x' });
    expect(beacon).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
    vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MODE', 'cloud');
  });

  // App Review (5.1.2(i)): the native app shows no consent prompt, so a grant stored
  // earlier — accepted in a previous build, or toggled on /settings/privacy — must not
  // turn analytics back on there.
  it('never sends in the native app even with analytics consent stored', () => {
    isCapacitorApp.mockReturnValue(true);
    setConsentCookie(serializeConsentState(acceptAll(defaultConsentState(), NOW)));
    track('feature_used', { feature: 'x' });
    expect(beacon).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('never sends in the native app with no consent decision', () => {
    isCapacitorApp.mockReturnValue(true);
    track('feature_used', { feature: 'x' });
    expect(beacon).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });
});
