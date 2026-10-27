import { describe, it, expect } from 'vitest';
import {
  CONSENT_VERSION,
  defaultConsentState,
  parseConsentCookie,
  serializeConsentState,
  isCategoryAllowed,
  shouldShowConsentBanner,
  shouldFireAnalytics,
  shouldLoadThirdPartyScript,
  acceptAll,
  rejectNonEssential,
  withCustomConsent,
} from '../consent-core';

const NOW = '2026-06-24T00:00:00.000Z';

describe('consent-core: cookie parsing', () => {
  it('returns necessary-only default for missing/malformed cookies', () => {
    for (const raw of ['', '   ', 'not-json', '{', '{"version":1}']) {
      const state = parseConsentCookie(raw);
      expect({
        necessary: isCategoryAllowed(state, 'necessary'),
        analytics: isCategoryAllowed(state, 'analytics'),
        preferences: isCategoryAllowed(state, 'preferences'),
      }).toEqual({ necessary: true, analytics: false, preferences: false });
    }
  });

  it('returns default no-decision state for undefined', () => {
    expect(parseConsentCookie(undefined).decidedAt).toBeNull();
  });
});

describe('consent-core: serialization round-trip', () => {
  it('serialize → parse is identity and carries the version', () => {
    const state = acceptAll(defaultConsentState(), NOW);
    const round = parseConsentCookie(serializeConsentState(state));
    expect(round).toEqual({ ...state, version: CONSENT_VERSION });
  });
});

describe('consent-core: stale version re-shows banner', () => {
  it('treats an older schema version as no-consent', () => {
    const stale = JSON.stringify({
      version: CONSENT_VERSION - 1,
      decidedAt: NOW,
      categories: { necessary: true, analytics: true, preferences: true },
    });
    const state = parseConsentCookie(stale);
    expect({ show: shouldShowConsentBanner(state), analytics: isCategoryAllowed(state, 'analytics') }).toEqual({
      show: true,
      analytics: false,
    });
  });
});

describe('consent-core: category gating', () => {
  it('allows a non-necessary category only when explicitly granted', () => {
    const granted = withCustomConsent(defaultConsentState(), { analytics: true }, NOW);
    expect(isCategoryAllowed(granted, 'analytics')).toBe(true);
    expect(isCategoryAllowed(defaultConsentState(), 'analytics')).toBe(false);
  });

  it('always allows the necessary category regardless of stored state', () => {
    const rejected = rejectNonEssential(defaultConsentState(), NOW);
    expect(isCategoryAllowed(rejected, 'necessary')).toBe(true);
  });
});

describe('consent-core: banner visibility', () => {
  it('shows for default, hides after any explicit decision', () => {
    expect(shouldShowConsentBanner(defaultConsentState())).toBe(true);
    expect(shouldShowConsentBanner(acceptAll(defaultConsentState(), NOW))).toBe(false);
    expect(shouldShowConsentBanner(rejectNonEssential(defaultConsentState(), NOW))).toBe(false);
  });
});

describe('consent-core: analytics gate (mode-aware)', () => {
  const granted = withCustomConsent(defaultConsentState(), { analytics: true }, NOW);

  it('never fires in onprem even with consent', () => {
    expect(shouldFireAnalytics(granted, 'onprem')).toBe(false);
  });

  it('fires in cloud/tenant with consent', () => {
    expect(shouldFireAnalytics(granted, 'cloud')).toBe(true);
    expect(shouldFireAnalytics(granted, 'tenant')).toBe(true);
  });

  it('does not fire in cloud without consent', () => {
    expect(shouldFireAnalytics(defaultConsentState(), 'cloud')).toBe(false);
    expect(shouldFireAnalytics(rejectNonEssential(defaultConsentState(), NOW), 'cloud')).toBe(false);
  });
});

describe('consent-core: third-party script gate', () => {
  it('gates the GIS script on the preferences category', () => {
    expect(shouldLoadThirdPartyScript(defaultConsentState())).toBe(false);
    expect(shouldLoadThirdPartyScript(withCustomConsent(defaultConsentState(), { preferences: true }, NOW))).toBe(true);
  });
});
