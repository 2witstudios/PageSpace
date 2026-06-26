'use client';

import { create } from 'zustand';
import {
  CONSENT_COOKIE_NAME,
  parseConsentCookie,
  serializeConsentState,
  defaultConsentState,
  acceptAll as pureAcceptAll,
  rejectNonEssential as pureRejectNonEssential,
  withCustomConsent,
  shouldShowConsentBanner,
  type ConsentState,
  type ConsentCategory,
} from '@pagespace/lib/consent';
import { readCookieValue, buildConsentCookieString } from '@/lib/consent/cookie-utils';

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Event fired on the window whenever consent changes, so non-React listeners (the analytics tracker) can react. */
export const CONSENT_CHANGED_EVENT = 'ps:consent-changed';

function readConsentFromCookie(): ConsentState {
  if (typeof document === 'undefined') return defaultConsentState();
  return parseConsentCookie(readCookieValue(document.cookie, CONSENT_COOKIE_NAME));
}

function persistConsentToCookie(state: ConsentState): void {
  if (typeof document === 'undefined') return;
  // Scope the cookie to the registrable domain (same as the theme cookie) so consent is
  // shared across pagespace.ai subdomains / auth redirects instead of re-prompting per host.
  document.cookie = buildConsentCookieString(
    CONSENT_COOKIE_NAME,
    serializeConsentState(state),
    ONE_YEAR_SECONDS,
    process.env.NEXT_PUBLIC_COOKIE_DOMAIN,
  );
  window.dispatchEvent(new CustomEvent(CONSENT_CHANGED_EVENT, { detail: state }));
}

interface ConsentStore {
  state: ConsentState;
  /** Re-read from the cookie (call once on mount). */
  hydrate: () => void;
  acceptAll: () => void;
  rejectNonEssential: () => void;
  saveCustom: (choices: Partial<Record<Exclude<ConsentCategory, 'necessary'>, boolean>>) => void;
  /** Grant a single non-essential category while preserving the others. */
  grant: (category: Exclude<ConsentCategory, 'necessary'>) => void;
  showBanner: () => boolean;
}

export const useConsentStore = create<ConsentStore>((set, get) => ({
  // All decision logic lives in the pure @pagespace/lib/consent functions; the store
  // is a thin edge that reads/writes the cookie and notifies listeners.
  state: defaultConsentState(),

  hydrate: () => set({ state: readConsentFromCookie() }),

  acceptAll: () => {
    const next = pureAcceptAll(get().state, new Date().toISOString());
    persistConsentToCookie(next);
    set({ state: next });
  },

  rejectNonEssential: () => {
    const next = pureRejectNonEssential(get().state, new Date().toISOString());
    persistConsentToCookie(next);
    set({ state: next });
  },

  saveCustom: (choices) => {
    const next = withCustomConsent(get().state, choices, new Date().toISOString());
    persistConsentToCookie(next);
    set({ state: next });
  },

  grant: (category) => {
    const current = get().state.categories;
    const next = withCustomConsent(
      get().state,
      { analytics: current.analytics, preferences: current.preferences, [category]: true },
      new Date().toISOString(),
    );
    persistConsentToCookie(next);
    set({ state: next });
  },

  showBanner: () => shouldShowConsentBanner(get().state),
}));

/** Non-React accessor: current consent state straight from the cookie. */
export function getConsentStateFromCookie(): ConsentState {
  return readConsentFromCookie();
}
