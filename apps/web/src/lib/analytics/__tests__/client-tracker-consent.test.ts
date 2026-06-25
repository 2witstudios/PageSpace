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
});
