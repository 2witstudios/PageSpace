/**
 * Pure consent core (GDPR / ePrivacy).
 *
 * Every consent/gating decision in PageSpace flows through these pure functions:
 * no I/O, no DB, no fs, no network, deterministic. The cookie store, the analytics
 * tracker, and the consent banner are thin imperative shells over this module.
 *
 * Client-safe: no Node.js dependencies — importable from React components.
 */

/** Non-essential consent categories the user can grant/deny, plus the always-on necessary one. */
export type ConsentCategory = 'necessary' | 'analytics' | 'preferences';

/** Deployment modes that influence gating (analytics is suppressed entirely on onprem). */
export type DeploymentMode = 'cloud' | 'tenant' | 'onprem';

export interface ConsentState {
  /** Schema version. A mismatch is treated as no-consent so the banner re-shows. */
  version: number;
  /** ISO timestamp of the user's decision, or null when no decision has been made yet. */
  decidedAt: string | null;
  categories: Record<ConsentCategory, boolean>;
}

/** Bump when the set of categories or their semantics change, to force re-consent. */
export const CONSENT_VERSION = 1;

/** Cookie name holding the serialized consent state. */
export const CONSENT_COOKIE_NAME = 'ps_consent';

/**
 * The category that gates third-party auth scripts (Google Identity Services / One Tap).
 * GIS sets cookies / does device fingerprinting, so it is non-essential until the user
 * indicates intent to use it.
 */
export const THIRD_PARTY_AUTH_CATEGORY: ConsentCategory = 'preferences';

/** Default state: only the necessary category is granted and no decision has been recorded. */
export function defaultConsentState(): ConsentState {
  return {
    version: CONSENT_VERSION,
    decidedAt: null,
    categories: { necessary: true, analytics: false, preferences: false },
  };
}

function isConsentCategoryRecord(value: unknown): value is Record<ConsentCategory, boolean> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.necessary === 'boolean' &&
    typeof v.analytics === 'boolean' &&
    typeof v.preferences === 'boolean'
  );
}

/**
 * Parse a raw consent cookie value. Returns the default (necessary-only, no-decision)
 * state for anything missing, malformed, or from an older schema version — which makes
 * the banner re-show and keeps non-essential categories off (fail closed).
 */
export function parseConsentCookie(raw: string | undefined | null): ConsentState {
  if (typeof raw !== 'string' || raw.trim() === '') return defaultConsentState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultConsentState();
  }

  if (typeof parsed !== 'object' || parsed === null) return defaultConsentState();
  const obj = parsed as Record<string, unknown>;

  if (obj.version !== CONSENT_VERSION) return defaultConsentState();
  if (!isConsentCategoryRecord(obj.categories)) return defaultConsentState();
  if (obj.decidedAt !== null && typeof obj.decidedAt !== 'string') return defaultConsentState();

  return {
    version: CONSENT_VERSION,
    decidedAt: (obj.decidedAt as string | null) ?? null,
    // Necessary is always granted regardless of what was stored.
    categories: {
      necessary: true,
      analytics: obj.categories.analytics === true,
      preferences: obj.categories.preferences === true,
    },
  };
}

/** Serialize a consent state for storage in the cookie. */
export function serializeConsentState(state: ConsentState): string {
  return JSON.stringify({
    version: CONSENT_VERSION,
    decidedAt: state.decidedAt,
    categories: {
      necessary: true,
      analytics: state.categories.analytics === true,
      preferences: state.categories.preferences === true,
    },
  });
}

/** The necessary category is always allowed; others only when explicitly granted. */
export function isCategoryAllowed(state: ConsentState, category: ConsentCategory): boolean {
  if (category === 'necessary') return true;
  return state.categories[category] === true;
}

/** The banner shows until the user has made an explicit decision. */
export function shouldShowConsentBanner(state: ConsentState): boolean {
  return state.decidedAt === null;
}

/**
 * Analytics fires only on cloud/tenant AND with analytics consent granted.
 * Onprem suppresses the tracker entirely (the consent surface is otherwise mode-agnostic).
 */
export function shouldFireAnalytics(state: ConsentState, mode: DeploymentMode): boolean {
  if (mode === 'onprem') return false;
  return isCategoryAllowed(state, 'analytics');
}

/** The Google Identity Services script may load only once its category is granted. */
export function shouldLoadThirdPartyScript(state: ConsentState): boolean {
  return isCategoryAllowed(state, THIRD_PARTY_AUTH_CATEGORY);
}

/** Record an accept-all decision at the given timestamp. */
export function acceptAll(state: ConsentState, nowIso: string): ConsentState {
  return {
    version: CONSENT_VERSION,
    decidedAt: nowIso,
    categories: { necessary: true, analytics: true, preferences: true },
  };
}

/** Record a reject-non-essential decision (only necessary stays on). */
export function rejectNonEssential(state: ConsentState, nowIso: string): ConsentState {
  return {
    version: CONSENT_VERSION,
    decidedAt: nowIso,
    categories: { necessary: true, analytics: false, preferences: false },
  };
}

/** Record a custom decision; unspecified non-essential categories default to off. */
export function withCustomConsent(
  state: ConsentState,
  choices: Partial<Record<Exclude<ConsentCategory, 'necessary'>, boolean>>,
  nowIso: string,
): ConsentState {
  return {
    version: CONSENT_VERSION,
    decidedAt: nowIso,
    categories: {
      necessary: true,
      analytics: choices.analytics === true,
      preferences: choices.preferences === true,
    },
  };
}
